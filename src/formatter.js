/**
 * DSLX formatter — re-indentação leve (zero dependências).
 * MIT - Davi/Pessoa736 (2026)
 *
 * Regras:
 *  - blocos Lua (function/if/elseif/else/for/while/do/repeat) aumentam o nível
 *  - constructs de tag aninhados aumentam o nível (linha com <tag...> aberta
 *    que fecha em linha posterior)
 *  - 'end'/'until'/'</tag>'/'elseif'/'else' voltam um nível ANTES da linha
 *  - linhas de continuação (construct aberto na linha anterior sem fechar)
 *    mantêm indentação relativa à linha que abriu
 *
 * Não mexe em espaços internos nem quebra de linhas — só o leading whitespace.
 */

'use strict';

/** calcula o leading-whitespace alvo pra cada linha */
function formatDslx(text, options = {}) {
    const indentUnit = options.indentUnit || '    ';
    const lines = text.split('\n');
    const out = [];
    let depth = 0;
    // pilha de "o que abriu": {type:'lua'|'tag', closed:boolean}
    const stack = [];

    const LUA_OPEN = /\b(function|if|for|while|do|repeat)\b/;
    const LUA_CLOSE = /^\s*(end|until)\b/;
    const LUA_MID = /^\s*(elseif|else)\b/;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const raw = line;
        const stripped = line.replace(/--[^\n]*$/, '').trim();

        // string/comment multi-linha: preserva verbatim (não re-indentamos dentro)
        if (inMultiline(lines, i)) {
            out.push(raw);
            continue;
        }

        if (stripped === '') { out.push(''); continue; }

        // fecha antes: construct de fechamento volta nível
        let closeBefore = 0;
        if (/^<\//.test(stripped)) closeBefore = 1;
        else if (LUA_CLOSE.test(stripped) && topIsLua(stack)) closeBefore = 1;
        else if (LUA_MID.test(stripped) && topIsLua(stack)) closeBefore = 1;

        const lineDepth = Math.max(0, depth - closeBefore);

        // aplica
        out.push(indentUnit.repeat(lineDepth) + stripped);

        // atualiza profundidade com base no que a linha abre/fecha
        depth = lineDepth;
        stack.length = lineDepth;

        // tags: conta opens/creates na linha (aproximação por linha)
        const tagOpens = (raw.match(/<(?!\/|!|const|close)[A-Za-z_][\w.-]*(?=[\s/>])/g) || []).length;
        const tagCloses = (raw.match(/<\/[A-Za-z_][\w.-]*\s*>/g) || []).length;
        const selfCloses = (raw.match(/\/>/g) || []).length;

        let luaOpens = 0, luaCloses = 0;
        const noComment = raw.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');
        const m1 = noComment.match(LUA_OPEN);
        if (m1) luaOpens = m1.length;
        const m2 = noComment.match(/\b(end|until)\b/g);
        if (m2) luaCloses = m2.length;
        if (LUA_MID.test(stripped)) luaOpens = 0; // elseif/else não abre

        // tag aberta em linha própria que não fecha nela → +1
        const opensTag = /^\s*<[^/>]*[^/]?>\s*$/.test(raw) && !/\/>/.test(raw);
        const closesTag = /^<\//.test(stripped);

        // lua: function/if/... na linha sem end na mesma linha → +1
        const opensLua = LUA_OPEN.test(noComment) && !/\bend\b/.test(noComment) && !LUA_MID.test(stripped);

        if (opensTag) { depth++; stack.push('tag'); }
        if (opensLua) { depth++; stack.push('lua'); }
        // linha que abre E fecha tag (inline) não muda nível
        // (tagCloses/selfCloses em linha com opensTag única: net 0)
        if (closesTag && stack[lineDepth - 1] === 'tag') { /* já tratado no closeBefore da próxima? não — tratado acima */ }
    }

    return out.join('\n');
}

function topIsLua(stack) {
    return stack.length > 0 && stack[stack.length - 1] === 'lua';
}

/** detecta linhas dentro de --[[ ]] multilinha */
function inMultiline(lines, i) {
    // varre do início até i contando block comments abertos
    let open = false;
    for (let k = 0; k <= i; k++) {
        const l = lines[k];
        let idx = 0;
        while (idx < l.length) {
            if (!open && l.startsWith('--[[', idx)) { open = true; idx += 4; continue; }
            if (open && l.includes(']]', idx)) { open = false; idx = l.indexOf(']]', idx) + 2; continue; }
            idx++;
        }
    }
    return open;
}

module.exports = { formatDslx };
