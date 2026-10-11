# DSLX — extensão pro VS Code

<div align="center">
    <img src="icon.png" width="128px" />
    <p>Suporte à linguagem <b>DSLX</b> (Davi System: Lua XML) no VS Code.</p>
    <a href="https://luarocks.org/modules/pessoa736/daviluaxml">
        <img src="https://img.shields.io/luarocks/v/pessoa736/daviluaxml" />
    </a>
</div>

> [!WARNING]
> Projeto experimental. A linguagem é o DSLX 2.x, cujas APIs podem mudar sem aviso.

## sumário

- [DSLX — extensão pro VS Code](#dslx--extensão-pro-vs-code)
  - [sumário](#sumário)
  - [o que a extensão faz](#o-que-a-extensão-faz)
  - [requisitos](#requisitos)
  - [instalação](#instalação)
    - [do marketplace](#do-marketplace)
    - [via .vsix (dev)](#via-vsix-dev)
  - [comandos](#comandos)
  - [debugger](#debugger)
  - [configuração](#configuração)
  - [como funciona por dentro](#como-funciona-por-dentro)
  - [limitações conhecidas](#limitações-conhecidas)
  - [licença](#licença)

## o que a extensão faz

- **highlight de `.dslx`**: o código Lua é realçado com a grammar de Lua embutida no VS Code, e os elementos XML são realçados como tags — com props de string (`titulo="olá"`), props de expressão (`largura={10}`), props booleanas (`destaque`) e children (texto literal, `{expressão}` e elementos aninhados).
- **snippets**: elemento completo, self-close, props, children de expressão e função componente.
- **DSLX: Compilar para Lua** — gera o `.lua` correspondente do lado do `.dslx` e abre no editor.
- **DSLX: Executar arquivo** — roda o `.dslx` num terminal integrado, com direito a `io.read()` e repasse de argumentos.
- **análise de erros** — ao digitar (com debounce) e ao salvar: parse com o parser real do DSLX 2.1 + compilação pra Lua. Como as regiões de Lua são copiadas verbatim, os números de linha do erro são mapeados de volta pro `.dslx`.
- **lua-language-server** — se instalado, o `.lua` compilado é analisado pelo [LuaLS](https://github.com/LuaLS/lua-language-server) e os diagnósticos (variáveis não definidas, atribuição a `<const>`, etc.) são remapeados pro `.dslx`.
- **debugger** — breakpoints, stepInto/Over/Out, stack trace e inspeção de variáveis (Locais, Upvalues e Globais, com expansão de tabelas), direto no `.dslx`. Veja [debugger](#debugger).
- **ambiente** — comando que mostra a versão do Lua, LPeg nativo vs LuLPeg, `package.path`, `import.path` e as variáveis de ambiente `LUA*`/`DSLX*` do processo; a config `dslx.env` injeta variáveis em todo processo Lua da extensão.
- **runtime embutido**: a extensão carrega consigo o parser/runtime/compile/import do DSLX 2.1. Se o seu Lua não tem LPeg, ela usa o [LuLPeg](https://github.com/pygy/lulpeg) (LPeg escrito em Lua puro) automaticamente — não precisa instalar nada além de um Lua 5.4+.

## requisitos

- Um interpretador **Lua 5.4+** no `PATH` (ou configure o caminho em `dslx.luaInterpreter`). LPeg **não** é obrigatório.
- Opcional: `lua-language-server` no `PATH` (para a análise avançada do `.lua` gerado).

## instalação

### do marketplace

(proximamente)

### via .vsix (dev)

```bash
git clone https://github.com/pessoa736/dslx-vscode-extension
cd dslx-vscode-extension
npx @vscode/vsce package
code --install-extension dslx-0.2.0.vsix
```

## comandos

| comando | o que faz |
| --- | --- |
| `DSLX: Compilar para Lua` | compila o `.dslx` ativo (ou o selecionado no explorer) e abre o `.lua` gerado |
| `DSLX: Executar arquivo` | executa o `.dslx` no terminal integrado |
| `DSLX: Analisar arquivo` | parse + compilação + lua-language-server, marcando os problemas no editor |
| `DSLX: Mostrar ambiente` | versões, LPeg, paths e variáveis de ambiente no output `DSLX` |

Os comandos aparecem na paleta de comandos (com um `.dslx` aberto) e no menu de contexto do explorer (botão direito num `.dslx`).

Também dá pra usar o runner direto da CLI, sem VS Code:

```bash
lua runtime/dslx_runner.lua compile examples/hello.dslx   # gera hello.lua
lua runtime/dslx_runner.lua run examples/hello.dslx     # compila em memória e executa
lua runtime/dslx_runner.lua check examples/hello.dslx   # diagnóstico em JSON
lua runtime/dslx_runner.lua env                         # ambiente em JSON
```

## debugger

Crie um launch config (`launch.json`) ou use o snippet:

```json
{
    "name": "DSLX: depurar arquivo atual",
    "type": "dslx",
    "request": "launch",
    "program": "${file}",
    "stopOnEntry": false
}
```

Na hora do launch, o `.dslx` é compilado pra `.lua`, as linhas são mapeadas, e os breakpoints que você põe no `.dslx` param na linha certa do código gerado. A janela de variáveis mostra Locais, Upvalues e Globais da frame, com tabelas expansíveis. Breakpoints em linhas de Lua puro funcionam; linhas que só existem no gerado (construct de tag numa linha colapsada) ficam sem mapeamento e são reportadas como não-verificadas.

## configuração

| opção | default | descrição |
| --- | --- | --- |
| `dslx.luaInterpreter` | `"lua"` | interpretador Lua usado pra compilar/executar (comando do PATH ou caminho absoluto) |
| `dslx.env` | `{}` | variáveis de ambiente injetadas em todo processo Lua (compile/run/analyze/debug) |
| `dslx.analysis.enable` | `true` | análise automática (parse + compilação) ao digitar/salvar |
| `dslx.analysis.useLuaLanguageServer` | `true` | usar o LuaLS no `.lua` compilado e mapear de volta pro `.dslx` |
| `dslx.analysis.luaLanguageServerPath` | `"lua-language-server"` | caminho do binário LuaLS |

## como funciona por dentro

- `syntaxes/dslx.tmLanguage.json` — grammar TextMate que mistura a grammar de Lua (`source.lua`) com uma regra recursiva de elemento DSLX. As tags só são realçadas como elemento quando fazem sentido sintático: `<` precedido de identificador, aspa ou chave é tratado como operador de comparação de Lua, e `<const>`/`<close>` (atributos do Lua 5.4+) nunca viram tag.
- `runtime/` — cópia vendada do módulo `dslx` 2.1 (`parser.lua`, `runtime.lua`, `compile.lua`, `import.lua`, `readFile.lua`) + `lulpeg.lua` + `dslx_runner.lua` (a CLI que a extensão chama: compile/run/check/env).
- `runtime/debugger.lua` — engine de depuração em Lua puro usando `debug.sethook` por linha; fala JSONL pelo stdin/stdout.
- `src/dap/adapter.js` — Debug Adapter (protocolo DAP) que traduz VS Code ⇄ engine, compila o alvo e mapeia linhas `.dslx` ⇄ `.lua` em ambas as direções (`src/linemap.js`).
- `src/extension.js` — cola as peças: comandos, diagnósticos, LuaLS, ambiente e registro do provider de debug.

## limitações conhecidas

- A grammar não valida se a tag de fechamento bate com a de abertura (`</errado>` fecha qualquer tag aberta) — mesma limitação das grammars de JSX.
- `<const>` e `<close>` nunca são realçados como tag, mesmo se você quiser um componente com esses nomes.
- Expressões `{...}` com `<`/`>` de comparação dentro (ex.: `{a < b}`) não são realçadas como prop/children — o elemento inteiro cai no highlight de Lua. O parser real aceita; é só o highlight que degrada.
- Comparação sem espaço tipo `a<b` segue como Lua (guarda contra falso positivo).
- O parser do DSLX 2.1 é leniente: um elemento que não fecha vira texto Lua verbatim (e pode até virar Lua "válido" por acaso). O diagnóstico pega a maioria dos casos, mas não todos.
- O debugger ainda não suporta watch/evaluate de expressões, breakpoints condicionais nem pause — só breakpoints de linha, stepping e inspeção de variáveis.

## licença

MIT — igual ao [DSLX](https://github.com/pessoa736/DLuaXML). O LuLPeg embutido é [Romantic WTF Public License](https://github.com/pygy/lulpeg/blob/master/LICENSE).
