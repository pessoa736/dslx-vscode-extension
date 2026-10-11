#!/usr/bin/env lua
--- DSLX runner/compile CLI — ponte entre a extensão VS Code e o runtime dslx.
--- MIT - Davi/Pessoa736 (2026)
---
--- uso:
---   lua dslx_runner.lua compile <arquivo.dslx> [outdir]
---   lua dslx_runner.lua run     <arquivo.dslx> [args pro script...]
---   lua dslx_runner.lua check   <arquivo.dslx>   -> JSON de diagnóstico no stdout
---   lua dslx_runner.lua env                       -> JSON do ambiente no stdout

local here = (debug.getinfo(1, "S").source:match("^@(.*)[/\\][^/\\]*$") or ".")
if here == "" then here = "." end

local mode, file = arg[1], arg[2]
if not mode or (mode ~= "compile" and mode ~= "run" and mode ~= "check" and mode ~= "env") then
    io.stderr:write("uso: lua dslx_runner.lua compile <arquivo.dslx> [outdir]\n")
    io.stderr:write("     lua dslx_runner.lua run <arquivo.dslx> [args...]\n")
    io.stderr:write("     lua dslx_runner.lua check <arquivo.dslx>\n")
    io.stderr:write("     lua dslx_runner.lua env\n")
    os.exit(1)
end

if mode ~= "env" and not file then
    io.stderr:write("faltou o arquivo\n")
    os.exit(1)
end

-- diretório do arquivo alvo no path, pra requires relativos ao script funcionarem
local dir = (mode == "env") and "." or (file:match("^(.*)[/\\][^/\\]*$") or ".")
package.path = here .. "/?.lua;" .. here .. "/?/init.lua;"
    .. dir .. "/?.lua;" .. dir .. "/?/init.lua;"
    .. package.path

--- LPeg: usa o nativo se existir; senão o LuLPeg embutido (LPeg em Lua puro)
local ok_lpeg = pcall(require, "lpeg")
local lpeg_kind, lpeg_ver = "nativo", nil
if not ok_lpeg then
    local lulpeg = require("lulpeg")
    if lulpeg.rebrand then lulpeg.rebrand() end
    package.loaded["lpeg"] = lulpeg
    lpeg_kind = "lulpeg"
    lpeg_ver = tostring(lulpeg.version and lulpeg.version())
end

local dslx = require("dslx")

-- ============================================================
-- JSON mínimo (encoder) pro output estruturado
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

    -- array? (chaves 1..n sem parte hash)
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

-- ============================================================
-- helpers
-- ============================================================

--- alinha linhas do código gerado nas linhas do fonte (regiões lua são verbatim)
local function align_lines(src, gen)
    local src_lines = {}
    for l in (src .. "\n"):gmatch("([^\n]*)\n") do
        src_lines[#src_lines + 1] = l:gsub("\r$", "")
    end
    local map, p = {}, 1
    local g = 0
    for raw in (gen .. "\n"):gmatch("([^\n]*)\n") do
        g = g + 1
        local gl = raw:gsub("\r$", "")
        while p <= #src_lines and src_lines[p] ~= gl do p = p + 1 end
        if p <= #src_lines then
            map[g] = p
            p = p + 1
        end
    end
    return map
end

-- ============================================================
-- modo: env — ambiente Lua/DSLX em JSON
-- ============================================================

if mode == "env" then
    local env_keys = { "LUA_PATH", "LUA_CPATH", "LUA_INIT", "PATH", "DSLX_PATH", "HOME" }
    local env = {}
    for _, k in ipairs(env_keys) do
        env[k] = os.getenv(k)
    end

    io.write(to_json({
        lua          = _VERSION,
        lpeg         = lpeg_kind,
        lpeg_version = lpeg_ver,
        program      = arg[0],
        package_path = package.path,
        package_cpath = package.cpath,
        import_path  = dslx.import.path,
        import_use_cache = dslx.import.use_cache,
        has_is_element = type(_G.is_element) == "function",
        dirsep = package.config:sub(1, 1),
        env = env,
    }), "\n")
    os.exit(0)
end

-- ============================================================
-- modo: check — diagnóstico de erros em JSON
-- ============================================================

if mode == "check" then
    local readFile = require("dslx.readFile")
    local rt = require("dslx.runtime")

    local src, err = readFile(file)
    if not src then
        io.write(to_json({ ok = false, kind = "io", message = tostring(err) }), "\n")
        os.exit(0)
    end

    local nodes = dslx.parser(src)

    if #nodes > 0 or src:match("^%s*$") then
        -- parse ok: tenta compilar e carregar o Lua gerado
        local okc, code = pcall(rt.make_new_code, rt, nodes)
        if not okc then
            io.write(to_json({ ok = false, kind = "compile", message = tostring(code), line = 1, column = 1 }), "\n")
            os.exit(0)
        end

        local f, lerr = load(code, "=" .. file, "t")
        if not f then
            -- Lua 5.4: "=file:12: msg"; Lua 5.5: "file:12: msg"
            local lnum, msg = lerr:match("=?[^:]*%[:(%d+):%s*(.*)")
            lnum = tonumber(lnum)
            if not lnum then lnum, msg = lerr:match("[^:]+:(%d+):%s*(.*)") end
            lnum = tonumber(lnum) or 1
            local dline, mapped = lnum, false
            if lnum then
                local map = align_lines(src, code)
                if map[lnum] then dline, mapped = map[lnum], true end
            end
            io.write(to_json({
                ok = false, kind = "compile",
                message = "Lua inválido no código gerado: " .. tostring(msg or lerr),
                line = dline or 1, column = 1, lua_line = lnum, mapped = mapped,
            }), "\n")
            os.exit(0)
        end

        io.write(to_json({ ok = true, nodes = #nodes }), "\n")
        os.exit(0)
    end

    -- parse falhou: o parser devolve {} sem posição. Varredura por limite de
    -- linha: o último prefixo (até linha N) que parseia marca onde o erro começa.
    local lines = {}
    for l in (src .. "\n"):gmatch("([^\n]*)\n") do lines[#lines + 1] = l end

    local last_ok, acc = 0, ""
    local cap = math.min(#lines, 2000)
    for i = 1, cap do
        acc = acc .. lines[i] .. "\n"
        local nn = dslx.parser(acc)
        if #nn > 0 or acc:match("^%s*$") then last_ok = i end
    end

    local err_line = math.min(last_ok + 1, #lines)
    local column = #(lines[err_line]:match("^%s*")) + 1

    io.write(to_json({
        ok = false, kind = "parse",
        message = "sintaxe DSLX inválida próximo desta linha — cheque tags abertas/fechadas, barras de self-close e blocos { } balanceados",
        line = err_line, column = column, last_valid_line = last_ok,
    }), "\n")
    os.exit(0)
end

-- ============================================================
-- modo: compile
-- ============================================================

if mode == "compile" then
    local outdir = arg[3] or dir
    local stem = file:match("([^/\\]+)%.[^./\\]*$") or file:match("([^/\\]+)$")

    local ok, cerr = pcall(dslx.compile, {
        input = file,
        asfile = true,
        tofile = true,
        run = false,
        output_name = stem,
        output_ext = ".lua",
        output_dir = outdir,
    })

    if not ok then
        io.stderr:write("ERRO: ", tostring(cerr), "\n")
        os.exit(1)
    end

    print("OK " .. outdir .. "/" .. stem .. ".lua")
    os.exit(0)
end

-- ============================================================
-- modo: run
-- ============================================================

local chunk, rerr = dslx.import.loadfile(file)
if not chunk then
    io.stderr:write("ERRO: ", tostring(rerr), "\n")
    os.exit(1)
end

-- args extras do script, estilo `lua script.lua args...`
local args = {}
for i = 3, #arg do args[#args + 1] = arg[i] end
arg = { [0] = file, table.unpack(args) }

chunk(table.unpack(args))
