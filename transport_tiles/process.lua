function relation_scan_function()
    local type = Find("type")
    if type == "route" or type == "route_master" then
        Accept()
    end
end

function node_function()
    local highway = Find("highway")
    local railway = Find("railway")
    local pt = Find("public_transport")
    local amenity = Find("amenity")

    if highway == "bus_stop" or railway == "station" or railway == "stop" or railway == "halt" or pt == "station" or pt == "stop_position" or amenity == "ferry_terminal" then
        Layer("public_transport_stops", false)
        Attribute("name", Find("name"))
        Attribute("network", Find("network"))
        Attribute("operator", Find("operator"))
        Attribute("ref", Find("ref"))
        
        if railway == "station" or pt == "station" or amenity == "ferry_terminal" then
            Attribute("stop_type", "station")
        else
            Attribute("stop_type", "stop")
        end
    end
end

function way_function()
    local railway = Find("railway")
    local pt = Find("public_transport")
    local highway = Find("highway")

    if railway == "abandoned" or railway == "disused" or Find("abandoned:railway") ~= "" or Find("disused:highway") ~= "" then
        return
    end

    if pt == "platform" or highway == "platform" or railway == "platform" then
        Layer("public_transport_platforms", true) 
        Attribute("name", Find("name"))
        Attribute("layer", Find("layer"))
        return
    end

    if railway == "rail" or railway == "subway" or railway == "tram" or railway == "light_rail" or railway == "funicular" or railway == "narrow_gauge" then
        Layer("public_transport_tracks", false)
        Attribute("railway", railway)
        Attribute("tunnel", Find("tunnel"))
        Attribute("layer", Find("layer"))
    end
    
    local is_transit = false
    local route_type = ""
    local route_network = ""
    local route_color = ""
    local refs_table = {}

    -- todo: make these visible at different zoom levels?
    local hierarchy = {
        ["ferry"] = 7,
        ["train"] = 6,
        ["light_rail"] = 5,
        ["subway"] = 4,
        ["tram"] = 3,
        ["coach"] = 2,
        ["bus"] = 1
    }
    local best_rank = 0

    while NextRelation() do
        local r_type = FindInRelation("route")
        local current_rank = hierarchy[r_type] or 0

        if current_rank > 0 then
            is_transit = true
            
            local ref = FindInRelation("ref")
            if ref ~= "" then
                refs_table[ref] = true
            end

            if current_rank > best_rank then
                best_rank = current_rank
                route_type = r_type
                route_network = FindInRelation("network")
                route_color = FindInRelation("colour")
            end
        end
    end

    local final_refs = {}
    for r, _ in pairs(refs_table) do
        table.insert(final_refs, r)
    end
    table.sort(final_refs) 
    local route_ref = table.concat(final_refs, ", ")

    if is_transit then
        Layer("public_transport_routes", false)
        Attribute("route", route_type)
        Attribute("ref", route_ref)
        Attribute("network", route_network)
        Attribute("colour", route_color)
        Attribute("name", Find("name"))
    end
end

function relation_function()
end
