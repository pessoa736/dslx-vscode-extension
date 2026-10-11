---@class (partial) element
---@field name string
---@field props table<string, any>
---@field childrens any[]

---@param el element
---@return integer total
---@param el element
local function soma(el)
  return 1
end
local resultado = soma{name="soma", props={peso=9}, childrens={}}                
print(resultado)