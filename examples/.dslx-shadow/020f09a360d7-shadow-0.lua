---@class (partial) element
---@field name string
---@field props table<string, any>
---@field childrens any[]

--- soma
---@param el element
---@return integer
---@param el element
local function soma(el)
  local acc = 0
  return acc + el.props.x
end

local numero = 42
local s = soma{name="soma", props={x=1}, childrens={}}             
print(numero, s)