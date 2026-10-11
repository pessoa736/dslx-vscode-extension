-- DSLX: Lua + XML — exemplo de fumaça da extensão
local function soma(element)
    local acc = 0
    for _, valor in ipairs(element.childrens) do
        acc = acc + valor
    end
    return acc + element.props.t
end

local pt = function(element) print(table.unpack(element.childrens)) end
-

pt{name="pt", props={}, childrens={soma{name="soma", props={t=9}, childrens={1, 2, 3}}}}

print("final do test")
