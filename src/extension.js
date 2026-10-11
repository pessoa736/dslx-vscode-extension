/**
 * DSLX — suporte à linguagem no VS Code
 * MIT - Davi/Pessoa736 (2026)
 *
 * - highlight/snippets (grammar + snippets)
 * - compilar / executar (runtime vendado + LuLPeg)
 * - diagnóstico de erros ao digitar/salvar (parser real + compilação)
 * - lua-language-server no .lua compilado, mapeado de volta pro .dslx
 * - debugger (DAP em src/dap/adapter.js + engine em runtime/debugger.lua)
 * - comando de ambiente (versões, LPeg, package.path, env vars)
 */
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile, spawnSync } = require('child_process');
const { alignLines } = require('./linemap');
const { computeSuggestions, scanSymbols, LUA_GLOBALS } = require('./completion');
const { LspProxy } = require('./lsp');
const { formatDslx } = require('./formatter');
const servermgr = require('./servermanager');

function activate(context) {
    const runner = path.join(context.extensionPath, 'runtime', 'dslx_runner.lua');
    const channel = vscode.window.createOutputChannel('DSLX');

    const cfg = () => vscode.workspace.getConfiguration('dslx');
    const luaExe = () => cfg().get('luaInterpreter', 'lua');

    /** ambiente injetado em todo processo Lua (config dslx.env) */
    function childEnv() {
        return { ...process.env, ...(cfg().get('env', {}) || {}) };
    }

    /** roda o runner sem shell (caminhos com espaço ficam seguros) */
    function runRunner(args, cwd) {
        return new Promise((resolve) => {
            execFile(
                luaExe(),
                [runner, ...args],
                { cwd, encoding: 'utf8', env: childEnv() },
                (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' })
            );
        });
    }

    /** resolve o alvo: uri do menu do explorer ou o editor ativo (salvando se preciso) */
    async function targetFile(uri) {
        if (uri && uri.fsPath && uri.fsPath.endsWith('.dslx')) return uri.fsPath;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return undefined;
        const doc = editor.document;
        if (!doc.fileName || !doc.fileName.endsWith('.dslx')) return undefined;
        if (doc.isDirty) await doc.save();
        return doc.fileName;
    }

    // ==========================================================
    // compilar / executar
    // ==========================================================

    const compileCommand = vscode.commands.registerCommand('dslx.compile', async (uri) => {
        const file = await targetFile(uri);
        if (!file) return vscode.window.showWarningMessage('Abra (ou selecione no explorer) um arquivo .dslx primeiro.');

        const out = file.replace(/\.dslx$/i, '.lua');
        const r = await runRunner(['compile', file], path.dirname(file));
        if (r.err) {
            channel.clear();
            channel.appendLine(r.stderr || r.stdout || String(r.err));
            channel.show();
            return vscode.window.showErrorMessage('DSLX: falhou a compilação — detalhes no output "DSLX".');
        }

        vscode.window.showInformationMessage(`DSLX: ${path.basename(file)} → ${path.basename(out)}`);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(out));
        vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
    });

    const runCommand = vscode.commands.registerCommand('dslx.run', async (uri) => {
        const file = await targetFile(uri);
        if (!file) return vscode.window.showWarningMessage('Abra (ou selecione no explorer) um arquivo .dslx primeiro.');

        let term = vscode.window.terminals.find((t) => t.name === 'DSLX');
        if (!term) term = vscode.window.createTerminal({ name: 'DSLX', cwd: path.dirname(file) });

        const q = (s) => '"' + String(s).replace(/(["$`\\])/g, '\\$1') + '"';
        term.sendText(q(luaExe()) + ' ' + q(runner) + ' run ' + q(file), true);
        term.show();
    });

    // ==========================================================
    // diagnóstico de erros (parser + compilação + lua-language-server)
    // ==========================================================

    const diagnostics = vscode.languages.createDiagnosticCollection('dslx');

    /** análise rápida: parser real + load() do Lua gerado */
    async function parserCheck(file) {
        const r = await runRunner(['check', file], path.dirname(file));
        try {
            return JSON.parse(r.stdout.trim().split('\n').pop());
        } catch (_) {
            return { ok: false, kind: 'io', message: r.stderr || 'não consegui rodar o parser (interpretador configurado?)' };
        }
    }

    function toDiagnostic(res) {
        if (!res || res.ok) return null;
        const line = Math.max(0, (res.line || 1) - 1);
        const col = Math.max(0, (res.column || 1) - 1);
        const range = new vscode.Range(line, col, line, col + 1);
        const d = new vscode.Diagnostic(range, res.message || 'erro no DSLX', vscode.DiagnosticSeverity.Error);
        d.source = 'dslx';
        return d;
    }

    // ---------- lua-language-server (proxy LSP vivo) ----------

    let lualsCache = null; // {path, source} | null (não resolvido ainda)
    let lualsResolvePromise = null;
    let lspProxy = null;
    let lspStarting = null;

    /** resolve o binário: config → storage → PATH → extensões instaladas.
     *  se não achar e o usuário permitir, baixa da release oficial pro
     *  globalStorage da DSLX (nada é instalado no sistema dele) */
    function resolveLuaLS() {
        if (lualsCache) return Promise.resolve(lualsCache);
        if (lualsResolvePromise) return lualsResolvePromise;

        lualsResolvePromise = (async () => {
            const configured = cfg().get('analysis.luaLanguageServerPath', '');
            const found = servermgr.resolveServer(vscode, {
                luaLanguageServerPath: configured,
            });
            if (found) {
                lualsCache = found;
                return found;
            }

            // não achamos nada: oferece o download (uma vez por sessão)
            const download = await vscode.window.showInformationMessage(
                'DSLX: o lua-language-server não foi encontrado. Quer baixar a versão oficial (~25 MB, só no storage da extensão)? Isso habilita hover com tipos, diagnósticos semânticos e inlay hints.',
                'Baixar', 'Agora não'
            );
            if (download === 'Baixar') {
                try {
                    const bin = await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, cancellable: false },
                        (progress) => new Promise((resolve, reject) => {
                            servermgr.downloadServer(vscode, (frac) => {
                                progress.report({ message: `baixando lua-language-server… ${(frac * 100).toFixed(0)}%` });
                            }).then(resolve).catch(reject);
                        })
                    );
                    lualsCache = { path: bin, source: 'downloaded' };
                    channel.appendLine(`LuaLS ${servermgr.LUALS_VERSION} baixado em ${bin}`);
                    return lualsCache;
                } catch (e) {
                    channel.appendLine('download do LuaLS falhou: ' + e.message);
                    vscode.window.showWarningMessage('DSLX: falhou o download do lua-language-server — a extensão funciona sem ele (parser, debugger, completion básico), só sem tipos semânticos.');
                }
            }
            lualsCache = null;
            return null;
        })();
        return lualsResolvePromise;
    }

    function hasLuaLS() {
        return resolveLuaLS().then((r) => !!r);
    }

    function luaLanguageServerPath() {
        return lualsCache ? lualsCache.path : 'lua-language-server';
    }

    /** severidade LSP → VS Code */
    const LSP_SEV = {
        1: vscode.DiagnosticSeverity.Error,
        2: vscode.DiagnosticSeverity.Warning,
        3: vscode.DiagnosticSeverity.Information,
        4: vscode.DiagnosticSeverity.Hint,
    };

    // ==========================================================
    // cores das anotações emmylua (@param/@return/@class/@field…)
    // ==========================================================
    // a grammar emite os escopos (storage.type.annotation.lua, support.type.lua
    // etc.), mas muitos temas (Monokai e derivados) só pintam o bloco inteiro
    // como comentário. o comando aplica tokenColorCustomizations no settings
    // do USUÁRIO — só com consentimento explícito.
    const THEME_PATCH = {
        'textMateRules': [
            { scope: 'storage.type.annotation.lua', settings: { foreground: '#66d9ef', fontStyle: 'bold' } },
            { scope: 'comment.line.double-dash.documentation.lua support.type.lua', settings: { foreground: '#66d9ef' } },
            { scope: 'comment.line.double-dash.documentation.lua support.class.lua', settings: { foreground: '#a6e22e' } },
            { scope: 'comment.line.double-dash.documentation.lua entity.name.variable.lua', settings: { foreground: '#fd971f' } },
        ],
    };

    const themeCommand = vscode.commands.registerCommand('dslx.colorAnnotations', async () => {
        const alvo = 'editor.tokenColorCustomizations';
        const atual = vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations') || {};
        const escolha = await vscode.window.showInformationMessage(
            'DSLX: aplicar cores para as anotações de tipo (@param, @return, @class…) no seu settings.json? Pode reverter removendo o bloco "editor.tokenColorCustomizations".',
            'Aplicar', 'Cancelar'
        );
        if (escolha !== 'Aplicar') return;

        const rules = (atual.textMateRules || []).slice();
        const nossos = THEME_PATCH.textMateRules.map((r) => r.scope);
        const merged = rules.filter((r) => !nossos.includes(r.scope)).concat(THEME_PATCH.textMateRules);
        await vscode.workspace.getConfiguration('editor').update(
            'tokenColorCustomizations',
            { ...atual, textMateRules: merged },
            vscode.ConfigurationTarget.Global
        );
        vscode.window.showInformationMessage('DSLX: cores aplicadas — os @annotations agora têm destaque.');
    });

    // detecta tema que não pinta as annotations e oferece o comando 1x/sessão
    let themeOffered = false;
    function maybeOfferColors() {
        if (themeOffered) return;
        themeOffered = true;
        const tema = vscode.workspace.getConfiguration('workbench').get('colorTheme', '');
        // heurística: Monokai conhecido por não pintar storage.type.annotation
        if (/monokai/i.test(tema)) {
            vscode.window.showInformationMessage(
                `DSLX: o tema "${tema}" não destaca as anotações de tipo (@param, @return…). Quer aplicar as cores?`,
                'Aplicar', 'Agora não'
            ).then((r) => { if (r === 'Aplicar') vscode.commands.executeCommand('dslx.colorAnnotations'); });
        }
    }

    /** sobe (uma vez) o proxy LuaLS e abre o doc; devolve o proxy ou null */
    function getProxy(doc) {
        if (!cfg().get('analysis.useLuaLanguageServer', true)) return Promise.resolve(null);
        if (lspProxy && lspProxy.ready) {
            if (!lspProxy.docs.has(doc.fileName)) lspProxy.openDoc(doc.fileName, doc.getText());
            return Promise.resolve(lspProxy);
        }
        if (lspStarting) return lspStarting.then(() => getProxy(doc));

        // resolve o binário primeiro (pode baixar na primeira vez)
        lspStarting = resolveLuaLS().then((found) => {
            if (!found) return null;

            const startPromise = new Promise((resolve) => {
                const wsFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
                const p = new LspProxy({
                    serverPath: found.path,
                    rootUri: wsFolder ? wsFolder.uri.toString() : 'file://' + path.dirname(doc.fileName),
                    log: (m) => channel.appendLine(m),
                    onDiagnostics: (dslxUri, list) => {
                        const uri = vscode.Uri.parse(dslxUri);
                        const ds = list.map((dg) => {
                            const d = new vscode.Diagnostic(
                                new vscode.Range(
                                    dg.range.start.line, dg.range.start.character,
                                    dg.range.end.line, dg.range.end.character
                                ),
                                dg.message,
                                LSP_SEV[dg.severity] || vscode.DiagnosticSeverity.Warning
                            );
                            d.source = 'lua-language-server';
                            if (dg.code) d.code = dg.code;
                            return d;
                        });
                        // merge com os diagnósticos do parser dslx (se houver)
                        const existing = diagnostics.get(uri);
                        const parserDs = (existing || []).filter((d) => d.source === 'dslx');
                        diagnostics.set(uri, [...parserDs, ...ds]);
                    },
                });
                p.start().then(() => {
                    lspProxy = p;
                    resolve(p);
                }).catch((e) => {
                    channel.appendLine('LuaLS falhou: ' + e.message);
                    resolve(null);
                });
            });
            return startPromise;
        }).catch(() => null);

        return lspStarting.then(() => getProxy(doc));
    }

    /** abre/sincroniza o doc no proxy quando muda */
    function syncDoc(doc) {
        if (doc.languageId !== 'dslx') return;
        maybeOfferColors();
        getProxy(doc).then((proxy) => {
            if (!proxy) return;
            if (proxy.docs.has(doc.fileName)) {
                proxy.changeDoc(doc.fileName, doc.getText(), doc.version);
            } else {
                proxy.openDoc(doc.fileName, doc.getText(), doc.version);
            }
        });
    }

    /** análise de um arquivo por demanda (comando analizar): parser + push do LuaLS */
    async function lualsCheck(file, add) {
        if (!cfg().get('analysis.useLuaLanguageServer', true)) return;
        if (!(await hasLuaLS())) return;
        // o proxy vivo publica diagnósticos via onDiagnostics; aqui só garantimos
        // que o doc tá aberto (o analyze explícito reabre pra forçar)
        const doc = vscode.workspace.textDocuments.find((d) => d.fileName === file);
        if (doc) syncDoc(doc);
    }

    /** análise completa: parser + LuaLS; atualiza a coleção de diagnósticos */
    async function analyze(file, explicit) {
        const list = [];

        const res = await parserCheck(file);
        const d = toDiagnostic(res);
        if (d) list.push(d);

        if (cfg().get('analysis.enable', true) || explicit) {
            await lualsCheck(file, (diag) => list.push(diag));
        }

        diagnostics.set(vscode.Uri.file(file), list);
        return { res, count: list.length };
    }

    // debounce por arquivo pra análise on-type
    const timers = new Map();
    function scheduleAnalyze(uri) {
        const key = uri.fsPath;
        if (timers.has(key)) clearTimeout(timers.get(key));
        timers.set(key, setTimeout(async () => {
            timers.delete(key);
            const doc = vscode.workspace.textDocuments.find((d) => d.fileName === key);
            if (!doc) return;
            // parser roda no arquivo salvo; o proxy LSP sincroniza o texto vivo
            syncDoc(doc);
            if (doc.isDirty) return;
            try { await analyze(key, false); } catch (_) {}
        }, 700));
    }

    if (cfg().get('analysis.enable', true)) {
        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.languageId !== 'dslx') return;
                // IMEDIATO: alimenta o LuaLS com o texto novo na hora — sem isso
                // hover e inlay hints mostram tipos do estado ANTES da edição
                // (didChange e requests seguintes são ordenados no stdio do
                // server, então toda consulta já vê o texto novo)
                syncDoc(e.document);
                // o parser externo continua com debounce (spawn é caro)
                scheduleAnalyze(e.document.uri);
            }),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (doc.languageId === 'dslx') { syncDoc(doc); analyze(doc.fileName, false); }
            }),
            vscode.workspace.onDidOpenTextDocument((doc) => {
                if (doc.languageId === 'dslx') syncDoc(doc);
            }),
            vscode.workspace.onDidCloseTextDocument((doc) => {
                if (doc.languageId === 'dslx' && lspProxy) lspProxy.closeDoc(doc.fileName);
            })
        );
        // sincroniza os .dslx já abertos
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.languageId === 'dslx') { syncDoc(doc); analyze(doc.fileName, false); }
        }
    }

    const analyzeCommand = vscode.commands.registerCommand('dslx.analyze', async (uri) => {
        const file = await targetFile(uri);
        if (!file) return vscode.window.showWarningMessage('Abra (ou selecione no explorer) um arquivo .dslx primeiro.');

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async (progress) => {
            progress.report({ message: `analisando ${path.basename(file)}…` });
            const { count } = await analyze(file, true);
            if (count === 0) {
                if (cfg().get('analysis.useLuaLanguageServer', true) && !(await hasLuaLS())) {
                    vscode.window.showWarningMessage('DSLX: sem erros — mas o lua-language-server não foi encontrado (veja dslx.analysis.luaLanguageServerPath).');
                } else {
                    vscode.window.showInformationMessage('DSLX: nenhum problema encontrado.');
                }
            } else {
                vscode.window.showWarningMessage(`DSLX: ${count} problema(s) — veja as marcações no editor.`);
            }
        });
    });

    // ==========================================================
    // ambiente
    // ==========================================================

    const envCommand = vscode.commands.registerCommand('dslx.env', async () => {
        channel.clear();

        const lines = [];
        lines.push('═══ ambiente DSLX ═══');
        lines.push('');

        // variáveis relevantes do processo (lado da extensão)
        lines.push('— variáveis de ambiente do processo (LUA*/DSLX*) —');
        const procEnv = Object.entries(process.env).filter(([k]) => /^(LUA|DSLX)/i.test(k));
        if (procEnv.length === 0) lines.push('  (nenhuma definida)');
        for (const [k, v] of procEnv.sort()) lines.push(`  ${k}=${v}`);
        lines.push('');

        // config de env da extensão
        const envCfg = cfg().get('env', {}) || {};
        lines.push('— variáveis injetadas pela config dslx.env —');
        const envEntries = Object.entries(envCfg);
        if (envEntries.length === 0) lines.push('  (nenhuma)');
        for (const [k, v] of envEntries) lines.push(`  ${k}=${v}`);
        lines.push('');

        // probe dentro do interpretador
        lines.push(`— interpretador (${luaExe()}) —`);
        const r = await runRunner(['env']);
        if (r.err) {
            lines.push('  ERRO: não consegui rodar o probe — ' + (r.stderr || String(r.err)));
        } else {
            try {
                const env = JSON.parse(r.stdout.trim().split('\n').pop());
                lines.push(`  lua:          ${env.lua}`);
                lines.push(`  lpeg:         ${env.lpeg}${env.lpeg_version ? ' ' + env.lpeg_version : ''}`);
                lines.push(`  import.path:  ${env.import_path}`);
                lines.push(`  use_cache:    ${env.import_use_cache}`);
                lines.push(`  dirsep:       ${env.dirsep}`);
                lines.push('');
                lines.push('  package.path (dentro do runner):');
                for (const p of String(env.package_path || '').split(';')) lines.push(`    ${p}`);
                lines.push('');
                lines.push('  variáveis vistas pelo processo Lua:');
                for (const [k, v] of Object.entries(env.env || {})) {
                    lines.push(`    ${k}=${v === null ? '(não definida)' : v}`);
                }
            } catch (e) {
                lines.push('  saída não reconhecida:\n' + r.stdout);
            }
        }

        channel.appendLine(lines.join('\n'));
        channel.show();
    });

    // ==========================================================
    // debugger: resolve a config de launch
    // ==========================================================

    const debugProvider = {
        resolveDebugConfiguration(folder, config) {
            if (!config.type) config.type = 'dslx';
            if (!config.program) {
                const editor = vscode.window.activeTextEditor;
                if (editor && editor.document.languageId === 'dslx') {
                    config.program = editor.document.fileName;
                }
            }
            if (!config.program) {
                vscode.window.showErrorMessage('DSLX: abra um arquivo .dslx pra depurar.');
                return null;
            }
            config.interpreter = config.interpreter || luaExe();
            config.env = { ...(cfg().get('env', {}) || {}), ...(config.env || {}) };
            return config;
        },
    };
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('dslx', debugProvider));

    // ==========================================================
    // language features: completion, hover, signature help
    // ==========================================================

    // kinds do completion.js -> API do VS Code
    const KIND = {
        tag: vscode.CompletionItemKind.Class,
        prop: vscode.CompletionItemKind.Property,
        var: vscode.CompletionItemKind.Variable,
        func: vscode.CompletionItemKind.Function,
        global: vscode.CompletionItemKind.Function,
        keyword: vscode.CompletionItemKind.Keyword,
        member: vscode.CompletionItemKind.Field,
        snippet: vscode.CompletionItemKind.Snippet,
    };

    const completionProvider = vscode.languages.registerCompletionItemProvider('dslx', {
        async provideCompletionItems(document, position) {
            // 1. sugestões semânticas do LuaLS (via shadow — escopo real)
            const lualsItems = [];
            const proxy = await getProxy(document);
            if (proxy) {
                const r = await proxy.completion(document.fileName, position.line, position.character);
                const items = r && r.result && (r.result.items || r.result);
                if (Array.isArray(items)) {
                    for (const it of items) {
                        // só símbolos (functions/vars/fields); keywords/snippets ficam com o engine local
                        if (it.kind === 14 || it.kind === 15) continue; // Keyword / Snippet do LSP
                        const item = new vscode.CompletionItem(
                            it.label,
                            it.kind === 3 ? vscode.CompletionItemKind.Function : undefined
                        );
                        if (it.detail) item.detail = '[LuaLS] ' + it.detail;
                        if (it.insertText) item.insertText = it.insertText;
                        if (it.documentation) {
                            item.documentation = it.documentation.value
                                ? it.documentation.value
                                : String(it.documentation);
                        }
                        lualsItems.push(item);
                    }
                }
            }

            // 2. engine contextual local (tags, props, guards de declaração…)
            const sugs = computeSuggestions(document.getText(), position.line, position.character);

            // merge: prioridade pro LuaLS (semântica); local cobre os contextos DSLX
            const seen = new Set(lualsItems.map((i) => i.label));
            const localItems = sugs.map((s) => {
                const item = new vscode.CompletionItem(s.label, KIND[s.kind] || vscode.CompletionItemKind.Text);
                item.detail = s.detail;
                item.sortText = s.sortText;
                item.insertText = s.snippet ? new vscode.SnippetString(s.insert) : s.insert;
                return item;
            });

            return [...lualsItems, ...localItems.filter((i) => !seen.has(i.label))];
        },
    }, '.', '{', '<', ' ', '@');

    // hover: lua-language-server primeiro (tipos inferidos, doc comments),
    // fallback pro scanner local
    const hoverProvider = vscode.languages.registerHoverProvider('dslx', {
        async provideHover(document, position) {
            // 1. LuaLS via shadow (posições idênticas)
            const proxy = await getProxy(document);
            if (proxy) {
                const r = await proxy.hover(document.fileName, position.line, position.character);
                const contents = r && r.result && r.result.contents;
                if (contents) {
                    let md = contents.value ? [contents.value] : [contents];

                    // hover fraco (unknown) numa var que recebe tag na mesma linha?
                    // enriquece com a assinatura da função-tag (o "-> tipo" dela)
                    const val = contents.value || '';
                    if (/:\s*unknown\s*```/.test(val) || /: unknown/.test(val)) {
                        const sig = await proxy.tagCallSignatureAt(
                            document.fileName, position.line, position.character
                        );
                        if (sig) md = [sig, ...md];
                    }
                    return new vscode.Hover(md);
                }
            }

            // 2. fallback: scanner local
            const range = document.getWordRangeAtPosition(position, /[A-Za-z_][\w.-]*/);
            if (!range) return null;
            const word = document.getText(range);
            const syms = scanSymbols(document.getText());

            // função do arquivo
            const f = syms.funcs.find((x) => x.name === word);
            if (f) {
                const sig = `${f.local ? 'local ' : ''}function ${f.name}(${f.params.join(', ')})`;
                const isComp = f.params.length === 1;
                return new vscode.Hover([
                    { language: 'dslx', value: sig },
                    `${isComp ? 'componente/elemento DSLX — ' : ''}função definida na linha ${f.line + 1}`,
                ]);
            }
            // variável
            const v = syms.vars.find((x) => x.name === word);
            if (v) {
                return new vscode.Hover(`${v.kind === 'param' ? 'parâmetro' : v.kind === 'global' ? 'global' : 'local'} (linha ${v.line + 1})`);
            }
            // tag usada
            if (syms.tagUses.some((u) => u.name === word)) {
                const uses = syms.tagUses.filter((u) => u.name === word).length;
                const props = syms.tags[word] ? [...syms.tags[word].keys()] : [];
                return new vscode.Hover([
                    `elemento \`<${word}>\` — ${uses} uso(s) no arquivo`,
                    props.length ? `props vistas: ${props.map((p) => `\`${p}\``).join(', ')}` : 'sem props',
                ]);
            }
            // global Lua
            const g = LUA_GLOBALS.find(([n]) => n === word);
            if (g) return new vscode.Hover({ language: 'lua', value: g[1] });
            return null;
        },
    });

    // signature help: parâmetros da função sob o cursor
    const signatureProvider = vscode.languages.registerSignatureHelpProvider('dslx', {
        provideSignatureHelp(document, position) {
            const syms = scanSymbols(document.getText());
            const line = document.lineAt(position).text.slice(0, position.character);
            // última chamada aberta na linha: nome(
            const m = /([A-Za-z_][\w.]*)\s*\(([^()]*)$/.exec(line);
            if (!m) return null;
            const f = syms.funcs.find((x) => x.name === m[1]);
            if (!f) return null;

            const sig = new vscode.SignatureInformation(`${f.name}(${f.params.join(', ')})`);
            const commas = (m[2].match(/,/g) || []).length;
            sig.activeParameter = commas;
            const help = new vscode.SignatureHelp();
            help.signatures = [sig];
            return help;
        },
    }, ',', '(');

    context.subscriptions.push(completionProvider, hoverProvider, signatureProvider);

    // inlay hints: tipos de variáveis estilo rust-analyzer, cor de comentário
    // (o VS Code pinta automático pela categoria `type`)
    const inlayProvider = vscode.languages.registerInlayHintsProvider('dslx', {
        async provideInlayHints(document, range) {
            const proxy = await getProxy(document);
            if (!proxy) return [];
            const hints = await proxy.inlayHints(
                document.fileName,
                range.start.line,
                Math.min(range.end.line + 1, document.lineCount - 1)
            );
            return hints
                .filter((h) => h.line < document.lineCount)
                .map((h) => {
                    const kind = h.kind === 2
                        ? vscode.InlayHintKind.Type
                        : vscode.InlayHintKind.Parameter;
                    const ih = new vscode.InlayHint(
                        new vscode.Position(h.line, Math.min(h.character, document.lineAt(h.line).range.end.character)),
                        h.label,
                        kind
                    );
                    return ih;
                });
        },
    });
    context.subscriptions.push(inlayProvider);

    // formatação: Shift+Alt+F / "Format Document"
    const formatProvider = vscode.languages.registerDocumentFormattingEditProvider('dslx', {
        provideDocumentFormattingEdits(document) {
            const formatted = formatDslx(document.getText());
            if (formatted === document.getText()) return [];
            const lastLine = document.lineAt(document.lineCount - 1);
            const fullRange = new vscode.Range(0, 0, document.lineCount - 1, lastLine.range.end.character);
            return [vscode.TextEdit.replace(fullRange, formatted)];
        },
    });
    context.subscriptions.push(formatProvider);

    context.subscriptions.push(channel, diagnostics, compileCommand, runCommand, analyzeCommand, envCommand, themeCommand);
}

function deactivate() {}

module.exports = { activate, deactivate };
