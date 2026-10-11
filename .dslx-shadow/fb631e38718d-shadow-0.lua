


-- props: string, expressão e boolean; children: texto, expressão e elemento aninhado
local function card(el)
    local props <const> = el.props
    local partes = {}
    for k, v in pairs(props) do
        partes[#partes + 1] = k .. "=" .. tostring(v)
    end
    return el.name .. "[" .. table.concat(partes, ", ") .. "]"
end


local c1 = 
    card{name="card", props={titulo="olá", largura=10, destaque=true}, childrens={"\n        texto \n        ", 40 + 2, "\n    "}}      
                     
                     
                
     
              
                
           

print(c1)
print(card{name="card", props={titulo="tchau"}, childrens={}}                      )
