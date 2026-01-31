# build train tiles
from https://www.naturalearthdata.com/downloads/10m-cultural-vectors/railroads/ 

grab https://www.naturalearthdata.com/http//www.naturalearthdata.com/download/10m/cultural/ne_10m_railroads.zip 

unzip, ogr2ogr, tippecanoe

(just run grabber.sh)

nb: vite's dev server doesn't ever give 404s (why would anyone want that) so expect some insane errors where maplibre is trying to render index.html as a tile
