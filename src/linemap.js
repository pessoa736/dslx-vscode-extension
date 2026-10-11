/**
 * Alinhamento de linhas .dslx -> .lua gerado.
 * MIT - Davi/Pessoa736 (2026)
 *
 * O compilador DSLX copia os trechos de Lua verbatim, então essas linhas são
 * idênticas nos dois arquivos. Constructs de tag viram uma linha só no
 * gerado, então o mapa não é 1:1 — o alinhamento anda com um ponteiro
 * monótono procurando linhas idênticas.
 */

/** devolve um array: índice da linha gerada (1-based) -> linha do fonte (1-based) ou 0 */
function alignLines(srcText, genText) {
    const src = (srcText + '\n').split(/\r?\n/).slice(0, -1);
    const gen = (genText + '\n').split(/\r?\n/).slice(0, -1);

    const map = new Array(gen.length + 1).fill(0);
    let p = 0;

    for (let g = 1; g <= gen.length; g++) {
        const gl = gen[g - 1];
        while (p < src.length && src[p] !== gl) p++;
        if (p < src.length) {
            map[g] = p + 1;
            p++;
        }
        // sem match: linha de construct de tag — fica 0 (não mapeada)
    }

    return map;
}

/** reverso: linha do fonte -> primeira linha gerada correspondente (ou 0) */
function buildReverse(map) {
    const rev = {};
    for (let g = 1; g < map.length; g++) {
        if (map[g] > 0 && rev[map[g]] === undefined) rev[map[g]] = g;
    }
    return rev;
}

const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();

module.exports = { alignLines, buildReverse, norm };
