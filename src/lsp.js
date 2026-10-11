/**
 * DSLX ⇄ lua-language-server middleware.
 * MIT - Davi/Pessoa736 (2026)
 *
 * O .dslx é aberto pro LuaLS como documento Lua: o texto enviado é o SHADOW
 * (src/shadow.js — mesmas posições, elementos viram chamadas sintetizadas).
 * Hover, completion e diagnósticos voltam com ranges idênticos aos do .dslx,
 * então o proxy é quase transparente. O que precisa de tradução:
 *   - textDocument/didOpen|didChange|didSave: conteúdo vira shadow
 *   - publishDiagnostics: uri trocada de .dslx-shadow.lua → .dslx (a shadow
 *     é salva num arquivo temp com extensão .lua pro LuaLS aceitar)
 *   - completion/hover/definition/etc: uri trocada
 *
 * Módulo puro: export LspProxy(config) devolve {start(), stop(), request()}.
 * O extension.js registra os providers do VS Code contra ele.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { toShadow, dslxToShadowPos } = require('./shadow');

class LspProxy {
    constructor(cfg = {}) {
        this.serverPath = cfg.serverPath || 'lua-language-server';
        this.serverArgs = cfg.serverArgs || [];
        this.log = cfg.log || (() => {});
        this.shadowDir = cfg.shadowDir || path.join(os.tmpdir(), 'dslx-shadow');
        this.onDiagnostics = cfg.onDiagnostics || (() => {});
        this.rootUri = cfg.rootUri || null;
        this.proc = null;
        this.pending = new Map();
        this.nextId = 1;
        this.docs = new Map(); // dslxPath -> {shadowPath, version, shadowText}
        this.ready = false;
    }

    // ---------- framing LSP ----------

    start() {
        fs.mkdirSync(this.shadowDir, { recursive: true });
        this._writeLuarc();
        this.proc = spawn(this.serverPath, this.serverArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        this.buf = Buffer.alloc(0);

        this.proc.stdout.on('data', (d) => this._feed(d));
        this.proc.stderr.on('data', (d) => this.log('[luals]', d.toString().trimEnd()));
        this.proc.on('exit', (code) => this.log('[luals] exit', code));

        return this._request('initialize', {
            processId: process.pid,
            // o LuaLS só diagnostica com workspace: usa a pasta do 1º doc aberto
            rootUri: this.rootUri,
            capabilities: {
                textDocument: {
                    hover: { contentFormat: ['markdown', 'plaintext'] },
                    completion: { completionItem: { snippetSupport: true } },
                    synchronization: { didSave: true },
                },
            },
            workspaceFolders: null,
        }).then((res) => {
            this._notify('initialized', {});
            // config de hints/hover: habilita inlay hints e tipos no hover
            this._notify('workspace/didChangeConfiguration', { settings: { Lua: {
                hint: { enable: true, setType: true, paramType: true, await: true },
                hover: { enable: true },
                diagnostics: { enable: true, globals: ['is_element'] },
                telemetry: { enable: false },
            } } });
            this.ready = true;
            return res;
        });
    }

    stop() {
        if (this.proc) { try { this.proc.kill(); } catch (_) {} this.proc = null; }
    }

    _feed(d) {
        this.buf = Buffer.concat([this.buf, d]);
        for (;;) {
            const sep = this.buf.indexOf('\r\n\r\n');
            if (sep === -1) break;
            const m = /Content-Length:\s*(\d+)/i.exec(this.buf.slice(0, sep).toString());
            if (!m) { this.buf = this.buf.slice(sep + 4); continue; }
            const len = Number(m[1]);
            if (this.buf.length < sep + 4 + len) break;
            const msg = JSON.parse(this.buf.slice(sep + 4, sep + 4 + len).toString());
            this.buf = this.buf.slice(sep + 4 + len);
            this._onMsg(msg);
        }
    }

    _onMsg(msg) {
        if (msg.id !== undefined && msg.method !== undefined) {
            // server→client request (workspace/configuration etc.): respoder genérico
            this._respond(msg.id, null);
            return;
        }
        if (msg.id !== undefined) {
            const p = this.pending.get(msg.id);
            if (p) { this.pending.delete(msg.id); p(msg); }
            return;
        }
        if (msg.method === 'textDocument/publishDiagnostics') {
            const uri = msg.params.uri;
            // shadow-*.lua → .dslx
            const m = /(.*)-shadow-(\d+)\.lua$/.exec(uri);
            if (m) {
                const dslxUri = m[1] + '.dslx';
                this.onDiagnostics(dslxUri, msg.params.diagnostics || []);
            }
            return;
        }
        if (msg.method === 'window/logMessage') {
            this.log('[luals]', (msg.params && msg.params.message) || '');
        }
    }

    _send(obj) {
        if (!this.proc) throw new Error('LSP não iniciado');
        const body = Buffer.from(JSON.stringify(obj));
        this.proc.stdin.write('Content-Length: ' + body.length + '\r\n\r\n');
        this.proc.stdin.write(body);
    }

    _request(method, params) {
        return new Promise((resolve) => {
            const id = this.nextId++;
            this.pending.set(id, resolve);
            this._send({ jsonrpc: '2.0', id, method, params });
        });
    }

    _respond(id, result) {
        this._send({ jsonrpc: '2.0', id, result });
    }

    _notify(method, params) {
        this._send({ jsonrpc: '2.0', method, params });
    }

    // ---------- documentos ----------

    /** uri do shadow: <dir>/<hash>-shadow-<n>.lua (o regex do publishDiagnostics extrai o .dslx) */
    shadowUri(dslxPath) {
        this._ensureShadowDir(dslxPath);
        const h = crypto.createHash('sha1').update(dslxPath).digest('hex').slice(0, 12);
        return 'file://' + path.join(this.shadowDir, h + '-shadow-0.lua');
    }

    /** materializa o shadow em disco — o LuaLS lida melhor com arquivo real.
     *  shadowDir deve estar DENTRO do workspace (rootUri), senão o server ignora o doc */
    _writeShadow(dslxPath, shadowText) {
        this._ensureShadowDir(dslxPath);
        const h = crypto.createHash('sha1').update(dslxPath).digest('hex').slice(0, 12);
        const p = path.join(this.shadowDir, h + '-shadow-0.lua');
        fs.writeFileSync(p, shadowText);
        return p;
    }

    /** config do server: .luarc.json no workspace (o CLI não honra
     *  didChangeConfiguration pra hints — precisa do arquivo).
     *  integra luarocks: tree local (lua_modules/.luarocks) vira workspace.library */
    _writeLuarc() {
        const ws = this.rootUri ? this.rootUri.replace('file://', '') : this.shadowDir;
        const luarc = path.join(ws, '.luarc.json');
        // não sobrescreve config do usuário: se existir, adiciona só o que falta
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(luarc, 'utf8')); } catch (_) {}
        cfg['hint.enable'] = cfg['hint.enable'] !== undefined ? cfg['hint.enable'] : true;
        cfg['hint.setType'] = cfg['hint.setType'] !== undefined ? cfg['hint.setType'] : true;
        cfg['hint.paramType'] = cfg['hint.paramType'] !== undefined ? cfg['hint.paramType'] : true;
        cfg['hint.await'] = cfg['hint.await'] !== undefined ? cfg['hint.await'] : true;
        cfg['hover.enable'] = cfg['hover.enable'] !== undefined ? cfg['hover.enable'] : true;
        cfg['diagnostics.enable'] = cfg['diagnostics.enable'] !== undefined ? cfg['diagnostics.enable'] : true;
        cfg['diagnostics.globals'] = Array.isArray(cfg['diagnostics.globals']) ? cfg['diagnostics.globals'] : [];
        if (!cfg['diagnostics.globals'].includes('is_element')) cfg['diagnostics.globals'].push('is_element');

        // luarocks: bibliotecas do tree local entram no workspace.library
        if (!Array.isArray(cfg['workspace.library'])) cfg['workspace.library'] = [];
        for (const cand of ['lua_modules/share/lua/5.5', 'lua_modules/share/lua/5.4',
            '.luarocks/share/lua/5.5', '.luarocks/share/lua/5.4']) {
            const dir = path.join(ws, cand);
            if (fs.existsSync(dir) && !cfg['workspace.library'].includes(dir)) {
                cfg['workspace.library'].push(dir);
            }
        }

        fs.writeFileSync(luarc, JSON.stringify(cfg, null, 4));
        this._luarcPath = luarc;
    }

    /** shadowDir efetivo: dentro do workspace do doc, senão o default */
    _ensureShadowDir(dslxPath) {
        if (this._shadowDirFor === dslxPath) return;
        const ws = this.rootUri ? this.rootUri.replace('file://', '') : path.dirname(dslxPath);
        this.shadowDir = path.join(ws, '.dslx-shadow');
        fs.mkdirSync(this.shadowDir, { recursive: true });
        this._shadowDirFor = dslxPath;
    }

    openDoc(dslxPath, dslxText, version = 1) {
        const { shadow, elements, lineMap } = toShadow(dslxText);
        this._writeShadow(dslxPath, shadow);
        const uri = this.shadowUri(dslxPath);
        this.docs.set(dslxPath, { version, shadowText: shadow, elements, lineMap, origText: dslxText });
        this._notify('textDocument/didOpen', {
            textDocument: { uri, languageId: 'lua', version, text: shadow },
        });
        return uri;
    }

    changeDoc(dslxPath, dslxText, version) {
        const { shadow, elements, lineMap } = toShadow(dslxText);
        this._writeShadow(dslxPath, shadow);
        const uri = this.shadowUri(dslxPath);
        this._notify('textDocument/didChange', {
            textDocument: { uri, version },
            contentChanges: [{ text: shadow }],
        });
        this.docs.set(dslxPath, { version, shadowText: shadow, elements, lineMap, origText: dslxText });
    }

    closeDoc(dslxPath) {
        const uri = this.shadowUri(dslxPath);
        this._notify('textDocument/didClose', { textDocument: { uri } });
        this.docs.delete(dslxPath);
    }

    // ---------- requests traduzidos (uri .dslx → uri shadow + posição remapada) ----------

    /** posição dslx → shadow (remap de constructs) */
    _pos(dslxPath, line, character) {
        const doc = this.docs.get(dslxPath);
        if (!doc) return { line, character };
        const p = dslxToShadowPos(doc.elements || [], doc.lineMap, line, character);
        return p || { line, character };
    }

    /** posição shadow → dslx (reverse do lineMap; usada pros inlay hints).
     *  linhas shadow sem mapeamento (preâmbulo, anotações injetadas) → null:
     *  hint de lá é descartado, nunca aparece flutuando acima do código */
    _posBack(dslxPath, line, character) {
        const doc = this.docs.get(dslxPath);
        if (!doc || !doc.lineMap) return null;
        const idx = doc.lineMap.indexOf(line);
        if (idx === -1) return null;
        return { line: idx, character };
    }

    /** inlay hints do range dslx (traduz range → shadow e as posições de volta) */
    async inlayHints(dslxPath, startLine, endLine) {
        const doc = this.docs.get(dslxPath);
        if (!doc) return [];
        const s = this._pos(dslxPath, startLine, 0);
        const e = this._pos(dslxPath, endLine, 0);
        const r = await this._request('textDocument/inlayHint', {
            textDocument: { uri: this.shadowUri(dslxPath) },
            range: {
                start: s,
                end: e || { line: endLine, character: 0 },
            },
        });
        const hints = r && r.result;
        if (!Array.isArray(hints)) return [];
        // traduz posição de volta pro dslx e devolve no formato interno.
        //  - hints em linhas sem mapeamento (preâmbulo/anotações) → descartados
        //  - hints de PARÂMETRO (kind 2) em linha de construct → descartados
        //    (a sintaxe XML não mostra parâmetro; o hint "el:" ficaria
        //    flutuando em cima do nome da tag)
        //  - hints de TIPO em linha de construct: só os que caem ANTES do '<'
        //    (ex.: `: integer` depois de `local resultado =`) — os de dentro
        //    do construct não têm posição equivalente no dslx
        const constructLines = new Map(); // dslxLine -> callCol
        for (const el of (doc.elements || [])) {
            constructLines.set(el.dslxStartLine, el.callCol);
        }
        const out = [];
        for (const h of hints) {
            const back = this._posBack(dslxPath, h.position.line, h.position.character);
            if (!back) continue;
            const callCol = constructLines.get(back.line);
            if (callCol !== undefined) {
                if (h.kind === 2) continue; // hint de parâmetro no construct → fora
                if (back.character > callCol) continue; // dentro do construct → fora
            }
            const label = typeof h.label === 'string'
                ? h.label
                : (h.label || []).map((v) => v.value).join('');
            out.push({
                line: back.line,
                character: back.character,
                label,
                kind: h.kind,
                tooltip: h.tooltip && h.tooltip.contents ? h.tooltip.contents.value : undefined,
            });
        }
        return out;
    }

    /** assinatura da função-tag chamada na linha dslx (pra enriquecer hover) */
    async tagCallSignatureAt(dslxPath, line, character) {
        const doc = this.docs.get(dslxPath);
        if (!doc || !doc.origText) return null;
        const lines = doc.origText.split('\n');
        const l = lines[line];
        if (!l) return null;
        // tem um construct de tag na linha? <tag …
        const m = /<([A-Za-z_][\w.-]*)/.exec(l);
        if (!m) return null;
        const tagCol = l.indexOf(m[0]);
        const pos = this._pos(dslxPath, line, tagCol + 1);
        const r = await this._request('textDocument/hover', {
            textDocument: { uri: this.shadowUri(dslxPath) },
            position: pos,
        });
        const v = r && r.result && r.result.contents && r.result.contents.value;
        return v || null;
    }

    hover(dslxPath, line, character) {
        const pos = this._pos(dslxPath, line, character);
        return this._request('textDocument/hover', {
            textDocument: { uri: this.shadowUri(dslxPath) },
            position: pos,
        });
    }

    completion(dslxPath, line, character) {
        const pos = this._pos(dslxPath, line, character);
        return this._request('textDocument/completion', {
            textDocument: { uri: this.shadowUri(dslxPath) },
            position: pos,
        });
    }

    definition(dslxPath, line, character) {
        return this._request('textDocument/definition', {
            textDocument: { uri: this.shadowUri(dslxPath) },
            position: { line, character },
        });
    }

    references(dslxPath, line, character) {
        return this._request('textDocument/references', {
            textDocument: { uri: this.shadowUri(dslxPath) },
            position: { line, character },
            context: { includeDeclaration: true },
        });
    }

    documentSymbol(dslxPath) {
        return this._request('textDocument/documentSymbol', {
            textDocument: { uri: this.shadowUri(dslxPath) },
        });
    }
}

module.exports = { LspProxy };
