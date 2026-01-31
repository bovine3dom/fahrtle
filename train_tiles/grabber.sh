#!/bin/bash

cd data/
wget https://www.naturalearthdata.com/http//www.naturalearthdata.com/download/10m/cultural/ne_10m_railroads.zip 
unzip ne_10m_railroads.zip
ogr2ogr -f GeoJSON ne_10m_railroads.geojson ne_10m_railroads.shp 
rm -rf train_tiles
tippecanoe -e train_tiles -z8 -Z0 --no-tile-compression --coalesce-smallest-as-needed ne_10m_railroads.geojson
rm -rf ../../public/train_tiles
cp -r train_tiles/ ../../public/
