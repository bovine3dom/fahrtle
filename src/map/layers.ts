import maplibregl from 'maplibre-gl';
import { interpolateSpectral, hsl } from 'd3';
import { map_update_lock } from '../utils/map_lock';
import { getBeforeId } from '../utils/layer_order';
import { give_me_more_trains } from '../utils/i_bloody_love_trains';

export const getCrowKmColor = (crowKm: number): string => {
  const normalized = Math.sqrt(Math.max(crowKm / 200, 0));
  return interpolateSpectral(normalized);
};

const basemapSettingToStyle = (setting: string): string | maplibregl.StyleSpecification => {
  switch (setting) {
    case 'Transport dark':
    case 'Transport':
    case 'Positron':
      return "https://tiles.openfreemap.org/styles/positron"
    case 'Bright':
      return "https://tiles.openfreemap.org/styles/bright"
    case 'Toner-like':
      return "./toner_ofm.json"
    case 'OSM Carto':
      return {
        'version': 8,
        'sources': {
          'raster-tiles': {
            'type': 'raster',
            'tiles': [
              'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            ],
            'tileSize': 128,
            'attribution':
              '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>'
          }
        },
        'layers': [
          {
            'id': 'simple-tiles',
            'type': 'raster',
            'source': 'raster-tiles',
            'minzoom': 0,
            'maxzoom': 22
          }
        ]
      }
    case 'Liberty (3D)':
      return "https://tiles.openfreemap.org/styles/liberty"
    case 'Virtual Earth':
      return {
        'version': 8,
        'sources': {
          'raster-tiles': {
            'type': 'raster',
            'tiles': [
              'https://tiles.virtualearth.net/tiles/a{quadkey}.jpg?g=45',
            ],
            'maxzoom': 17,
            'tileSize': 128,
            'attribution':
              '<a href="https://en.wikipedia.org/wiki/Microsoft_Virtual_Earth" target="_blank">&copy; Microsoft Virtual Earth</a>'
          }
        },
        'layers': [
          {
            'id': 'simple-tiles',
            'type': 'raster',
            'source': 'raster-tiles',
            'minzoom': 0,
          }
        ]
      }
    default:
      return "https://tiles.openfreemap.org/styles/positron"
  }
}

export async function updateBasemap(map: maplibregl.Map, setting: string) {
  const unlock = await map_update_lock.lock();
  try {
    const styleSpec = basemapSettingToStyle(setting);
    const existingLayers = map.getStyle()?.layers;
    const existingSources = map.getStyle()?.sources;
    for (const layer of existingLayers) { if (layer.id.startsWith('basemap-')) map.removeLayer(layer.id); }
    for (const sourceId in existingSources) { if (sourceId.startsWith('basemap-')) map.removeSource(sourceId); }

    if (typeof styleSpec === 'string') {
      try {
        const response = await fetch(styleSpec);
        const style = await response.json();
        give_me_more_trains(style);
        style.glyphs && map.setGlyphs(style.glyphs);
        style.sprite && map.setSprite(style.sprite);
        for (const [sourceId, source] of Object.entries(style.sources)) map.addSource(`basemap-${sourceId}`, source as any);
        for (const layer of style.layers) {
          map.addLayer({ ...layer, id: `basemap-${layer.id}`, source: layer.source ? `basemap-${layer.source}` : undefined }, getBeforeId(`basemap-${layer.id}`, map));
        }
      } catch (err) { console.error('[Map] Failed to fetch basemap style:', err); }
    } else {
      const sourceKey = Object.keys(styleSpec.sources)[0];
      map.addSource(`basemap-${sourceKey}`, styleSpec.sources[sourceKey] as any);
      map.addLayer({ ...styleSpec.layers[0], id: `basemap-${styleSpec.layers[0].id}`, source: `basemap-${sourceKey}` } as any, getBeforeId(`basemap-${styleSpec.layers[0].id}`, map));
    }
  } finally { unlock(); }
}

export async function updateRailwaysLayer(map: maplibregl.Map, setting: string) {
  const unlock = await map_update_lock.lock();
  try {
    const pathMap: Record<string, string | null> = { 'Infrastructure': '/standard/', 'Speed': '/maxspeed/', 'Electrification': '/electrification/', 'Gauge': '/gauge/', 'Disabled': null };
    const path = pathMap[setting];
    const layerExists = !!map.getLayer('openrailwaymap-layer');
    const sourceExists = !!map.getSource('openrailwaymap');

    if (path === null) {
      if (layerExists) map.setLayoutProperty('openrailwaymap-layer', 'visibility', 'none');
    } else {
      if (layerExists) map.removeLayer('openrailwaymap-layer');
      if (sourceExists) map.removeSource('openrailwaymap');
      map.addSource('openrailwaymap', { type: 'raster', tiles: [`https://tiles.openrailwaymap.org${path}{z}/{x}/{y}.png`], tileSize: 256, attribution: '&copy; <a href="https://www.openrailwaymap.org">OpenRailwayMap</a>' });
      map.addLayer({ id: 'openrailwaymap-layer', type: 'raster', source: 'openrailwaymap', paint: { 'raster-opacity': 1 } }, getBeforeId("openrailwaymap-layer", map));
    }
  } finally { unlock(); }
}

export async function updateTransportLayer(map: maplibregl.Map, setting: string) {
  const unlock = await map_update_lock.lock();
  try {
    const sourceId = 'public-transport';
    if (!setting) {
      map.getStyle().layers.filter(l => l.id.startsWith(`${sourceId}-`)).forEach(l => map.removeLayer(l.id));
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      return;
    }
    const style = await fetch('./public_transport.json').then(r => r.json());
    style.layers.forEach((l: any) => { if (map.getLayer(`${sourceId}-${l.id}`)) map.removeLayer(`${sourceId}-${l.id}`); });
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    map.addSource(sourceId, style.sources.openmaptiles as any);
    for (const layer of style.layers) map.addLayer({ ...layer, id: `${sourceId}-${layer.id}`, source: sourceId }, getBeforeId(`${sourceId}-${layer.id}`, map));
  } finally { unlock(); }
}

export async function updateBathymetryLayer(map: maplibregl.Map, setting: boolean) {
  const unlock = await map_update_lock.lock();
  try {
    if (map.getLayer('water-bathymetry')) map.removeLayer('water-bathymetry');
    if (map.getLayer('water-hillshade')) map.removeLayer('water-hillshade');
    if (map.getLayer('water-contours')) map.removeLayer('water-contours');
    if (map.getSource('seascape-dem')) map.removeSource('seascape-dem');
    if (map.getSource('seascape')) map.removeSource('seascape');
    if (!setting) return;

    map.addSource('seascape', { type: 'vector', url: 'https://tiles.openwaters.io/seascape/vector.json', attribution: "" })
    map.addSource('seascape-dem', { type: 'raster-dem', url: 'https://tiles.openwaters.io/seascape/raster.json', attribution: "<a href='https://openwaters.io/charts/seascape#sources' target='_blank'>&copy; Open Water Software et al.</a>" })
    const baseColorValue = (map.getStyle().layers.find(layer => layer.id === 'basemap-water')?.paint as any)?.['fill-color'] || "#b3dbe6";
    const colorString: string = Array.isArray(baseColorValue) ? "#b3dbe6" : baseColorValue as any;
    const isRaster = baseColorValue === '#b3dbe6';
    const baseHsl = hsl(colorString);
    const isDark = baseHsl.l < 0.5;
    const stops = [-9500, -9000, -8500, -8000, -7500, -7000, -6500, -6000, -5500, -5000, -4500, -4000, -3500, -3000, -2500, -2000, -1750, -1500, -1250, -1000, -750, -500, -250, -200, -100, -50, -25];
    const extremeLightness = isDark ? 0.95 : 0.05;
    const fillColorExpression: any[] = ["interpolate", ["linear"], ["elevation"], -10000, isDark ? "#ffffff" : "#000000"];
    stops.forEach((depth, index) => {
      const t = index / (stops.length - 1);
      let stepHsl = hsl(baseHsl.toString());
      if (isDark) stepHsl.l = extremeLightness - (extremeLightness - baseHsl.l) * t;
      else stepHsl.l = 0.95 - (0.95 - baseHsl.l) * t;
      fillColorExpression.push(depth, stepHsl.formatHex());
    });
    fillColorExpression.push(-24, "rgba(0,0,0,0)");
    map.addLayer({ id: 'water-bathymetry', type: 'color-relief', source: 'seascape-dem', paint: { "color-relief-color": fillColorExpression as any, "color-relief-opacity": isRaster ? 0.5 : 1 } }, getBeforeId("water-bathymetry", map));
    map.addLayer({ id: 'water-hillshade', type: 'hillshade', source: 'seascape-dem', paint: {
        "hillshade-exaggeration": 0.1,
        "hillshade-shadow-color": "#473b24",
        "hillshade-highlight-color": "#ffffff",
        "hillshade-accent-color": "#000000"
    } }, getBeforeId("water-hillshade", map));
    map.addLayer({ id: 'water-contours', type: 'line', source: 'seascape', 'source-layer': 'contours', "paint": { "line-color": "#000000", "line-width": 0.5, "line-opacity": 0.5 }}, getBeforeId('water-contours', map));
  } finally { unlock(); }
}

export async function updateHillShadeLayer(map: maplibregl.Map, setting: boolean) {
  const unlock = await map_update_lock.lock();
  try {
    if (map.getLayer('mapterhorn-layer')) map.removeLayer('mapterhorn-layer');
    if (map.getSource('mapterhorn')) map.removeSource('mapterhorn');
    if (!setting) return;
    map.addSource('mapterhorn', { type: 'raster-dem', url: 'https://tiles.mapterhorn.com/tilejson.json', maxzoom: 15 });
    map.addLayer({ id: 'mapterhorn-layer', type: 'hillshade', source: 'mapterhorn', paint: { 'hillshade-shadow-color': '#000', 'hillshade-highlight-color': '#fff', 'hillshade-accent-color': '#fff', 'hillshade-exaggeration': 0.1, 'hillshade-method': 'igor' } }, getBeforeId("mapterhorn-layer", map));
  } finally { unlock(); }
}

export async function updateTerrain(map: maplibregl.Map, setting: boolean) {
  const unlock = await map_update_lock.lock();
  try {
    if (!setting) {
      map.setTerrain(null);
      if (map.getSource('mapterhorn-3d')) map.removeSource('mapterhorn-3d');
      return;
    }
    if (!map.getSource('mapterhorn-3d')) map.addSource('mapterhorn-3d', { type: 'raster-dem', url: 'https://tiles.mapterhorn.com/tilejson.json', maxzoom: 15 });
    map.setTerrain({ source: 'mapterhorn-3d', exaggeration: 3 });
  } finally { unlock(); }
}
