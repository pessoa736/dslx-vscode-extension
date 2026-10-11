# Changelog

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
