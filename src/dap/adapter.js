/**
 * DSLX Debug Adapter — fala DAP com o VS Code e JSONL com a engine Lua.
 * MIT - Davi/Pessoa736 (2026)
 *
 * Fluxo: launch -> compila o .dslx pra .lua -> mapeia linhas -> spawn da engine
 * (runtime/debugger.lua) com os breakpoints num arquivo JSON -> traduz eventos.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { alignLines, buildReverse, norm } = require('../linemap');

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const RUNNER = path.join(EXT_ROOT, 'runtime', 'dslx_runner.lua');
const ENGINE = path.join(EXT_ROOT, 'runtime', 'debugger.lua');

let seq = 1;
const nextSeq = () => seq++;

// ---------- DAP: enquadramento Content-Length ----------

function send(msg) {
    msg.seq = msg.seq || nextSeq();
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
}

function respond(request, body) {
    send({ type: 'response', request_seq: request.seq, success: true, command: request.command, body: body || {} });
}

function respondError(request, message) {
    send({ type: 'response', request_seq: request.seq, success: false, command: request.command, message });
}

function event(name, body) {
    send({ type: 'event', event: name, body: body || {} });
}

let dapBuf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
    dapBuf = Buffer.concat([dapBuf, d]);
    for (;;) {
        const sep = dapBuf.indexOf('\r\n\r\n');
        if (sep === -1) break;
        const header = dapBuf.slice(0, sep).toString();
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) { dapBuf = dapBuf.slice(sep + 4); continue; }
        const len = Number(m[1]);
        if (dapBuf.length < sep + 4 + len) break;
        const body = dapBuf.slice(sep + 4, sep + 4 + len).toString('utf8');
        dapBuf = dapBuf.slice(sep + 4 + len);
        try { handleDap(JSON.parse(body)); } catch (e) { console.error('DAP parse:', e.message); }
    }
});
process.stdin.on('end', () => { killChild(); process.exit(0); });

// ---------- estado da sessão ----------

let child = null;
let launch = null;
let dslxPath = null;
let luaPath = null;
let map = [];        // linha gerada -> linha dslx
let rev = {};       // linha dslx -> linha gerada
let breakpoints = []; // [{file, line}] no .lua
let bpFile = null;
let pendingEngine = null; // resolve do último pedido à engine
let sawTerminated = false; // evita terminated duplicado
let lastScopes = null;      // scopes da última parada (refs -1/-2 já vêm com variáveis)

function killChild() {
    if (child) {
        try { child.kill(); } catch (_) {}
        child = null;
    }
}

// ---------- engine (JSONL) ----------

function sendEngine(obj) {
    return new Promise((resolve, reject) => {
        if (!child || child.exitCode !== null) return reject(new Error('engine não está rodando'));
        // pedidos de fluxo (continue/step) são ack'd pela engine com resp:ok;
        // respostas event demais são disparadas fora de ordem, então só
        // espera resp se o pedido tem resposta (stack/scopes/variables/ok)
        const wantsResp = obj.cmd !== 'continue' && obj.cmd !== 'stepInto'
            && obj.cmd !== 'stepOver' && obj.cmd !== 'stepOut';
        pendingEngine = { resolve, reject, wantsResp };
        try {
            child.stdin.write(JSON.stringify(obj) + '\n');
            if (!wantsResp) resolve({});
        } catch (e) { reject(e); }
    });
}

function onEngineLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch (_) {
        event('output', { category: 'stdout', output: line + '\n' });
        return;
    }

    if (msg.resp) {
        // resp:ok é só o ack de fluxo (continue/step) — sendEngine já resolveu na hora
        if (msg.resp === 'ok') return;
        if (pendingEngine) {
            const p = pendingEngine;
            pendingEngine = null;
            p.resolve(msg);
        }
        return;
    }

    if (msg.event === 'stopped') {
        event('stopped', { reason: msg.reason || 'breakpoint', threadId: 1 });
    } else if (msg.event === 'output') {
        event('output', { category: msg.category || 'stdout', output: msg.text || '' });
    } else if (msg.event === 'terminated') {
        sawTerminated = true;
        event('terminated');
    }
}

// ---------- helpers ----------

/** compila o .dslx no .lua correspondente (ou usa .lua direto) */
function prepareProgram() {
    if (launch.program.endsWith('.dslx')) {
        const r = spawnSync(launch.interpreter, [RUNNER, 'compile', dslxPath], {
            cwd: path.dirname(dslxPath),
            encoding: 'utf8',
            env: childEnv(),
        });
        if (r.status !== 0) {
            event('output', { category: 'stderr', output: (r.stderr || r.stdout || 'falhou a compilação') + '\n' });
            event('terminated');
            return false;
        }
    }
    return true;
}

function childEnv() {
    return { ...process.env, ...(launch.env || {}) };
}

/** mapeia linha do .dslx pro .lua gerado (ou devolve 0) */
function dslxLineToLua(line) {
    return rev[line] || 0;
}

function luaLineToDslx(line) {
    return (map && map[line]) || 0;
}

function writeBreakpointFile() {
    const payload = {
        stopOnEntry: launch.stopOnEntry === true,
        breakpoints: breakpoints.map((b) => ({ file: b.file, line: b.line })),
    };
    fs.writeFileSync(bpFile, JSON.stringify(payload));
}

// ---------- DAP: requests ----------

function handleDap(req) {
    if (req.type !== 'request') return;

    switch (req.command) {
        case 'initialize':
            respond(req, {
                supportsConfigurationDoneRequest: true,
                supportsConditionalBreakpoints: false,
                supportsHitConditionalBreakpoints: false,
                supportsEvaluateForHovers: false,
                supportsSetVariable: false,
                supportsTerminateRequest: false,
                exceptionBreakpointFilters: [],
            });
            event('initialized');
            break;

        case 'launch': {
            launch = req.arguments || {};
            launch.interpreter = launch.interpreter || 'lua';
            dslxPath = launch.program;
            luaPath = dslxPath.replace(/\.dslx$/i, '.lua');
            bpFile = path.join(os.tmpdir(), `dslx-bp-${process.pid}.json`);

            if (!prepareProgram()) { respond(req); return; }

            // mapa de linhas
            try {
                const src = fs.readFileSync(dslxPath.endsWith('.dslx') ? dslxPath : null, 'utf8');
                const gen = fs.readFileSync(luaPath, 'utf8');
                map = alignLines(src, gen);
                rev = buildReverse(map);
            } catch (_) {
                map = [];
                rev = {};
            }

            respond(req);
            break;
        }

        case 'setBreakpoints': {
            const args = req.arguments || {};
            const file = args.source && args.source.path;
            const lines = args.lines || [];
            const out = [];

            if (file) {
                const f = norm(file);
                if (f === norm(dslxPath)) {
                    for (const ln of lines) {
                        const g = dslxLineToLua(ln);
                        out.push({
                            verified: g > 0,
                            line: ln,
                            message: g > 0 ? undefined : 'linha sem trecho de Lua correspondente (construct de tag ou linha colapsada)',
                        });
                        if (g > 0) breakpoints.push({ file: luaPath, line: g });
                    }
                } else if (f === norm(luaPath)) {
                    for (const ln of lines) {
                        out.push({ verified: true, line: ln });
                        breakpoints.push({ file: luaPath, line: ln });
                    }
                } else {
                    for (const ln of lines) out.push({ verified: false, line: ln, message: 'arquivo fora da sessão' });
                }
            }

            respond(req, { breakpoints: out });
            break;
        }

        case 'setExceptionBreakpoints':
            respond(req, { breakpoints: [] });
            break;

        case 'configurationDone': {
            respond(req);
            writeBreakpointFile();

            const args = [ENGINE, luaPath, bpFile, ...(launch.args || [])];
            child = spawn(launch.interpreter, args, {
                cwd: path.dirname(luaPath),
                env: childEnv(),
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            let pending = '';
            child.stdout.on('data', (d) => {
                pending += d.toString('utf8');
                let i;
                while ((i = pending.indexOf('\n')) !== -1) {
                    onEngineLine(pending.slice(0, i));
                    pending = pending.slice(i + 1);
                }
            });
            child.stderr.on('data', (d) => event('output', { category: 'stderr', output: d.toString('utf8') }));
            child.on('exit', () => {
                if (!sawTerminated) { sawTerminated = true; event('terminated'); }
            });

            event('thread', { reason: 'started', threadId: 1 });
            break;
        }

        case 'threads':
            respond(req, { threads: [{ id: 1, name: 'DSLX' }] });
            break;

        case 'stackTrace':
            sendEngine({ cmd: 'stack' }).then((r) => {
                const frames = (r.frames || []).map((f) => {
                    const isLua = norm(f.file) === norm(luaPath);
                    const dslxLine = isLua ? luaLineToDslx(f.line) : 0;
                    if (isLua && dslxLine > 0) {
                        return {
                            id: f.id,
                            name: f.name,
                            source: { name: path.basename(dslxPath), path: dslxPath },
                            line: dslxLine,
                            column: 1,
                        };
                    }
                    return {
                        id: f.id,
                        name: f.name,
                        source: { name: path.basename(f.file), path: f.file },
                        line: f.line,
                        column: 1,
                    };
                });
                respond(req, { stackFrames: frames, totalFrames: frames.length });
            }).catch(() => respondError(req, 'engine parada'));
            break;

        case 'scopes':
            sendEngine({ cmd: 'scopes', frame: req.arguments.frameId || 0 }).then((r) => {
                const scopes = (r.scopes || []).map((s) => ({
                    name: s.name,
                    variablesReference: s.variablesReference,
                    expensive: s.name === 'Globais',
                }));
                // pedidos de variáveis usam as refs que a engine mandou junto
                scopes.__engine = r.scopes;
                respond(req, { scopes: scopes.map(({ __engine, ...rest }) => rest) });
                // guarda pro pedido de variables: locais/upvalues vêm embutidos
                lastScopes = r.scopes || [];
            }).catch(() => respondError(req, 'engine parada'));
            break;

        case 'variables': {
            const ref = req.arguments.variablesReference;
            // refs negativas são os escopos locais/upvalues que já vieram no scopes
            if (ref < 0 && lastScopes) {
                const scope = lastScopes[ref === -1 ? 0 : 1];
                respond(req, { variables: (scope && scope.variables) || [] });
                break;
            }
            sendEngine({ cmd: 'variables', ref }).then((r) => {
                respond(req, { variables: r.variables || [] });
            }).catch(() => respondError(req, 'engine parada'));
            break;
        }

        case 'continue':
            sendEngine({ cmd: 'continue' }).then(() => respond(req, { allThreadsContinued: true }))
                .catch(() => respondError(req, 'engine parada'));
            break;

        case 'next':
            sendEngine({ cmd: 'stepOver' }).then(() => respond(req))
                .catch(() => respondError(req, 'engine parada'));
            break;

        case 'stepIn':
            sendEngine({ cmd: 'stepInto' }).then(() => respond(req))
                .catch(() => respondError(req, 'engine parada'));
            break;

        case 'stepOut':
            sendEngine({ cmd: 'stepOut' }).then(() => respond(req))
                .catch(() => respondError(req, 'engine parada'));
            break;

        case 'evaluate':
            respondError(req, 'avaliação de expressões ainda não suportada');
            break;

        case 'pause':
            respondError(req, 'pause não suportado nesta versão');
            break;

        case 'disconnect':
            killChild();
            respond(req);
            process.exit(0);
            break;

        default:
            respondError(req, `comando não implementado: ${req.command}`);
    }
}
