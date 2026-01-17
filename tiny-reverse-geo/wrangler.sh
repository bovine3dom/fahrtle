#!/bin/bash
wget https://download.geonames.org/export/dump/cities15000.zip
7za x cities15000.zip
mv cities15000.txt cities15000.tsv
sed -i '1i geonameid\tname\tasciiname\talternatenames\tlatitude\tlongitude\tfeature_class\tfeature_code\tcountry_code\tcc2\tadmin1_code\tadmin2_code\tadmin3_code\tadmin4_code\tpopulation\televation\tdem\ttimezone\tmodification_date' cities15000.txt
echo -n "[" > tiny-cities.json
qsv select 'name,latitude,longitude,population' cities15000.tsv | qsv sort --reverse --numeric --select 'population' | qsv select 'name,latitude,longitude' | head -n10000 | qsv tojsonl | head -c -1 | tr '\n' ',' >> tiny-cities.json
echo "]" >> tiny-cities.json
