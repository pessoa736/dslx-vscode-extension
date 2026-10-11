--- componente que soma os childrens com o peso da prop
local function soma(el)
  local total <const> = 0
  for _, v in ipairs(el.childrens) do
    total = total + v
  end
  return total + el.props.peso
end

local peso_config <const> = 9
local resultado = 0

soma{name="soma", props={peso=peso_config}, childrens={1, 2, 3, "\n"}}                         
           
       

print(resultado)