/**
 * DSLX shadow transform — .dslx → Lua válido com as MESMAS posições.
 * MIT - Davi/Pessoa736 (2026)
 *
 * O scanner espelha a gramática LPeg real do DSLX (runtime/dslx/parser.lua):
 *   - elemento: `<nome props>` corpo `</nome>` | `<nome props/>`
 *   - nome: [A-Za-z_][\w.-]* ; props: "str" | 'str' | {expr} | bare
 *   - children: texto | {expr} | elementos aninhados
 *
 * Saída: código Lua onde cada elemento vira UMA chamada
 * `nome{name="nome", props={...}, childrens={...}}` começando na MESMA coluna
 * do `<`, com o restante do construct blankado em espaços (newlines
 * preservados — o número de linhas não muda). Código Lua é copiado verbatim.
 * Com isso o lua-language-server vê Lua válido com as posições do .dslx:
 * hover/diagnósticos mapeiam 1:1, e o tipo dos elementos é inferido de
 * verdade pelas chamadas sintetizadas.
 */

'use strict';

const NAME_START = /[A-Za-z_]/;
const NAME_RE = /[A-Za-z_][\w.-]*/y;
// < depois disso = comparação Lua, não tag (mesma guarda da grammar)
const GUARD_BAD_BEFORE = /[\w"')\]}]/;

/** preâmbulo de tipos: define `element` (a tabela que toda função-tag recebe) */
const PREAMBLE = [
    '---@class (partial) element',
    '---@field name string',
    '---@field props table<string, any>',
    '---@field childrens any[]',
    '',
].join('\n') + '\n';

function isWs(c) { return c === ' ' || c === '\t' || c === '\r' || c === '\n'; }

/** escapa string pra literal Lua */
function luaQuote(s) {
    let out = '"';
    for (const ch of s) {
        if (ch === '"') out += '\\"';
        else if (ch === '\\') out += '\\\\';
        else if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else if (ch < ' ') out += '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0');
        else out += ch;
    }
    return out + '"';
}

/**
 * Tenta parsear um elemento começando exatamente em text[i] === '<'.
 * Semântica fiel ao parser LPeg (sem guarda de comparação).
 * @returns {null | {unterminated:true} | {end:number, name:string, kind, call:string, spansLines:number}}
 */
function parseElement(text, i) {
    const n = text.length;
    let p = i + 1;
    while (p < n && isWs(text[p])) p++;
    let kind = 'open';
    if (text[p] === '/') { kind = 'close'; p++; while (p < n && isWs(text[p])) p++; }
    NAME_RE.lastIndex = p;
    const nm = NAME_RE.exec(text);
    if (!nm) return null;
    const name = nm[0];
    p = nm.index + nm[0].length;

    // props
    const props = [];
    const blocks = []; // blocos {expr} com posição original (pro remap de colunas)
    let sawProp = false;
    for (;;) {
        const wsStart = p;
        while (p < n && isWs(text[p])) p++;
        if (p >= n) return { unterminated: true };
        const c = text[p];
        if (c === '>' || (c === '/' && text[p + 1] === '>')) break;
        // prop name
        NAME_RE.lastIndex = p;
        const pn = NAME_RE.exec(text);
        if (!pn || pn.index !== p) return null; // sintaxe não reconhecida → aborta
        const pname = pn[0];
        p += pn[0].length;
        const pwsStart = p;
        while (p < n && isWs(text[p])) p++;
        if (text[p] === '=') {
            p++;
            while (p < n && isWs(text[p])) p++;
            const q = text[p];
            if (q === '"' || q === "'") {
                p++;
                let val = '';
                while (p < n && text[p] !== q) { val += text[p]; p++; }
                if (p >= n) return { unterminated: true };
                p++; // fecha aspa
                props.push(`${pname}=${luaQuote(val)}`);
            } else if (q === '{') {
                // block {expr} — captura balanceado
                const blk = readBlock(text, p);
                if (!blk) return { unterminated: true };
                props.push(`${pname}=${blk.content}`);
                blocks.push({ content: blk.content, origFrom: p + 1, origTo: blk.end - 1 });
                p = blk.end;
            } else {
                return null;
            }
            sawProp = true;
        } else {
            // prop booleana (bare) — o parser aceita nome solto
            props.push(`${pname}=true`);
            sawProp = true;
            p -= 0; // p já aponta depois do nome
        }
    }
    // fecha open ou self-close
    let selfClose = false;
    if (text[p] === '/') { selfClose = true; p += 2; } else { p++; } // pula '>'
    if (kind === 'close') return { end: p, name, kind: 'close', call: null, spansLines: countLines(text, i, p) };
    if (kind !== 'open') return null;

    // children (só se não for self-close)
    const children = [];
    let textAcc = '';
    if (!selfClose) {
        for (;;) {
            if (p >= n) return { unterminated: true };
            const c = text[p];
            if (c === '<') {
                // fecha?
                const closeM = /^<\s*\/\s*[A-Za-z_][\w.-]*\s*>/.exec(text.slice(p));
                if (closeM) {
                    const cname = /^<\s*\/\s*([A-Za-z_][\w.-]*)/.exec(closeM[0])[1];
                    p += closeM[0].length;
                    if (cname !== name) {
                        // parser LPeg rejeita mismatch → elemento inteiro não casa;
                        // no shadow, degradamos: trata como fechamento mesmo assim
                    }
                    break;
                }
                // elemento aninhado?
                if (canStartElement(text, p)) {
                    const el = parseElement(text, p);
                    if (el && !el.unterminated && el.call) {
                        if (textAcc) { children.push(luaQuote(textAcc)); textAcc = ''; }
                        children.push(el.call);
                        p = el.end;
                        continue;
                    }
                    if (el && el.unterminated) return { unterminated: true };
                    // não deu: trata '<' como texto
                    textAcc += '<';
                    p++;
                    continue;
                }
                textAcc += '<';
                p++;
                continue;
            }
            if (c === '{') {
                const blk = readBlock(text, p);
                if (!blk) return { unterminated: true };
                if (textAcc.trim()) { children.push(luaQuote(textAcc)); }
                else if (textAcc && children.length) { children.push(luaQuote(textAcc)); }
                blocks.push({ content: blk.content, origFrom: p + 1, origTo: blk.end - 1 });
                textAcc = '';
                children.push(blk.content);
                p = blk.end;
                continue;
            }
            textAcc += c;
            p++;
        }
        if (textAcc) children.push(luaQuote(textAcc));
    }

    // sintetiza a chamada
    const propsStr = props.length ? `{${props.join(', ')}}` : '{}';
    const childrenStr = children.length ? `{${children.join(', ')}}` : '{}';
    const call = `${name}{name=${luaQuote(name)}, props=${propsStr}, childrens=${childrenStr}}`;

    // callOffset de cada bloco (posição do conteúdo dentro da chamada).
    // blocos multi-linha são achatados (newlines → espaço) na chamada pra
    // preservar o nº de linhas do shadow; só blocos de 1 linha são mapeáveis.
    const mappings = [{ kind: 'name', offset: 0, len: name.length }];
    let cursor = 0;
    for (const b of blocks) {
        const flat = b.content.replace(/\r?\n/g, ' ');
        let idx = call.indexOf(flat, cursor);
        if (idx === -1) idx = call.indexOf(b.content, cursor);
        if (idx !== -1) {
            mappings.push({ kind: 'block', callOffset: idx, len: flat.length, origFrom: b.origFrom, origTo: b.origTo });
            cursor = idx + flat.length;
        }
    }

    return { end: p, name, kind: selfClose ? 'selfClose' : 'open', call, mappings, spansLines: countLines(text, i, p) };
}

/** offset absoluto do início da linha (0-based) */
function lineStartOf(text, line) {
    let pos = 0;
    for (let i = 0; i < line; i++) pos += text.split('\n')[i].length + 1;
    return pos;
}

/** lê um block { ... } balanceado; devolve conteúdo e end */
function readBlock(text, i) {
    const n = text.length;
    let depth = 0;
    let p = i;
    while (p < n) {
        const c = text[p];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return { content: text.slice(i + 1, p), end: p + 1 }; }
        else if (c === '"' || c === "'") {
            p++;
            while (p < n && text[p] !== c) { if (text[p] === '\\') p++; p++; }
            if (p >= n) return null;
        }
        p++;
    }
    return null;
}

function countLines(text, from, to) {
    let c = 0;
    for (let i = from; i < to; i++) if (text[i] === '\n') c++;
    return c;
}

/** o '<' aqui inicia elemento? (guarda de comparação da grammar) */
function canStartElement(text, i) {
    // atrás: identificador/aspas/fechamento (com espaço opcional) → comparação
    let j = i - 1;
    while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
    if (j >= 0) {
        const prev = text[j];
        if (GUARD_BAD_BEFORE.test(prev)) {
            // exceção: `return <tag>` e `= <tag>` são elementos no dslx
            const before = text.slice(Math.max(0, j - 20), j + 1);
            if (/(\breturn|==|~=|\||=|[,{(])\s*$/.test(text.slice(0, j + 1)) && /[=\n\r{,]\s*return\s*$|\breturn\s*$|=\s*$|==\s*$|~=\s*$/.test(text.slice(Math.max(0, i - 30), i))) {
                return true;
            }
            return false;
        }
    }
    // <const>/<close> do Lua nunca são tag
    if (/^<(?:const|close)\b/.test(text.slice(i, i + 8))) return false;
    return true;
}

/**
 * shadow transform completo.
 * @returns {{shadow: string, problems: Array, elements: Array,
 *            lineMap: number[], preambleLines: number}}
 * lineMap: lineMap[dslxLine] = linha correspondente no shadow (0-based);
 * usado pra traduzir posições dos dois lados (preâmbulo + anotações injetadas).
 */
function toShadow(text) {
    let n = text.length;
    let out = '';
    let i = 0;
    const problems = [];
    const elements = []; // constructs transformados (pro remap de posições)

    // ---- pré-scan: funções usadas como tag → recebem @param el element ----
    const tagNames = new Set();
    {
        const reTag = /<([A-Za-z_][\w.-]*)/g;
        let m;
        while ((m = reTag.exec(text))) {
            if (!/^<\/?const\b|^<\/?close\b/.test(m[0])) tagNames.add(m[1]);
        }
    }

    // ---- pré-scan: props usadas em cada tag → geram @class <tag>_props ----
    // tipos inferidos dos usos: "str" → string, {expr} → tipo do expr (any),
    // bare → boolean. o @class tipa el.props.<nome> no LuaLS
    const tagProps = new Map(); // tag -> Map(prop -> 'string'|'any'|'boolean')
    {
        const reUse = /<([A-Za-z_][\w.-]*)([^<>]*?)(\/>|>)/g;
        let m;
        while ((m = reUse.exec(text))) {
            const tag = m[1];
            const attrs = m[2];
            if (!tagProps.has(tag)) tagProps.set(tag, new Map());
            const props = tagProps.get(tag);
            const reAttr = /([A-Za-z_][\w.-]*)\s*=\s*(?:"[^"]*"|'[^']*'|\{[^{}]*\})/g;
            let a;
            const used = new Set();
            while ((a = reAttr.exec(attrs))) {
                used.add(a[1]);
                const val = a[0].split('=')[1].trim();
                const type = val.startsWith('"') || val.startsWith("'") ? 'string'
                    : val.startsWith('{') ? 'any' : 'boolean';
                props.set(a[1], type);
            }
            // props booleanas (nome solto)
            const rest = attrs.replace(reAttr, ' ');
            for (const tok of rest.split(/\s+/)) {
                if (/^[A-Za-z_][\w.-]*$/.test(tok) && !used.has(tok)) props.set(tok, 'boolean');
            }
        }
    }

    // preâmbulo extendido: @class element + @class por tag com props tipadas.
    // TERMINA com linha em branco: @class colado num comentário --- acima de
    // função faz o LuaLS tratar a função como CONSTRUTOR da classe (mata o @return)
    let preamble = PREAMBLE;
    for (const [tag, props] of tagProps) {
        if (!props.size) continue;
        preamble += `---@class ${tag}_props\n`;
        for (const [pname, ptype] of props) {
            preamble += `---@field ${pname} ${ptype}\n`;
        }
    }
    preamble += '\n';
    const PREAMBLE_DYNAMIC = preamble;

    // linha de declaração de cada função-componente (local function f(el) …)
    // + se o usuário JÁ anotou @param/@return, não injetamos nada (as
    // anotações dele ganham; a injecção dupla quebra a inferência do LuaLS)
    const componentAnnLines = new Map(); // linha dslx -> @param sintético | null
    {
        const lines = text.split('\n');
        // pega o bloco de comentários --- acima de cada declaração
        const hasOwnParam = (declLine) => {
            for (let k = declLine - 1; k >= 0; k--) {
                const l = lines[k].trim();
                if (l === '') continue;
                if (l.startsWith('---@param')) return true;
                if (l.startsWith('---') || l.startsWith('--')) continue;
                return false; // comentário comum, não emmylua
            }
            return false;
        };
        for (let l = 0; l < lines.length; l++) {
            const m = /(?:^|\s)local\s+function\s+([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)?\s*\)/.exec(lines[l])
                || /(?:^|\s)function\s+([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)?\s*\)/.exec(lines[l]);
            if (m && tagNames.has(m[1]) && m[2]) {
                componentAnnLines.set(l, hasOwnParam(l) ? null : true);
            }
        }
    }

    // ---- pré-processa: injeta as anotações de tipo ANTES das declarações ----
    // o resultado tem +1 linha por componente; o lineMap traduz dslx↔anotado
    let annText = '';
    const srcLines0 = text.split('\n');
    let annLines = 0;
    const injectedAt = new Map(); // linha dslx -> linha no texto anotado
    for (let l = 0; l < srcLines0.length; l++) {
        if (componentAnnLines.get(l) === true) {
            // @param com tipo DEDICADO da tag, só quando o usuário não anotou
            const mDecl = /(?:^|\s)(?:local\s+)?function\s+([A-Za-z_]\w*)\s*\(/.exec(srcLines0[l]);
            const tag = mDecl ? mDecl[1] : null;
            const propsClass = tag && tagProps.has(tag) ? `${tag}_props` : '';
            const paramType = propsClass
                ? `{name:string, props:${propsClass}, childrens:any[]}`
                : 'element';
            annText += `---@param el ${paramType}\n`;
            annLines++;
        }
        injectedAt.set(l, l + annLines);
        annText += srcLines0[l] + (l < srcLines0.length - 1 ? '\n' : '');
    }

    // ---- mapa de linhas: dslxLine -> shadowLine (preâmbulo + anotações) ----
    // PREAMBLE termina com \n; conteúdo começa na linha = nº de \n do preâmbulo
    const preambleLines = (PREAMBLE_DYNAMIC.match(/\n/g) || []).length;
    const lineMap = []; // dslx line -> shadow line
    for (let l = 0; l < srcLines0.length; l++) {
        lineMap[l] = preambleLines + injectedAt.get(l);
    }

    // escreve o preâmbulo e processa o texto ANOTADO
    out += PREAMBLE_DYNAMIC;
    text = annText;
    i = 0;
    const n2 = text.length;
    n = n2;

    /** linha anotada → linha dslx (mapa inverso do injectedAt; SEM preâmbulo —
     *  o scanner roda sobre o texto anotado, que ainda não tem o preâmbulo) */
    const backMap = new Map();
    for (const [dslxL, annL] of injectedAt.entries()) backMap.set(annL, dslxL);
    const lineMapBack = (annLine) => {
        if (backMap.has(annLine)) return backMap.get(annLine);
        return Math.max(0, annLine);
    };

    while (i < n) {
        const c = text[i];
        if (c === '"') { // string Lua: copia verbatim
            let p = i + 1;
            while (p < n && text[p] !== '"') { if (text[p] === '\\') p++; p++; out += text.slice(i, Math.min(p + 1, n)); i = Math.min(p + 1, n); break; }
            continue;
        }
        if (c === "'") {
            let p = i + 1;
            while (p < n && text[p] !== "'") { if (text[p] === '\\') p++; p++; }
            out += text.slice(i, Math.min(p + 1, n));
            i = Math.min(p + 1, n);
            continue;
        }
        if (c === '-' && text[i + 1] === '-') { // comentário: verbatim
            let end = text.indexOf('\n', i);
            if (end === -1) end = n;
            // block comment?
            const bm = /^--\[(=*)\[/.exec(text.slice(i, i + 16));
            if (bm) {
                const close = ']' + bm[1] + ']';
                const e2 = text.indexOf(close, i + bm[0].length);
                end = e2 === -1 ? n : e2 + close.length;
            }
            out += text.slice(i, end);
            i = end;
            continue;
        }
        if (c === '<' && canStartElement(text, i)) {
            const el = parseElement(text, i);
            if (el && el.call) {
                // blanking do construct inteiro preservando \n nas posições
                // relativas, com a chamada PREPENDIDA na coluna do '<'.
                // a linha estica (chamada + espaços), mas o nº de linhas fica
                // exato e o token do componente fica na coluna certa pro hover
                const construct = text.slice(i, el.end);
                let blanked = '';
                for (const ch of construct) blanked += (ch === '\n' ? '\n' : ' ');
                out += el.call + blanked;

                // registra o elemento pra tradução de posições:
                // annStartLine/callCol medidos no texto ANOTADO;
                // dslxStartLine = linha correspondente no dslx original
                const startLine = countLines(text, 0, i);
                const srcLines = text.split('\n');
                const callCol = srcLines[startLine].indexOf('<');
                // enriquece os mappings com linha/coluna dslx de cada bloco
                for (const m of (el.mappings || [])) {
                    if (m.kind === 'block') {
                        m.annLine = countLines(text, 0, m.origFrom);
                        m.annCol = m.origFrom - lineStartOf(text, m.annLine);
                        const dl = lineMapBack(m.annLine);
                        m.dslxLine = dl;
                        m.dslxCol = m.annCol;
                    }
                }
                elements.push({
                    startLine,          // linha no espaço anotado
                    callLine: startLine,
                    callCol: callCol >= 0 ? callCol : 0,
                    mappings: el.mappings || [],
                    origTextStart: i,
                    origTextEnd: el.end,
                    callText: el.call,
                    annStartLine: startLine,
                    dslxStartLine: lineMapBack(startLine), // linha dslx via mapa inverso
                });
                i = el.end;
                continue;
            }
            if (el && el.unterminated) {
                const ln = countLines(text, 0, i);
                problems.push({ line: ln, message: 'elemento não fechado' });
            }
        }
        out += c;
        i++;
    }
    return { shadow: out, problems, elements, lineMap, preambleLines };
}

/**
 * traduz posição dslx → shadow (usa o lineMap do toShadow: preâmbulo+anotações).
 * o `elements` carrega dslxStartLine + callCol + mappings no espaço anotado.
 * @returns {{line, character} | null} null = posição não mapeável
 */
function dslxToShadowPos(elements, lineMap, line, character) {
    // linha shadow da linha dslx (preamble + anotações já contabilizados)
    const shadowLine = (lineMap && lineMap[line] !== undefined) ? lineMap[line] : line;

    for (const el of elements) {
        if (line === el.dslxStartLine) {
            // cursor sobre o nome da tag → token na chamada (col do '<')
            if (character >= el.callCol && character < el.callCol + 1 + (el.mappings[0] ? el.mappings[0].len : 0) + 1) {
                return { line: shadowLine, character: el.callCol };
            }
            // blocos {expr} da MESMA linha dslx
            for (const m of el.mappings) {
                if (m.kind === 'block' && m.dslxLine === line && character >= m.dslxCol && character < m.dslxCol + m.len) {
                    return { line: shadowLine, character: el.callCol + m.callOffset + (character - m.dslxCol) };
                }
            }
        }
    }
    return { line: shadowLine, character };
}

/** coluna (no shadow line do construct) do token do nome do componente */
function findTagStartCol(text, el, line, character) {
    // chamada começa na coluna do '<' na linha startLine
    const srcLines = text.split('\n');
    const constructFirstLine = srcLines[el.startLine];
    const ltCol = constructFirstLine.indexOf('<');
    return ltCol >= 0 ? ltCol : null;
}

/** diff de colunas entre duas posições absolutas do mesmo construct, achatando \n */
function countNonNewlineDiff(text, from, to) {
    let c = 0;
    for (let i = from; i < to && i < text.length; i++) {
        if (text[i] === '\n') return c; // bloqueado: só mapeia bloco de 1 linha
        c++;
    }
    return c;
}

/**
 * traduz range shadow → dslx (hover/diagnósticos que VOLtam do LuaLS).
 * ranges fora de constructs são idênticos; ranges da linha de uma chamada
 * que cai fora do texto da chamada são descartados (null).
 */
function shadowToDslxRange(text, elements, startLine, startCol, endLine, endCol) {
    // por ora: linhas fora de construct → idêntico; dentro → range do construct
    // TODO refinamento: mapear ranges de blocos de volta
    return { startLine, startCol, endLine, endCol };
}

module.exports = { toShadow, parseElement, readBlock, canStartElement, dslxToShadowPos, shadowToDslxRange };
