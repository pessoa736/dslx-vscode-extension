#!/usr/bin/env lua
--- DSLX debug engine — implementa breakpoints/stepping/inspeção com debug lib.
--- MIT - Davi/Pessoa736 (2026)
---
--- protocolo (JSONL):
---   adapter -> engine (stdin):  {"cmd":"continue|stepInto|stepOver|stepOut|stack|scopes|variables", ...}
---   engine   -> adapter (stdout): {"event":"stopped"|"output"|"terminated", ...} e
---                                {"resp":"stack|scopes|variables", ...}
---
--- uso: lua debugger.lua <programa.lua> <breakpoints.json> [args...]

local program, bpfile = arg[1], arg[2]
if not program or not bpfile then
    io.stderr:write("uso: lua debugger.lua <programa.lua> <breakpoints.json> [args...]\n")
    os.exit(1)
end

local here = (debug.getinfo(1, "S").source:match("^@(.*)[/\\][^/\\]*$") or ".")
if here == "" then here = "." end

local dir = program:match("^(.*)[/\\][^/\\]*$") or "."
package.path = here .. "/?.lua;" .. here .. "/?/init.lua;"
    .. dir .. "/?.lua;" .. dir .. "/?/init.lua;"
    .. package.path

-- LPeg nativo ou LuLPeg (o programa pode requerer .dslx em runtime)
local ok_lpeg = pcall(require, "lpeg")
if not ok_lpeg then
    local lulpeg = require("lulpeg")
    if lulpeg.rebrand then lulpeg.rebrand() end
    package.loaded["lpeg"] = lulpeg
end

pcall(require, "dslx") -- instala o searcher de .dslx no require()

-- ============================================================
-- JSON mínimo
-- ============================================================

local function json_str(s)
    local out = {'"'}
    for i = 1, #s do
        local c = s:sub(i, i)
        local b = c:byte()
        if c == '"' then out[#out + 1] = '\\"'
        elseif c == "\\" then out[#out + 1] = "\\\\"
        elseif c == "\n" then out[#out + 1] = "\\n"
        elseif c == "\r" then out[#out + 1] = "\\r"
        elseif c == "\t" then out[#out + 1] = "\\t"
        elseif b < 32 then out[#out + 1] = string.format("\\u%04x", b)
        else out[#out + 1] = c end
    end
    out[#out + 1] = '"'
    return table.concat(out)
end

local function to_json(v)
    local t = type(v)
    if v == nil then return "null" end
    if t == "boolean" then return tostring(v) end
    if t == "number" then
        if v ~= v or v == math.huge or v == -math.huge then return "null" end
        return string.format("%.14g", v)
    end
    if t == "string" then return json_str(v) end
    if t ~= "table" then return json_str(tostring(v)) end

    local n = #v
    local has_hash = false
    for k in pairs(v) do
        if type(k) ~= "number" or k < 1 or k > n or k % 1 ~= 0 then has_hash = true end
    end
    if n == 0 and not has_hash then return "[]" end
    if not has_hash then
        local parts = {}
        for i = 1, n do parts[i] = to_json(v[i]) end
        return "[" .. table.concat(parts, ",") .. "]"
    end

    local parts = {}
    for k, val in pairs(v) do
        local key = (type(k) == "string") and k or tostring(k)
        parts[#parts + 1] = json_str(key) .. ":" .. to_json(val)
    end
    return "{" .. table.concat(parts, ",") .. "}"
end

--- decoder JSON (objetos, arrays, strings, números, bool, null)
local function from_json(s)
    local pos = 1

    local function skip() while pos <= #s and s:find("^[%s]", pos) do pos = pos + 1 end end

    local function utf8(cp)
        if cp < 0x80 then return string.char(cp) end
        local bytes = {}
        local len = cp < 0x800 and 2 or (cp < 0x10000 and 3 or 4)
        local mask = { 0xFF, 0x1F, 0x0F, 0x07 }
        local shift = { 0, 6, 12, 18 }
        bytes[1] = string.char(0x80 + ((2 ^ (len - 1) - 1) * 2 ^ (8 - len)) + math.floor(cp / 2 ^ shift[len] % mask[len] * 2 ^ shift[len] / 2 ^ shift[len]))
        -- fallback simples: usa utf8.char se existir (Lua 5.4+ não tem; 5.5 talvez)
        return string.char(cp % 256)
    end

    local decode_value

    local function decode_string()
        pos = pos + 1 -- pula "
        local out = {}
        while pos <= #s do
            local c = s:sub(pos, pos)
            if c == '"' then pos = pos + 1 return table.concat(out) end
            if c == "\\" then
                local e = s:sub(pos + 1, pos + 1)
                if e == "n" then out[#out + 1] = "\n"
                elseif e == "t" then out[#out + 1] = "\t"
                elseif e == "r" then out[#out + 1] = "\r"
                elseif e == "b" then out[#out + 1] = "\b"
                elseif e == "f" then out[#out + 1] = "\f"
                elseif e == "u" then
                    local hex = tonumber(s:sub(pos + 2, pos + 5), 16)
                    if hex then
                        if hex >= 0x800 then
                            -- UTF-8 de 2-3 bytes
                            local b = {}
                            if hex < 0x10000 and hex >= 0x800 then
                                local c2 = 128 + (hex % 64)
                                if hex < 0x800 then
                                    b[1] = 192 + math.floor(hex / 64)
                                else
                                    b[1] = 224 + math.floor(hex / 4096)
                                    b[2] = 128 + (math.floor(hex / 64) % 64)
                                end
                                b[#b + 1] = c2
                            end
                            out[#out + 1] = string.char(table.unpack(b))
                        else
                            out[#out + 1] = string.char(hex)
                        end
                    end
                    pos = pos + 6
                else
                    out[#out + 1] = e
                    pos = pos + 2
                end
            else
                if pos <= #s then out[#out + 1] = c end
            end
            pos = pos + 1
        end
        error("string JSON sem fechamento")
    end

    function decode_value()
        skip()
        local c = s:sub(pos, pos)
        if c == "{" then
            pos = pos + 1
            local obj = {}
            skip()
            if s:sub(pos, pos) == "}" then pos = pos + 1 return obj end
            while true do
                skip()
                local key = decode_string()
                skip()
                pos = pos + 1 -- :
                obj[key] = decode_value()
                skip()
                local d = s:sub(pos, pos)
                pos = pos + 1
                if d == "}" then return obj end
            end
        elseif c == "[" then
            pos = pos + 1
            local arr = {}
            skip()
            if s:sub(pos, pos) == "]" then pos = pos + 1 return arr end
            while true do
                arr[#arr + 1] = decode_value()
                skip()
                local d = s:sub(pos, pos)
                pos = pos + 1
                if d == "]" then return arr end
            end
        elseif c == '"' then
            return decode_string()
        elseif s:find("^true", pos) then
            pos = pos + 4 return true
        elseif s:find("^false", pos) then
            pos = pos + 5 return false
        elseif s:find("^null", pos) then
            pos = pos + 4 return nil
        else
            local num = s:match("^-?%d+%.?%d*[eE]?[+-]?%d*", pos)
            if not num then error("JSON inválido em " .. pos) end
            pos = pos + #num
            return tonumber(num) or tonumber(num:match("^-?%d+%.?%d*"))
        end
    end

    return decode_value()
end

-- ============================================================
-- engine
-- ============================================================

local function emit(obj)
    io.stdout:write(to_json(obj), "\n")
    io.stdout:flush()
end

-- saída do programa capturada e repassada como evento output
local real_print = print
function print(...)
    local parts = {}
    for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end
    emit { event = "output", category = "stdout", text = table.concat(parts, "\t") .. "\n" }
end

local real_iowrite = io.write
io.write = function(...)
    local parts = {}
    for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end
    emit { event = "output", category = "stdout", text = table.concat(parts) }
end

local function norm(p)
    p = tostring(p):gsub("\\", "/")
    return p:lower()
end

local engine_path = norm(debug.getinfo(1, "S").source:match("^@(.*)$") or "")

--- fontes internas da engine/vendadas não param o debugger
local function blocked_source(src)
    local p = norm(src:sub(2))
    if p == engine_path then return true end
    if p:sub(1, #norm(here) + 1) == norm(here) .. "/" then
        -- qualquer módulo do runtime/ da extensão
        return true
    end
    return false
end

-- breakpoints: re-lidos a cada parada (permite atualização em vivo)
local breakpoints = {}
local stop_on_entry = false

local function load_breakpoints()
    breakpoints = {}
    local f = io.open(bpfile, "r")
    if not f then return end
    local data = f:read("a")
    f:close()
    local ok, cfg = pcall(from_json, data)
    if not ok or type(cfg) ~= "table" then return end
    stop_on_entry = cfg.stopOnEntry == true
    for _, bp in ipairs(cfg.breakpoints or {}) do
        if bp.file and bp.line then
            breakpoints[norm(bp.file) .. ":" .. bp.line] = true
        end
    end
end

-- registro de tabelas pra inspeção por referência
local registry, next_ref = {}, 1
local function ref_of(v)
    if type(v) ~= "table" then return 0 end
    for r, t in pairs(registry) do
        if t == v then return r end
    end
    registry[next_ref] = v
    next_ref = next_ref + 1
    return next_ref - 1
end

local function format_value(v)
    local t = type(v)
    if t == "nil" then return "nil", "nil" end
    if t == "boolean" then return tostring(v), t end
    if t == "number" then return string.format("%.14g", v), t end
    if t == "string" then return string.format("%q", v), t end
    if t == "function" then return "função: " .. tostring(v), t end
    if t == "table" then
        local n = 0
        for _ in pairs(v) do n = n + 1 end
        return "{…} (" .. n .. " itens)", t
    end
    return tostring(v), t
end

local function stack_depth(base)
    local d = 0
    while true do
        local info = debug.getinfo(base + d, "f")
        if not info then return d end
        d = d + 1
    end
end

--- base dinâmica: nível 1 = hook; níveis seguintes com fonte interna são
--- frames da própria engine (varia com a versão do Lua). o programa começa
--- na primeira frame cujo fonte não é o debugger.
local function find_program_base()
    local level = 2
    while true do
        local info = debug.getinfo(level, "S")
        if not info then return level end
        local src = info.source or ""
        if src:sub(1, 1) ~= "@" or norm(src:sub(2)) ~= engine_path then
            return level
        end
        level = level + 1
    end
end

local function build_stack(base)
    local frames = {}
    local i = 0
    while true do
        local info = debug.getinfo(base + i, "nSl")
        if not info then break end
        local src = info.source or "?"
        frames[#frames + 1] = {
            id = i,
            name = info.name or "(principal)",
            file = src:sub(1, 1) == "@" and src:sub(2) or src,
            line = info.currentline or 0,
        }
        i = i + 1
    end
    return frames
end

local function build_scopes(base, frame)
    local level = base + frame
    local info = debug.getinfo(level, "f")
    if not info then return {} end

    registry, next_ref = {}, 1

    -- locais
    local locals = {}
    local i = 1
    while true do
        local name, value = debug.getlocal(level, i)
        if not name then break end
        if not name:find("^%(") then
            local text, t = format_value(value)
            locals[#locals + 1] = {
                name = name, type = t, value = text,
                variablesReference = ref_of(value),
            }
        end
        i = i + 1
    end

    -- upvalues
    local upvals = {}
    if info.func then
        local j = 1
        while true do
            local name, value = debug.getupvalue(info.func, j)
            if not name then break end
            local text, t = format_value(value)
            upvals[#upvals + 1] = {
                name = name, type = t, value = text,
                variablesReference = ref_of(value),
            }
            j = j + 1
        end
    end

    -- globais (pseudovariável que expande pro _G)
    registry[next_ref] = _G
    local gref = next_ref
    next_ref = next_ref + 1

    return {
        { name = "Locais",   kind = "locals",   variables = locals, variablesReference = -1 },
        { name = "Upvalues", kind = "upvalues", variables = upvals, variablesReference = -2 },
        { name = "Globais",  kind = "globals",  variables = {},    variablesReference = gref },
    }
end

local function build_variables(ref)
    local t = registry[ref]
    if t == nil then return {} end

    if t == _G then
        local out = {}
        local keys = {}
        for k in pairs(_G) do keys[#keys + 1] = k end
        table.sort(keys)
        for _, k in ipairs(keys) do
            local v = rawget(_G, k)
            local text, ty = format_value(v)
            out[#out + 1] = {
                name = tostring(k), type = ty, value = text,
                variablesReference = ref_of(v),
            }
        end
        return out
    end

    if type(t) ~= "table" then return {} end
    local out = {}
    local n = 0
    for k, v in pairs(t) do
        n = n + 1
        if n > 200 then break end
        local text, ty = format_value(v)
        out[#out + 1] = {
            name = tostring(k), type = ty, value = text,
            variablesReference = ref_of(v),
        }
    end
    return out
end

-- estado de stepping
local stepping = false
local step_mode = "into" -- "into" | "over" | "out"
local step_target = 0
local first_stop = true
local stopped_base = 3 -- recalculada a cada parada/consumo (find_program_base)

--- avaliação de expressão no contexto da frame.
--- níveis de debug são RELATIVOS ao ponto de chamada: coletar locals aqui na
--- própria frame de do_evaluate dá a mesma régua de build_scopes
--- (1=do_evaluate, 2=stopped, 3=hook, 4+=programa). o pcall só envolve a
--- avaliação — dentro dele a régua muda, então nada de nível lá.
local function do_evaluate(frame, expr)
    if type(expr) ~= "string" or expr == "" then
        return nil, "expressão vazia"
    end
    local level = stopped_base + frame

    -- coleta locals na própria frame (régua idêntica a build_scopes)
    local info = debug.getinfo(level, "f")
    if not info then return nil, "frame inválida" end
    local names, values = {}, {}
    local i = 1
    while true do
        local name, value = debug.getlocal(level, i)
        if not name then break end
        if not name:find("^%(") then
            names[#names + 1] = name
            values[#values + 1] = value
        end
        i = i + 1
    end

    -- expressão vira função com parâmetros = locals da frame
    local params = table.concat(names, ", ")
    local f, lerr = load("return function(" .. params .. ")\nreturn " .. expr .. "\nend", "=watch", "t")
    if not f then return nil, "sintaxe inválida: " .. tostring(lerr) end
    local outer = f()

    -- _ENV da watch function aponta pro _G do programa
    local j = 1
    while true do
        local un = debug.getupvalue(outer, j)
        if not un then break end
        if un == "_ENV" then debug.setupvalue(outer, j, _G) end
        j = j + 1
    end

    local ok, res = pcall(outer, table.unpack(values))
    if ok then return res end
    return nil, tostring(res):gsub("^.-:%d+: ", "")
end

--- loop de comandos enquanto parado; base = nível da frame mais externa do programa
--- calcula a base AQUI (mesma profundidade de onde build_* vão consumir):
--- 1 = find_program_base, 2 = stopped, 3 = hook, 4+ = programa
local function stopped(path, line, reason)
    load_breakpoints() -- pega breakpoints atualizados
    if first_stop and stop_on_entry then reason = "entry" end
    first_stop = false
    emit { event = "stopped", file = path, line = line, reason = reason }

    while true do
        local l = io.stdin:read("l")
        if not l then os.exit(0) end -- adapter sumeceu
        local ok, cmd = pcall(from_json, l)
        if ok and type(cmd) == "table" then
            -- base recalculada NO momento do consumo: a cadeia de chamadas
            -- muda (handler do comando é um nível acima de find_program_base),
            -- então medir de um lugar fixo dá frame errada
            stopped_base = find_program_base()
            local c = cmd.cmd
            if c == "continue" then
                stepping = false
                emit { resp = "ok", cmd = "continue" }
                return
            elseif c == "stepInto" then
                stepping, step_mode = true, "into"
                emit { resp = "ok", cmd = "stepInto" }
                return
            elseif c == "stepOver" then
                stepping, step_mode, step_target = true, "over", stack_depth(stopped_base)
                emit { resp = "ok", cmd = "stepOver" }
                return
            elseif c == "stepOut" then
                stepping, step_mode, step_target = true, "out", stack_depth(stopped_base)
                emit { resp = "ok", cmd = "stepOut" }
                return
            elseif c == "stack" then
                emit { resp = "stack", frames = build_stack(stopped_base) }
            elseif c == "scopes" then
                emit { resp = "scopes", frame = cmd.frame, scopes = build_scopes(stopped_base, cmd.frame or 0) }
            elseif c == "variables" then
                emit { resp = "variables", ref = cmd.ref, variables = build_variables(cmd.ref) }
            elseif c == "evaluate" then
                -- avalia expressão no contexto da frame (locals + upvalues visíveis)
                local frame = cmd.frame or 0
                local expr = cmd.expression
                local result, err = do_evaluate(frame, expr)
                emit { resp = "evaluate", result = select(1, format_value(result)), type = type(result), ref = ref_of(result), err = err }
            end
        end
    end
end

debug.sethook(function(event)
    if event ~= "line" then return end

    local info = debug.getinfo(2, "Sl")
    local src = info.source or ""
    if src:sub(1, 1) ~= "@" then return end
    if blocked_source(src) then return end

    local path = norm(src:sub(2))
    local line = info.currentline
    local stop_reason = nil

    if breakpoints[path .. ":" .. line] then stop_reason = "breakpoint" end

    if not stop_reason and stepping then
        -- nível 3 = a frame que tava executando (1=stack_depth, 2=hook), mesma
        -- régua usada pro step_target (contagem a partir da frame do programa)
        local depth = stack_depth(3)
        if step_mode == "into" then
            stop_reason = "step"
        elseif step_mode == "over" then
            if depth <= step_target then stop_reason = "step" end
        elseif step_mode == "out" then
            if depth < step_target then stop_reason = "step" end
        end
    end

    if stop_reason then
        stopped(path, line, stop_reason)
    end
end, "l")

-- argumentos pro programa
local args = {}
for i = 3, #arg do args[#args + 1] = arg[i] end
arg = { [0] = program, table.unpack(args) }

load_breakpoints()
if stop_on_entry then
    stepping, step_mode = true, "into"
end

local chunk, lerr = loadfile(program)
if not chunk then
    emit { event = "output", category = "stderr", text = "ERRO: " .. tostring(lerr) .. "\n" }
    emit { event = "terminated" }
    os.exit(1)
end

local ok, res = pcall(chunk, table.unpack(args))
debug.sethook()

if not ok then
    emit { event = "output", category = "stderr", text = "ERRO em runtime: " .. tostring(res) .. "\n" }
end

emit { event = "terminated" }
