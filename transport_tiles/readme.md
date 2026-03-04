```
paru -S osmium-tools
wget https://download.geofabrik.de/europe/monaco-latest.osm.pbf
# or wget https://planet.osm.org/pbf/planet-latest.osm.pbf

osmium tags-filter monaco-latest.osm.pbf \
  r/route=bus,coach,trolleybus,share_taxi,train,subway,tram,light_rail,monorail,funicular,ferry \
  r/route_master=bus,coach,trolleybus,share_taxi,train,subway,tram,light_rail,monorail,funicular,ferry \
  nwr/public_transport=station,stop_position,platform \
  nwr/railway=station,tram_stop,halt \
  nwr/highway=bus_stop \
  nwr/amenity=bus_station,ferry_terminal \
  w/railway=rail,subway,tram,light_rail,monorail,funicular,narrow_gauge \
  -o transit_only.osm.pbf

osmium export transit_only.osm.pbf -o monaco_transit.geojson
tilemaker --input transit_only.osm.pbf --config config.json --process process.lua --output out.pmtiles
```

osmium takes 30 minutes to do the planet on the server. tilemaker takes about 5 minutes on my machine.
