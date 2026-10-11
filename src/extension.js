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

    // ---------- lua-language-server ----------

    let lualsCache = null; // true/false/null (não testado ainda)

    function luaLanguageServerPath() {
        return cfg().get('analysis.luaLanguageServerPath', 'lua-language-server');
    }

    function hasLuaLS() {
        if (lualsCache !== null) return lualsCache;
        try {
            const r = spawnSync(luaLanguageServerPath(), ['--version'], { encoding: 'utf8' });
            lualsCache = !r.error;
        } catch (_) {
            lualsCache = false;
        }
        return lualsCache;
    }

    /** compila pra um .lua temporário e roda o LuaLS em cima, mapeando de volta */
    async function lualsCheck(file, add) {
        if (!cfg().get('analysis.useLuaLanguageServer', true) || !hasLuaLS()) return;

        // workspace temporário: compila o .lua lá e deixa o LuaLS varrer o dir
        const cacheDir = path.join(os.tmpdir(), 'dslx-ls');
        fs.mkdirSync(cacheDir, { recursive: true });

        const r = await runRunner(['compile', file, cacheDir], path.dirname(file));
        if (r.err) return;
        const gen = path.join(cacheDir, path.basename(file).replace(/\.dslx$/i, '.lua'));
        if (!fs.existsSync(gen)) return;

        // limpa outros .lua do cache pra não vazar diagnóstico de arquivo antigo
        for (const f of fs.readdirSync(cacheDir)) {
            if (f.endsWith('.lua') && f !== path.basename(gen)) {
                try { fs.rmSync(path.join(cacheDir, f)); } catch (_) {}
            }
        }

        // mapa de linhas gerado -> dslx
        let map = [];
        try {
            map = alignLines(fs.readFileSync(file, 'utf8'), fs.readFileSync(gen, 'utf8'));
        } catch (_) { return; }

        const outFile = path.join(cacheDir, 'check.json');
        try { fs.rmSync(outFile); } catch (_) {}

        return new Promise((resolve) => {
            execFile(luaLanguageServerPath(), [
                '--check=' + cacheDir,
                '--checklevel=Warning',
                '--check_format=json',
                '--check_out_path=' + outFile,
            ], {
                cwd: cacheDir,
                encoding: 'utf8',
                env: childEnv(),
                timeout: 120000,
            }, (err, stdout, stderr) => {
                let report = null;
                try { report = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (_) {}
                if (!report) return resolve();

                const target = 'file://' + gen;
                const diags = report[target] || [];
                for (const dg of diags) {
                    const genLine = ((dg.range || {}).start || {}).line;
                    if (genLine === undefined || !map[genLine + 1]) continue;
                    const dslxLine = map[genLine + 1];
                    const sev = dg.severity === 1
                        ? vscode.DiagnosticSeverity.Error
                        : vscode.DiagnosticSeverity.Warning;
                    const d = new vscode.Diagnostic(
                        new vscode.Range(dslxLine - 1, 0, dslxLine - 1, 1),
                        `[lua-language-server] ${dg.message}`,
                        sev
                    );
                    d.source = 'lua-language-server';
                    if (dg.code) d.code = dg.code;
                    add(d);
                }
                resolve();
            });
        });
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
            if (doc && doc.isDirty) return; // só analisa o que tá salvo em disco
            try { await analyze(key, false); } catch (_) {}
        }, 700));
    }

    if (cfg().get('analysis.enable', true)) {
        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.languageId === 'dslx') scheduleAnalyze(e.document.uri);
            }),
            vscode.workspace.onDidSaveTextDocument((doc) => {
                if (doc.languageId === 'dslx') analyze(doc.fileName, false);
            })
        );
        // analisa os .dslx já abertos
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.languageId === 'dslx') analyze(doc.fileName, false);
        }
    }

    const analyzeCommand = vscode.commands.registerCommand('dslx.analyze', async (uri) => {
        const file = await targetFile(uri);
        if (!file) return vscode.window.showWarningMessage('Abra (ou selecione no explorer) um arquivo .dslx primeiro.');

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, async (progress) => {
            progress.report({ message: `analisando ${path.basename(file)}…` });
            const { count } = await analyze(file, true);
            if (count === 0) {
                if (cfg().get('analysis.useLuaLanguageServer', true) && !hasLuaLS()) {
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
        provideCompletionItems(document, position) {
            const sugs = computeSuggestions(document.getText(), position.line, position.character);
            return sugs.map((s) => {
                const item = new vscode.CompletionItem(s.label, KIND[s.kind] || vscode.CompletionItemKind.Text);
                item.detail = s.detail;
                item.sortText = s.sortText;
                if (s.snippet) {
                    item.insertText = new vscode.SnippetString(s.insert);
                } else {
                    item.insertText = s.insert;
                }
                return item;
            });
        },
    }, '.', '{', '<', ' ', '@'); // trigger chars (espaço p/ sair do estado de tag)

    // hover: mostra o que o símbolo é (função, var, tag, global Lua)
    const hoverProvider = vscode.languages.registerHoverProvider('dslx', {
        provideHover(document, position) {
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

    context.subscriptions.push(channel, diagnostics, compileCommand, runCommand, analyzeCommand, envCommand);
}

function deactivate() {}

module.exports = { activate, deactivate };
