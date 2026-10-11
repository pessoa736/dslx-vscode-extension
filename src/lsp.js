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

    /** shadowDir efetivo: dentro do workspace do doc, senão o default */
    _ensureShadowDir(dslxPath) {
        if (this._shadowDirFor === dslxPath) return;
        const ws = this.rootUri ? this.rootUri.replace('file://', '') : path.dirname(dslxPath);
        this.shadowDir = path.join(ws, '.dslx-shadow');
        fs.mkdirSync(this.shadowDir, { recursive: true });
        this._shadowDirFor = dslxPath;
    }

    openDoc(dslxPath, dslxText, version = 1) {
        const { shadow, elements } = toShadow(dslxText);
        this._writeShadow(dslxPath, shadow);
        const uri = this.shadowUri(dslxPath);
        this.docs.set(dslxPath, { version, shadowText: shadow, elements, origText: dslxText });
        this._notify('textDocument/didOpen', {
            textDocument: { uri, languageId: 'lua', version, text: shadow },
        });
        return uri;
    }

    changeDoc(dslxPath, dslxText, version) {
        const { shadow, elements } = toShadow(dslxText);
        this._writeShadow(dslxPath, shadow);
        const uri = this.shadowUri(dslxPath);
        this._notify('textDocument/didChange', {
            textDocument: { uri, version },
            contentChanges: [{ text: shadow }],
        });
        this.docs.set(dslxPath, { version, shadowText: shadow, elements, origText: dslxText });
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
        const p = dslxToShadowPos(doc.origText, doc.elements || [], line, character);
        return p || { line, character };
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
