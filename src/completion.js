/**
 * DSLX completion engine — scanner de símbolos + sugestões contextuais.
 * MIT - Davi/Pessoa736 (2026)
 *
 * Puro (sem API do VS Code): computeSuggestions(text, line, character) devolve
 * sugestões {label, kind, detail, insert, snippet, sortText} que o
 * extension.js converte em CompletionItems. Os contextos:
 *
 *   <tag|           → sugere componentes/elementos (funções definidas + tags usadas)
 *   <tag prop|       → sugere props vistas dessa tag em outros usos do arquivo
 *   <tag p={ex|}     → expressão Lua: variáveis, funções, globais, keywords
 *   {ex|}            → idem (children de expressão)
 *   el.|             → members do elemento (name, props, childrens)
 *   el.props.|       → chaves de props vistas em tags do arquivo
 *   string.|table.|  → membros das bibliotecas padrão do Lua
 *   resto            → variáveis locais, funções, keywords, globais Lua/DSLX
 */

'use strict';

// ---------- dicionários Lua ----------

const LUA_KEYWORDS = [
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
    'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return',
    'then', 'true', 'until', 'while',
];

const LUA_GLOBALS = [
    ['_G', 'tabela de globais'], ['_VERSION', 'versão do Lua'],
    ['assert', 'assert(v [, message])'], ['collectgarbage', 'collectgarbage([opt [, arg]])'],
    ['dofile', 'dofile([filename])'], ['error', 'error(message [, level])'],
    ['getmetatable', 'getmetatable(object)'], ['ipairs', 'ipairs(t) — itera 1..n'],
    ['load', 'load(chunk [, chunkname [, mode [, env]]])'],
    ['loadfile', 'loadfile([filename [, mode [, env]]])'],
    ['next', 'next(table [, index])'], ['pairs', 'pairs(t) — itera todas as chaves'],
    ['pcall', 'pcall(f [, arg1, ...])'], ['print', 'print(...)'],
    ['rawequal', 'rawequal(v1, v2)'], ['rawget', 'rawget(table, index)'],
    ['rawlen', 'rawlen(v)'], ['rawset', 'rawset(table, index, value)'],
    ['require', 'require(modname)'], ['select', 'select(index, ...)'],
    ['setmetatable', 'setmetatable(table, metatable)'], ['tonumber', 'tonumber(e [, base])'],
    ['tostring', 'tostring(v)'], ['type', 'type(v)'],
    ['warn', 'warn(message, ...)'], ['xpcall', 'xpcall(f, err [, arg1, ...])'],
    ['is_element', 'is_element(f) — global do DSLX: valida função como elemento'],
];

const LUA_MODULES = {
    string: ['byte', 'char', 'find', 'format', 'gmatch', 'gsub', 'len', 'lower',
        'match', 'pack', 'packsize', 'rep', 'reverse', 'sub', 'unpack', 'upper'],
    table: ['concat', 'insert', 'move', 'pack', 'remove', 'sort', 'unpack'],
    math: ['abs', 'ceil', 'floor', 'fmod', 'huge', 'log', 'max', 'min', 'modf',
        'pi', 'random', 'randomseed', 'sin', 'cos', 'tan', 'sqrt', 'tointeger', 'type'],
    io: ['close', 'flush', 'input', 'lines', 'open', 'output', 'popen', 'read',
        'stderr', 'stdin', 'stdout', 'tmpfile', 'write'],
    os: ['clock', 'date', 'difftime', 'execute', 'exit', 'getenv', 'remove',
        'rename', 'setlocale', 'time', 'tmpname'],
    coroutine: ['close', 'create', 'isyieldable', 'resume', 'running', 'status',
        'wrap', 'yield'],
    debug: ['gethook', 'getinfo', 'getlocal', 'getupvalue', 'sethook', 'setlocal',
        'setupvalue', 'traceback', 'getmetatable', 'setmetatable'],
    package: ['config', 'cpath', 'loaded', 'path', 'preload', 'searchers', 'searchpath'],
    utf8: ['char', 'charpattern', 'codepoint', 'codes', 'len', 'offset'],
};

// snippets rápidos (kind 'snippet'); label = atalho
const LUA_SNIPPETS = [
    { label: 'fori', detail: 'for _, v in ipairs(t)', insert: 'for ${1:_}, ${2:v} in ipairs(${3:t}) do\n\t$0\nend' },
    { label: 'forp', detail: 'for k, v in pairs(t)', insert: 'for ${1:k}, ${2:v} in pairs(${3:t}) do\n\t$0\nend' },
    { label: 'fun', detail: 'function f() ... end', insert: 'function ${1:f}(${2})\n\t$0\nend' },
    { label: 'locfun', detail: 'local function f() ... end', insert: 'local function ${1:f}(${2})\n\t$0\nend' },
    { label: 'ifel', detail: 'if ... else ... end', insert: 'if ${1:cond} then\n\t$2\nelse\n\t$0\nend' },
    { label: 'pcall', detail: 'pcall(function() ... end)', insert: 'pcall(function()\n\t$0\nend)' },
];

// ---------- utilidades ----------

const lineOf = (text, index) => text.slice(0, index).split('\n').length - 1;

/** remove comentários preservando newlines/offsets (strings ficam) */
function stripComments(text) {
    const out = text.split('');
    const n = text.length;
    let i = 0;
    while (i < n) {
        // --[[ ]] / --[=*[ ]
        const bm = /^--\[(=*)\[/.exec(text.slice(i, i + 16));
        if (text.startsWith('--[', i) && bm) {
            const close = ']' + bm[1] + ']';
            const end = text.indexOf(close, i + bm[0].length);
            const stop = end === -1 ? n : end + close.length;
            for (let k = i; k < stop; k++) if (out[k] !== '\n') out[k] = ' ';
            i = stop;
            continue;
        }
        if (text.startsWith('--', i)) {
            let end = text.indexOf('\n', i);
            if (end === -1) end = n;
            for (let k = i; k < end; k++) out[k] = ' ';
            i = end;
            continue;
        }
        // pula strings (não trata conteúdo como código)
        const c = text[i];
        if (c === '"' || c === "'") {
            i++;
            while (i < n && text[i] !== c) { if (text[i] === '\\') i++; i++; }
            i++;
            continue;
        }
        i++;
    }
    return out.join('');
}

/** varre o documento e devolve os símbolos: funções, variáveis, tags e props */
function scanSymbols(text) {
    const code = stripComments(text);
    const syms = {
        funcs: [],   // {name, params, line, local}
        vars: [],    // {name, line, kind:'local'|'global'|'param'}
        tags: {},    // name -> Map(prop -> 'string'|'block'|'bool')
        tagUses: [], // {name, line}
        propTypes: {}, // prop -> 'string'|'block'|'bool' (todas as tags)
    };

    // funções (local function, function, local f = function)
    // lookbehind (?<![\w.]): m.index aponta no início do "local"/"function"
    // (o prefixo não é consumido — senão a linha sai desalinhada e o dedup falha)
    let m;
    const reLocalFun = /(?<![\w.])local\s+function\s+([A-Za-z_][\w.]*)\s*\(([^)]*)\)/gm;
    while ((m = reLocalFun.exec(code))) {
        syms.funcs.push({
            name: m[1], local: true, line: lineOf(code, m.index),
            params: m[2].split(',').map((s) => s.trim()).filter(Boolean),
        });
    }
    const reFun = /(?<![\w.])function\s+([A-Za-z_][\w.]*)\s*\(([^)]*)\)/gm;
    while ((m = reFun.exec(code))) {
        if (!syms.funcs.some((f) => f.name === m[1] && f.line === lineOf(code, m.index))) {
            syms.funcs.push({
                name: m[1], local: false, line: lineOf(code, m.index),
                params: m[2].split(',').map((s) => s.trim()).filter(Boolean),
            });
        }
    }
    const reLocalArrow = /(?<![\w.])local\s+([A-Za-z_]\w*)\s*(?:<[a-z]+>\s*)?=\s*function\s*\(([^)]*)\)/gm;
    while ((m = reLocalArrow.exec(code))) {
        syms.funcs.push({
            name: m[1], local: true, line: lineOf(code, m.index),
            params: m[2].split(',').map((s) => s.trim()).filter(Boolean),
        });
    }

    // variáveis locais (uma ou mais por declaração, com/sem valor)
    const reLocal = /(?<![\w.])local\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:<[a-z]+>\s*)?(?==|$|\n|,)/gm;
    while ((m = reLocal.exec(code))) {
        for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
            if (!syms.vars.some((v) => v.name === name)) {
                syms.vars.push({ name, line: lineOf(code, m.index), kind: 'local' });
            }
        }
    }
    // parâmetros viram "variáveis" do escopo da função
    for (const f of syms.funcs) {
        for (const p of f.params) {
            if (p && !syms.vars.some((v) => v.name === p)) {
                syms.vars.push({ name: p, line: f.line, kind: 'param', of: f.name });
            }
        }
    }
    // globais por atribuição (começo de linha, = sem ==)
    const reGlobal = /^[ \t]*([A-Za-z_]\w*)\s*(?:<[a-z]+>\s*)?=(?!=)/gm;
    while ((m = reGlobal.exec(code))) {
        if (!syms.vars.some((v) => v.name === m[1])) {
            syms.vars.push({ name: m[1], line: lineOf(code, m.index), kind: 'global' });
        }
    }

    // tags usadas + props (no texto original — strings de props contam)
    const reTag = /<([A-Za-z_][\w.-]*)([^>]*?)(\/>|>)/g;
    while ((m = reTag.exec(text))) {
        const name = m[1];
        syms.tagUses.push({ name, line: lineOf(text, m.index) });
        if (!syms.tags[name]) syms.tags[name] = new Map();
        const attrs = m[2];
        // prop="valor" | prop={'expr'} | prop={expr}
        const reAttr = /([A-Za-z_][\w.-]*)\s*=\s*("([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
        let a;
        while ((a = reAttr.exec(attrs))) {
            const type = a[3] !== undefined || a[4] !== undefined ? 'string' : 'block';
            syms.tags[name].set(a[1], type);
            syms.propTypes[a[1]] = type;
        }
        // props booleanas: tokens soltos sem =
        const rest = attrs.replace(reAttr, ' ');
        for (const tok of rest.split(/\s+/)) {
            if (/^[A-Za-z_][\w.-]*$/.test(tok)) {
                syms.tags[name].set(tok, 'bool');
                if (!syms.propTypes[tok]) syms.propTypes[tok] = 'bool';
            }
        }
    }
    return syms;
}

// ---------- sugestões por contexto ----------

function sug(label, kind, detail, insert, snippet, sort) {
    return { label, kind, detail, insert: insert || label, snippet: !!snippet, sortText: sort + label };
}

/** sugestões de tags/elementos: funções + tags já usadas */
function tagSuggestions(syms) {
    const seen = new Set();
    const out = [];
    for (const f of syms.funcs) {
        if (f.name.includes('.')) continue;
        if (seen.has(f.name)) continue;
        seen.add(f.name);
        out.push(sug(f.name, 'tag',
            `elemento/componente — função ${f.local ? 'local ' : ''}${f.name}(${f.params.join(', ')}) linha ${f.line + 1}`,
            `${f.name} $1>$0</${f.name}>`, true, '0'));
    }
    for (const u of syms.tagUses) {
        if (!seen.has(u.name)) {
            seen.add(u.name);
            out.push(sug(u.name, 'tag', `tag usada no arquivo (linha ${u.line + 1})`,
                `${u.name} $1>$0</${u.name}>`, true, '0'));
        }
    }
    return out;
}

/** sugestões de props da tag, dos usos anteriores */
function propSuggestions(syms, tag) {
    const out = [];
    const props = syms.tags[tag];
    if (props) {
        for (const [name, type] of props) {
            const insert = type === 'string' ? `${name}="$1"`
                : type === 'block' ? `${name}={$1}` : name;
            out.push(sug(name, 'prop', `prop ${type} de <${tag}>`, insert, type !== 'bool', '1'));
        }
    }
    return out;
}

/** expressão Lua: vars, funções, globais, keywords, snippets */
function exprSuggestions(syms) {
    const out = [];
    for (const v of syms.vars) {
        out.push(sug(v.name, 'var', `${v.kind === 'param' ? 'parâmetro' : v.kind === 'global' ? 'global' : 'local'} — linha ${v.line + 1}`, v.name, false, '0'));
    }
    for (const f of syms.funcs) {
        out.push(sug(f.name, 'func', `${f.local ? 'local ' : ''}função ${f.name}(${f.params.join(', ')}) — linha ${f.line + 1}`, f.name, false, '0'));
    }
    for (const [g, detail] of LUA_GLOBALS) out.push(sug(g, 'global', detail, g, false, '2'));
    for (const k of LUA_KEYWORDS) out.push(sug(k, 'keyword', 'keyword Lua', k, false, '3'));
    for (const s of LUA_SNIPPETS) out.push(sug(s.label, 'snippet', s.detail, s.insert, true, '4'));
    return out;
}

/** members após ponto: el.* | el.props.* | lib.* */
function memberSuggestions(syms, base) {
    const out = [];
    // elemento DSLX: qualquer param de função de 1 argumento serve como elemento
    const isElementVar = syms.vars.some((v) => v.kind === 'param' && v.name === base);
    if (isElementVar) {
        out.push(sug('name', 'member', 'element.name — nome da tag', 'name', false, '0'));
        out.push(sug('props', 'member', 'element.props — tabela de props', 'props', false, '0'));
        out.push(sug('childrens', 'member', 'element.childrens — children do elemento', 'childrens', false, '0'));
        return out;
    }
    // el.props.<key> — chaves de props vistas no arquivo
    if (base.endsWith('.props')) {
        for (const [name, type] of Object.entries(syms.propTypes)) {
            out.push(sug(name, 'prop', `prop ${type} vista no arquivo`, name, false, '0'));
        }
        return out;
    }
    // bibliotecas padrão
    const mods = LUA_MODULES[base];
    if (mods) for (const mname of mods) out.push(sug(mname, 'member', `${base}.${mname}`, mname, false, '1'));
    return out;
}

// ---------- entry point ----------

/**
 * sugestões contextuais pro documento.
 * @param {string} text documento inteiro
 * @param {number} line linha (0-based) do cursor
 * @param {number} character coluna (0-based) do cursor
 * @returns {Array<{label,kind,detail,insert,snippet,sortText}>}
 */
function computeSuggestions(text, line, character) {
    const lines = text.split('\n');
    const lineStart = lines.slice(0, line).reduce((a, l) => a + l.length + 1, 0);
    const pos = lineStart + character;
    const prefix = text.slice(0, pos);
    const syms = scanSymbols(text);

    // ---- contexto: dentro de uma tag aberta? ----
    const lastLt = prefix.lastIndexOf('<');
    const lastGt = prefix.lastIndexOf('>');
    if (lastLt > lastGt) {
        const after = prefix.slice(lastLt);
        const inClose = /^<\//.test(after);
        if (!inClose) {
            // digitando o nome da tag?  (<  |  <car)
            if (/^<\s*[A-Za-z_][\w.-]*$/.test(after) || after === '<') {
                return tagSuggestions(syms);
            }
            const tagM = /^<\s*([A-Za-z_][\w.-]*)/.exec(after);
            if (tagM) {
                const tagName = tagM[1];
                const attrZone = after.slice(tagM[0].length);
                // dentro de um block { ... }? (prop={expr) → expressão
                const open = (attrZone.match(/\{/g) || []).length;
                const close = (attrZone.match(/\}/g) || []).length;
                if (open > close) return exprSuggestions(syms);
                // nos atributos → props
                if (/^\s/.test(attrZone) || attrZone === '') {
                    return propSuggestions(syms, tagName);
                }
            }
        }
    }

    // ---- contexto: member access (base.) ----
    const dotM = /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.([A-Za-z_][\w]*)?$/.exec(
        lines[line].slice(0, character)
    );
    if (dotM) {
        const members = memberSuggestions(syms, dotM[1]);
        if (members.length) return members;
    }

    // ---- contexto: children de expressão / script {…} ----
    // (aproximação: prefixo termina com { ou { + expressão sem } na mesma linha)
    const lineText = lines[line].slice(0, character);
    if (/\{\s*[A-Za-z_][\w.]*$/.test(lineText) && !lineText.endsWith('}')) {
        return exprSuggestions(syms);
    }

    // ---- default: expressão (o VS Code filtra pelo prefixo digitado) ----
    return exprSuggestions(syms);
}

module.exports = { computeSuggestions, scanSymbols, stripComments, LUA_KEYWORDS, LUA_GLOBALS, LUA_MODULES };
