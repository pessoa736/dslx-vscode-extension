# Changelog

## 0.7.0

- **hints nos constructs XML**: as tags agora mostram visualmente o que recebem e o que retornam — `→ string` no fim do construct (retorno da função-tag, com tooltip da assinatura completa), e `: tipo` após cada prop (`titulo: string`, `largura: any`, `destaque: boolean`), ancorados na posição exata de cada prop no XML
- **fix: inlay hints sombrios**: o range do request pro LuaLS truncava quando `endLine` passava do fim do arquivo (o fallback de linha devolvia posição ANES dos hints) — hints normais (`: integer` em vars, `: element` em params) voltam pra todos os lugares
- hints sintéticos (retorno/props) são marcados `synthetic` e o extension.js pinta como `InlayHintKind.Type` — mesma cor de comentário do tema

## 0.6.2

- **cores das anotações emmylua**: comando `DSLX: Aplicar cores nas anotações de tipo` — injeta `tokenColorCustomizations` no settings do usuário (merge, reversível) pintando `@param`/`@return`/`@class`, tipos e nomes; detecta temas Monokai (que não pintam esses escopos) e oferece na primeira abertura de `.dslx`
- grammar emite os escopos corretos (`storage.type.annotation.lua`, `support.type.lua`, `support.class.lua`, `entity.name.variable.lua`) — validado no engine vscode-textmate

## 0.6.1

- **fix: anotações emmylua do usuário aparecem de verdade**: `---@param el element` é REESCRITO no shadow com o tipo enriquecido da tag (props tipadas), preservando doc comments e `@return`; classe própria (`@param el CardOpts`) fica intocada; ordem da injeção do `@param` sintético corrigida (vinha depois da declaração)

## 0.6.0

- **machine-agnostic**: nenhum path fixo de máquina — o resolvedor de lua-language-server (`src/servermanager.js`) usa config → storage da extensão → PATH → binário bundled de qualquer extensão instalada → **auto-download da release oficial** (com consentimento, pro globalStorage da DSLX; nada é instalado no sistema)
- **zero-setup**: highlight, snippets, compile, run, check, formatter, debugger e autocomplete básico funcionam só com um Lua 5.4+ (LuLPeg embutido). hover com tipos, diagnósticos semânticos e inlay hints usam o LuaLS — se não tiver, a extensão oferece baixar em 1 clique
- **props tipadas nos elements**: pré-scan dos usos de cada tag gera `---@class <tag>_props` com o tipo de cada prop (`titulo="x"` → string, `{expr}` → tipo, bare → boolean); o `@param` sintético da função-tag recebe `{name, props:<tag>_props, childrens}` — hover em `el.props.titulo` mostra `(field) card_props.titulo: string`
- **fix: tipo por cima do nome do element** — inlay hints de parâmetro (`el:`) em linha de construct são descartados (não existem na sintaxe XML); hints dentro do construct também; só hints antes do `<` mapeiam
- **fix: regressão do @return** — `@param` sintético não é mais injetado quando a função já tem anotações EmmyLua próprias (duplicado quebrava a inferência do `@return` do usuário)
- limpeza: caches `.dslx-shadow/`, `hello.lua` gerado e `.vscode/` fora do repo; `.vscodeignore` atualizado
- hover da tag sem anotação própria agora mostra assinatura completa com o tipo do element e retorno inferido

## 0.5.0

- **tipo do retorno na variável**: funções usadas como tag ganham `---@param el element` sintético no shadow (com `---@class element` no preâmbulo), então o LuaLS infere e propaga o retorno — `local resultado = <soma peso={9}/>` mostra `local resultado: integer` no hover quando a função tem `---@return` (anotações EmmyLua escritas no próprio `.dslx` passam pro shadow e funcionam)
- **inlay hints estilo rust-analyzer**: tipos de variáveis locais, tipos de parâmetros e labels de chamada via `textDocument/inlayHint`, com posições remapeadas pro `.dslx` — o VS Code pinta na cor de comentário automaticamente (categoria type)
- **integração com sumneko.lua**: detecção automática do lua-language-server bundled da extensão `sumneko.lua` quando `dslx.analysis.luaLanguageServerPath` tá vazio
- **integração com luarocks**: tree local (`lua_modules/`, `.luarocks/`) entra no `workspace.library` do `.luarc.json` — tipos dos módulos instalados resolvem nos `.dslx`
- `.luarc.json` escrito no workspace (merge, sem sobrescrever config do usuário) com `hint.*`, `diagnostics.globals += is_element`
- **debug console com ambiente**: o launch de debug imprime interpretador, programa, `.lua` de debug e nº de linhas mapeadas
- **debug não polui o projeto**: o `.lua` de debug vai pra `.dslx-debug/` (gitignored) em vez de colar do lado do `.dslx`
- hover enriquecido: hover fraco (`unknown`) numa var que recebe tag mostra a assinatura da função-tag junto
- correções de mapeamento: off-by-one do preâmbulo do shadow, linha de construct via lineMap, `preambleLines` contado por newlines

## 0.4.0

- **hover com lua-language-server de verdade**: middleware LSP (`src/lsp.js`) que abre o `.dslx` pro LuaLS via **shadow transform** (`src/shadow.js`) — o construct `<card titulo="olá">` vira a chamada `card{name="card", props={titulo="olá"}, childrens={...}}` nas MESMAS posições, então hover, diagnósticos e completion voltam com tipo inferido real (`local total <const>: integer = 0`) e mapeados 1:1 pro `.dslx`; blocos `{expr}` mapeiam por tabela de offsets
- **variáveis/watch no debugger**: `evaluate` na engine (locals da frame como parâmetros + `_ENV` → `_G`) exposto no DAP — Watch, REPL, Debug Console e hover-de-variável-na-parada funcionam (`supportsEvaluateForHovers: true`)
- **fix completion em declaração**: `local ab|`, `function f(ab|`, `for k|` não sugerem mais identificadores existentes
- **completion semântico**: merge das sugestões do LuaLS (escopo real) com o engine contextual local
- **code formatting**: `Shift+Alt+F` re-indenta funções e constructs aninhados (zero dependências, idempotente)
- diagnóstico agora em tempo real: o proxy LuaLS fica vivo e publica ao digitar (não spawn por save)

## 0.3.0

- **autocomplete**: engine contextual puro em `src/completion.js` + provider registrado — sugere elementos/componentes (funções + tags usadas) depois de `<`, props vistas da tag nos atributos, variáveis/parâmetros/funções/keywords/globais Lua dentro de expressões `{...}`, membros do elemento (`el.name/props/childrens`), chaves de props vistas (`el.props.|`) e membros das libs padrão (`string.`, `table.`…), com snippets de for/if/pcall
- **hover**: assinatura de funções (marcando componente de 1 arg), variáveis (local/global/parâmetro), tags (usos + props vistas) e globais Lua
- **signature help**: parâmetros da função sob o cursor com o parâmetro ativo destacado
- scanner de símbolos: funções, variáveis (incluindo `<const>`/`<close>`), parâmetros, tags e props com tipos inferidos (string/block/bool)

## 0.2.0

- **análise de erros**: parser real + `load()` do gerado ao digitar (debounce) e ao salvar; posição do erro mapeada de volta pro `.dslx` (comando `DSLX: Analisar arquivo` e modo `check` do runner)
- **lua-language-server**: `--check` com saída JSON no `.lua` compilado, linhas remapeadas pro `.dslx` (config `dslx.analysis.*`)
- **debugger DAP**: breakpoints no `.dslx` (mapeados pro `.lua` gerado), stepInto/Over/Out, stack trace, Locais/Upvalues/Globais com expansão de tabelas; launch `"type": "dslx"` (`src/dap/adapter.js` + `runtime/debugger.lua` com `debug.sethook`)
- **ambiente**: comando `DSLX: Mostrar ambiente` — versão do Lua, LPeg nativo vs LuLPeg, `package.path`, `import.path`, variáveis `LUA*`/`DSLX*`; config `dslx.env` injeta variáveis em todo processo Lua; modo `env` do runner
- correções: formato de erro do Lua 5.5 (sem o `]:`), base dinâmica das frames da engine de debug, ack de fluxo continue/step, `for in` const do Lua 5.5 no runner

## 0.1.0

- grammar TextMate `source.dslx`: elementos DSLX aninhados + scripts `{...}` + highlight de Lua via `source.lua`, com guardas pra comparações e `<const>`/`<close>`
- language configuration: comentários `--`/`--[[ ]]`, auto-close, indentação com regras de tag
- snippets: elemento completo, self-close, props (string/expressão), children de expressão, função componente
- comandos `dslx.compile` e `dslx.run` (paleta + menu de contexto do explorer)
- runtime DSLX 2.1 vendado + LuLPeg como fallback de LPeg
- ícones light/dark, exemplos e README
