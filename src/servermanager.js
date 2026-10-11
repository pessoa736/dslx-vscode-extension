/**
 * DSLX — resolvedor do lua-language-server (machine-agnostic).
 * MIT - Davi/Pessoa736 (2026)
 *
 * Nenhum path fixo de máquina: tudo deriva de extensões instaladas ou de
 * variáveis de ambiente da API do VS Code (globalStorageUri/extensionsUri).
 * Ordem de resolução:
 *   1. config do usuário (dslx.analysis.luaLanguageServerPath)
 *   2. binário no globalStorage da DSLX (auto-download de release anterior)
 *   3. lua-language-server no PATH
 *   4. LuaLS bundled de alguma extensão VS Code conhecida (sumneko.lua,
 *      luals bundles etc.) — via extensionsUri da API, não path fixo
 *   5. auto-download da release oficial (com consentimento do usuário)
 *      pra dentro do globalStorage — nada é instalado no sistema
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');
const https = require('https');
const http = require('http');

const LUALS_REPO = 'LuaLS/lua-language-server';
const LUALS_VERSION = '3.13.6'; // última release estável testada

/** plataforma → asset do release GitHub */
function assetName() {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    switch (process.platform) {
        case 'darwin': return `lua-language-server-${LUALS_VERSION}-darwin-${arch}`;
        case 'win32': return `lua-language-server-${LUALS_VERSION}-win32-${arch}`;
        default: return `lua-language-server-${LUALS_VERSION}-linux-${arch}`;
    }
}

/** onde a DSLX guarda o LuaLS baixado (globalStorage da extensão) */
function storageDir(vscode) {
    // VS Code garante esse dir por extensão; fallback pro tmp
    try {
        const dir = vscode.extensions.getExtension('pessoa736.dslx').globalStorageUri.fsPath;
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    } catch (_) {
        const dir = path.join(os.tmpdir(), 'dslx-luals-storage');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }
}

/** binário dentro do storage baixado */
function storedBinary(vscode) {
    return path.join(storageDir(vscode), 'lua-language-server', 'bin', 'lua-language-server');
}

/** procura LuaLS bundled em TODAS as extensões instaladas (não só sumneko) */
function scanInstalledExtensions(vscode) {
    const found = [];
    try {
        const extsDir = path.join(vscode.extensions.extensionsUri ?
            vscode.extensions.extensionsUri.fsPath
            : path.join(os.homedir(), '.vscode/extensions'), '');
        // padrões conhecidos de diretórios de server
        for (const dir of fs.readdirSync(extsDir)) {
            const candidates = [
                path.join(extsDir, dir, 'server/bin/lua-language-server'),
                path.join(extsDir, dir, 'bin/lua-language-server'),
                path.join(extsDir, dir, 'lua-language-server/bin/lua-language-server'),
            ];
            for (const c of candidates) {
                if (fs.existsSync(c)) {
                    found.push(c);
                    break;
                }
            }
        }
    } catch (_) {}
    return found;
}

/** o binário roda? (--version num subprocess curto) */
function works(binPath) {
    if (!binPath || !fs.existsSync(binPath)) return false;
    try {
        const r = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 15000 });
        return r.status === 0 || typeof r.stdout === 'string';
    } catch (_) {
        return false;
    }
}

/** cascade completo: devolve {path, source} ou null */
function resolveServer(vscode, cfg) {
    // 1. config explícita
    const configured = cfg && cfg.luaLanguageServerPath;
    if (configured && works(configured)) {
        return { path: configured, source: 'config' };
    }

    // 2. já baixado no storage da extensão
    const stored = storedBinary(vscode);
    if (works(stored)) {
        return { path: stored, source: 'downloaded' };
    }

    // 3. no PATH
    const isWin = process.platform === 'win32';
    const pathBin = isWin ? 'lua-language-server.exe' : 'lua-language-server';
    if (works(pathBin)) {
        return { path: pathBin, source: 'path' };
    }

    // 4. bundled de extensão instalada (sumneko.lua etc.)
    for (const cand of scanInstalledExtensions(vscode)) {
        if (works(cand)) {
            return { path: cand, source: 'extension' };
        }
    }

    return null;
}

/** baixa a release oficial pro storage da extensão. devolve o caminho do bin */
function downloadServer(vscode, onProgress) {
    return new Promise((resolve, reject) => {
        const dir = storageDir(vscode);
        const asset = assetName() + '.tar.gz';
        const url = `https://github.com/${LUALS_REPO}/releases/download/${LUALS_VERSION}/${asset}`;
        const tmp = path.join(dir, 'luals.tar.gz');

        const fetch = (u, redirects) => {
            if (redirects > 5) return reject(new Error('redirects demais'));
            const mod = u.startsWith('https') ? https : http;
            mod.get(u, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return fetch(res.headers.location, redirects + 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} baixando ${asset}`));
                }
                const total = Number(res.headers['content-length'] || 0);
                let got = 0;
                const out = fs.createWriteStream(tmp);
                res.on('data', (d) => {
                    got += d.length;
                    if (onProgress && total) onProgress(got / total);
                });
                res.pipe(out);
                out.on('finish', () => {
                    // extrai: tarball tem bin/, meta/, main.lua etc.
                    const dest = path.join(dir, 'lua-language-server');
                    fs.mkdirSync(dest, { recursive: true });
                    const tar = spawnSync('tar', ['-xzf', tmp, '-C', dest], { encoding: 'utf8' });
                    if (tar.status !== 0) {
                        return reject(new Error('falha ao extrair: ' + (tar.stderr || 'tar disponível?')));
                    }
                    fs.rmSync(tmp);
                    const bin = path.join(dest, 'bin', 'lua-language-server');
                    if (!fs.existsSync(bin)) return reject(new Error('binário não encontrado após extrair'));
                    if (process.platform !== 'win32') {
                        try { fs.chmodSync(bin, 0o755); } catch (_) {}
                    }
                    resolve(bin);
                });
                out.on('error', reject);
            }).on('error', reject);
        };
        fetch(url, 0);
    });
}

module.exports = { resolveServer, downloadServer, works, storedBinary, storageDir, LUALS_VERSION };
