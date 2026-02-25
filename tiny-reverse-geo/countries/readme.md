grab from https://www.naturalearthdata.com/http//www.naturalearthdata.com/download/10m/cultural/

ignore the one that talks about lakes

```bash
7z x ne_10m_admin_0_countries.zip
ogr2ogr -f GeoJSON ne_10m_admin_0_countries.{geojson, shp}
# https://github.com/bovine3dom/geojson2h3
# you probably need to go in and disable zstd compression
julia +1.9.4 --project=. --threads auto geojson2h3.jl -r 5 -k'ISO_A2_EH' --compact ne_10m_admin_0_countries.geojson ne_10m_admin_0_countries.arrow
```

```clickhouse
# clickhouse-local
select * from file('ne_10m_admin_0_countries.arrow') order by h3 asc into outfile 'ne_10m_admin_0_countries.asc.arrow' format arrow
settings output_format_arrow_compression_method = 'none'
```
