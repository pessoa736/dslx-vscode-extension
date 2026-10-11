---@class (partial) element
---@field name string
---@field props table<string, any>
---@field childrens any[]

--- soma os childrens com a prop peso
---@param el element
---@return integer total
---@param el element
local function soma(el)
  local acc = 0
  for _, v in ipairs(el.childrens) do
    acc = acc + v
  end
  return acc + (el.props.peso or 0)
end

local peso_padrao = 9
local resultado = soma{name="soma", props={peso=peso_padrao}, childrens={1, 2, 3}}                                         
local nome = "davi"
print(resultado, nome)