function relation_scan_function()
    local type = Find("type")
    if type == "route" or type == "route_master" then
        Accept()
    end
end

function node_function()
    -- local highway = Find("highway")
    -- local railway = Find("railway")
    -- local pt = Find("public_transport")
    -- local amenity = Find("amenity")

    -- if highway == "bus_stop" or railway == "station" or railway == "stop" or railway == "halt" or pt == "station" or pt == "stop_position" or amenity == "ferry_terminal" then
    --     Layer("public_transport_stops", false)
    --     Attribute("name", Find("name"))
    --     Attribute("network", Find("network"))
    --     Attribute("operator", Find("operator"))
    --     Attribute("ref", Find("ref"))
        
    --     if railway == "station" or pt == "station" or amenity == "ferry_terminal" then
    --         Attribute("stop_type", "station")
    --     else
    --         Attribute("stop_type", "stop")
    --     end
    -- end
end

function way_function()
    local railway = Find("railway")
    local pt = Find("public_transport")
    local highway = Find("highway")

    if railway == "abandoned" or railway == "disused" or Find("abandoned:railway") ~= "" or Find("disused:highway") ~= "" then
        return
    end

   if pt == "platform" or highway == "platform" or railway == "platform" then
       -- Layer("public_transport_platforms", true) 
       -- Attribute("name", Find("name"))
       -- Attribute("layer", Find("layer"))
       return
   end

    if railway == "rail" or railway == "subway" or railway == "tram" or railway == "light_rail" or railway == "funicular" or railway == "narrow_gauge" then
        -- Layer("public_transport_tracks", false)
        -- Attribute("railway", railway)
        -- Attribute("tunnel", Find("tunnel"))
        -- Attribute("layer", Find("layer"))
    end
    
    local is_transit = false
    local route_type = ""
    local route_network = ""
    local route_color = ""
    local refs_table = {}
    local best_dist_class = "local"
    local dist_hierarchy = {["long"] = 3,
        ["regional"] = 2,
        ["local"] = 1
    }
    local best_dist_rank = 0

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
        local operator = FindInRelation("operator")
        local is_flixbus = (string.find(string.lower(operator), "flixbus") ~= nil) -- they insist on calling themselves buses when they're coaches
        local r_type = FindInRelation("route")
        local current_rank = hierarchy[r_type] or 0

        if current_rank > 0 then
            is_transit = true
            
            local ref = FindInRelation("ref")
            if ref ~= "" then refs_table[ref] = true end
            local service = FindInRelation("service")
            local passenger = FindInRelation("passenger")
            local net_type = FindInRelation("network:type")
            local current_dist_class = "local"

            if is_flixbus then
                current_dist_class = "long"
                r_type = "coach" 
            elseif service == "international" or service == "national" or service == "long_distance" or service == "night" then
                current_dist_class = "long"
            elseif service == "regional" or passenger == "regional" then
                current_dist_class = "regional"
            elseif passenger == "suburban" then
                current_dist_class = "local"
            -- only fall back to network type if passenger/service is not set
            elseif net_type == "international" or net_type == "national" then
                current_dist_class = "long"
            elseif net_type == "regional" then
                current_dist_class = "regional"
            elseif r_type == "coach" or r_type == "ferry" then
                current_dist_class = "long"
            end

            local current_dist_rank = dist_hierarchy[current_dist_class] or 1
            if current_dist_rank > best_dist_rank then
                best_dist_rank = current_dist_rank
                best_dist_class = current_dist_class
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

    if route_color ~= "" then
        local clean_color = string.lower(route_color)
        if clean_color == "#000000" or clean_color == "#000" or clean_color == "000000" or clean_color == "black" or clean_color == "none" then
            route_color = ""
        end
        if route_color ~= "" and string.len(route_color) == 6 and not string.match(route_color, "^#") then
            if string.match(route_color, "^[0-9a-fA-F]+$") then
                route_color = "#" .. route_color
            end
        end
    end

    if is_transit then
        Layer("public_transport_routes_" .. route_type, false)
        Attribute("route", route_type)
        Attribute("distance", best_dist_class)
        Attribute("ref", route_ref)
        Attribute("network", route_network)
        Attribute("colour", route_color)
        Attribute("name", Find("name"))
        Attribute("tunnel", Find("tunnel"))
        Attribute("bridge", Find("bridge"))
        Attribute("layer", Find("layer"))

        if best_dist_class == "long" then
            if route_type == "ferry" then MinZoom(4) else MinZoom(5) end
        elseif best_dist_class == "regional" then
            if route_type == "train" then MinZoom(7) else MinZoom(8) end
        else
            if route_type == "train" then 
                MinZoom(10)
            elseif route_type == "subway" or route_type == "light_rail" or route_type == "tram" then 
                MinZoom(11)
            else 
                MinZoom(12)
            end
        end
    end
end

function relation_function()
end
