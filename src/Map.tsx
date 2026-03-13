import { onMount, onCleanup, createEffect, createMemo, createSignal, untrack, Show, For } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { useStore } from '@nanostores/solid';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { $players, submitWaypoint, $departureBoardResults, $clock, $stopTimeZone, $playerTimeZone, $myPlayerId, $previewRoute, $boardMinimized, $playerSpeeds, $playerDistances, $pickerMode, $pickedPoint, $gameBounds, $roomState, $gameStartTime, finishRace, $globalRate, $isFollowing, type DepartureResult, submitWaypointsBatch, $mapZoom, $lastClickContext, $playerSettings, updatePlayerStats, submitGhostWaypoints, $currentDailyRaceIndex, $departureBoardPage, $departureBoardLoadingMore, $departureBoardHasMore, $boardMode, $pings, sendPing } from './store';
import { getServerTime } from './time-sync';
import { playerPositions } from './playerPositions';
import { latLngToCell, cellToBoundary, gridDisk } from 'h3-js';
import { chQuery } from './clickhouse';
import { getTimeZone } from './timezone';
import { getRouteEmoji } from './getRouteEmoji';
import { interpolateSpectral, hsl } from 'd3';
import { haversineDist, lerp, getBearing, type Coords } from './utils/geo';
import { sensibleNumber } from './utils/format';
import { throttle } from 'throttle-debounce';
import { getBeforeId } from './utils/layer_order';
import { map_update_lock } from './utils/map_lock';
import { give_me_more_trains } from './utils/i_bloody_love_trains';
import { getCountry, countryToFlag } from "./utils/tiny-countries";
import { NightLayer } from 'maplibre-gl-nightlayer';

const PointerArrow = (props: { color: string; size?: number }) => (
  <svg
    width={props.size || 24}
    height={props.size || 24}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M12 2L6 20h12L12 2z"
      fill={props.color}
      stroke={props.color}
      stroke-width="1"
      stroke-linejoin="round"
    />
  </svg>
);

let mapInstance: maplibregl.Map;

const NIGHT_LAYER = new NightLayer({opacity: 0.5});

const lerpBearing = (a: number, b: number, t: number) => {
  let diff = b - a;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return (a + diff * t + 360) % 360;
};

export function flyToPlayer(playerId: string) {
  const pos = playerPositions[playerId];
  if (pos && mapInstance) {
    mapInstance.flyTo({
      center: pos,
      zoom: mapInstance.getZoom(),
      essential: true
    });
  }
}

export function getPlayerScreenPosition(playerId: string): { x: number, y: number } | null {
  if (!mapInstance || !playerPositions[playerId]) return null;
  const canvas = mapInstance.getCanvas();
  const point = mapInstance.project(playerPositions[playerId]);
  return {
    x: point.x / canvas.clientWidth,
    y: point.y / canvas.clientHeight
  };
}

export function handleMapClickForDepartures(lat: number, lng: number, shiftKey: boolean = false) {
  const h3Index = latLngToCell(lat, lng, 11);
  const radius = shiftKey ? 0 : 2;
  const neighborhood = gridDisk(h3Index, radius);

  const features = neighborhood.map(index => {
    const boundary = cellToBoundary(index);
    const coords = boundary.map(p => [p[1], p[0]]);
    coords.push(coords[0]);
    return {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {}
    };
  });

  const source = mapInstance?.getSource('h3-cell') as maplibregl.GeoJSONSource;
  if (source) {
    source.setData({
      type: 'FeatureCollection',
      features: features as any
    });

    setTimeout(() => {
      if (mapInstance) {
        const s = mapInstance.getSource('h3-cell') as maplibregl.GeoJSONSource;
        if (s) s.setData({ type: 'FeatureCollection', features: [] });
      }
    }, 1000);
  }

  const stopZone = getTimeZone(lat, lng);
  $stopTimeZone.set(stopZone);

  const simTime = $clock.get();
  const localDateStr = new Date(simTime).toLocaleString('en-US', { timeZone: stopZone });
  const localDate = new Date(localDateStr);
  const hour = localDate.getHours();
  const minute = localDate.getMinutes();

  const h3Conditions = neighborhood.map(idx => `reinterpretAsUInt64(reverse(unhex('${idx}')))`).join(', ');
  const targetMinutes = hour * 60 + minute;

  $lastClickContext.set({ h3Conditions, targetMinutes, stopTimeZone: stopZone, clickTime: Date.now() });
}

export function fitGameBounds() {
  const bounds = $gameBounds.get();
  if (!mapInstance) return;

  if (bounds.start && bounds.finish) {
    const box = new maplibregl.LngLatBounds();
    box.extend([bounds.start[1], bounds.start[0]]);   // [lng, lat]
    box.extend([bounds.finish[1], bounds.finish[0]]); // [lng, lat]

    mapInstance.fitBounds(box, {
      padding: 200,
      maxZoom: 14,
      duration: 1500,
      essential: true
    });
    return;
  }

  if (bounds.start) {
    mapInstance.flyTo({
      center: [bounds.start[1], bounds.start[0]],
      zoom: 14,
      duration: 1500,
      essential: true
    });
    return;
  }

  if (bounds.finish) {
    mapInstance.flyTo({
      center: [bounds.finish[1], bounds.finish[0]],
      zoom: 14,
      duration: 1500,
      essential: true
    });
  }
}

const getCrowKmColor = (crowKm: number): string => {
  const normalized = Math.sqrt(Math.max(crowKm / 200, 0));
  return interpolateSpectral(normalized);
};

let lastUpdatePos: Coords | null = null;
let lastUpdateTime = 0;
let isStopsLayerVisible = false;

const updateStops = async (map: maplibregl.Map) => {
  const zoom = map.getZoom();
  if (zoom < 2) {
    if (isStopsLayerVisible) {
      const source = map.getSource('stops') as maplibregl.GeoJSONSource;
      if (source) {
        source.setData({ type: 'FeatureCollection', features: [] });
      }
      isStopsLayerVisible = false;
    }
    return;
  }

  isStopsLayerVisible = true;

  const center = map.getCenter();
  const now = Date.now();

  if ($isFollowing.get() && lastUpdatePos) {
    const dist = haversineDist({ lon: center.lng, lat: center.lat }, lastUpdatePos);
    // don't update if we haven't moved at least 100m and it's been less than 5 seconds
    if (dist !== null && dist < 0.1 && (now - lastUpdateTime) < 5000) {
      return;
    }
  }

  lastUpdatePos = { lon: center.lng, lat: center.lat };
  lastUpdateTime = now;

  const bounds = map.getBounds();
  const query = `
    SELECT
      crow_km,
      stop_lat,
      stop_lon,
      stop_name,
      route_type
    FROM transitous_everything_20260218_stop_statistics_unmerged3
    WHERE stop_lat BETWEEN ${bounds.getSouth()} AND ${bounds.getNorth()}
      AND stop_lon BETWEEN ${bounds.getWest()} AND ${bounds.getEast()}
    ORDER BY crow_km desc
    LIMIT ${$playerSettings.get().maxStops}
  `;
  // ${zoom <= 13.5 ? ("AND (" + getClickHouseRouteTypeBetweens(["rail", "ferry"]) + ")") : ""}
  // ${zoom <= 9 ? ("AND crow_km >= 150") : ""}
  // ${zoom <= 9 ? ("LIMIT 100") : zoom <= 13.5 ? ("AND crow_km >= 100") : ""}
  //${zoom >= 16 ? "_unmerged" : ""}

  try {
    const res = await chQuery(query);
    if (res && res.data) {
      function getHalo(hex: string) {
        const colour = hsl(hex);
        colour.l = colour.l > 0.5 ? 0.3 : 0.95;
        colour.s *= 0.5;
        return colour.toString();
      }
      const features = res.data.map((stop: any) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [stop.stop_lon, stop.stop_lat]
        },
        properties: {
          emoji: [getRouteEmoji(stop.route_type), stop.stop_name].join(' '),
          name: stop.stop_name,
          route_type: stop.route_type,
          crow_km: stop.crow_km,
          color: getCrowKmColor(stop.crow_km || 0),
          halo_color: getHalo(getCrowKmColor(stop.crow_km || 0))
        }
      }));

      const source = map.getSource('stops') as maplibregl.GeoJSONSource;
      if (source) {
        source.setData({ type: 'FeatureCollection', features });
      }
    }
  } catch (err) {
  }
};

const getPointer = (targetLat: number, targetLng: number): { x: number, y: number, bearing: number, distance: number } | null => {
  if (!mapInstance) return null;

  const targetLngLat = new maplibregl.LngLat(targetLng, targetLat);
  const bounds = mapInstance.getBounds();

  if (bounds.contains(targetLngLat)) return null;

  const canvas = mapInstance.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const paddingX = 120;
  const paddingY = 40;

  const centerMap = mapInstance.getCenter();
  const centerScreen = mapInstance.project(centerMap);
  const targetScreen = mapInstance.project(targetLngLat);

  const rect = { minX: paddingX, minY: paddingY, maxX: w - paddingX, maxY: h - paddingY };
  const dx = targetScreen.x - centerScreen.x;
  const dy = targetScreen.y - centerScreen.y;

  let t = Infinity;
  if (dx > 0) t = Math.min(t, (rect.maxX - centerScreen.x) / dx);
  else if (dx < 0) t = Math.min(t, (rect.minX - centerScreen.x) / dx);

  if (dy > 0) t = Math.min(t, (rect.maxY - centerScreen.y) / dy);
  else if (dy < 0) t = Math.min(t, (rect.minY - centerScreen.y) / dy);

  const intersection = {
    x: centerScreen.x + dx * t,
    y: centerScreen.y + dy * t
  };

  const pointerLngLat = mapInstance.unproject([intersection.x, intersection.y]);
  const bearing = getBearing(pointerLngLat.lat, pointerLngLat.lng, targetLat, targetLng);
  const distance = haversineDist({ lat: centerMap.lat, lon: centerMap.lng }, { lat: targetLat, lon: targetLng }) || 0;

  return { x: intersection.x, y: intersection.y, bearing, distance };
};

const basemapSettingToStyle = (setting: string): string | maplibregl.StyleSpecification => {
  switch (setting) {
    // :(
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
    // case 'Transport':
    //   return {
    //     'version': 8,
    //     'sources': {
    //       'raster-tiles': {
    //         'type': 'raster',
    //         'tiles': [
    //           `https://tile.thunderforest.com/transport/{z}/{x}/{y}@2x.png?apikey=${import.meta.env.VITE_THUNDERFOREST_API_KEY}`,
    //         ],
    //         'tileSize': 256,
    //         'attribution':
    //           '<a href="https://www.thunderforest.com/" target="_blank">&copy; Thunderforest</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>'
    //       }
    //     },
    //     'layers': [
    //       {
    //         'id': 'simple-tiles',
    //         'type': 'raster',
    //         'source': 'raster-tiles',
    //         'minzoom': 0,
    //         'maxzoom': 22
    //       }
    //     ]
    //   }
    // case 'Transport dark':
    //   return {
    //     'version': 8,
    //     'sources': {
    //       'raster-tiles': {
    //         'type': 'raster',
    //         'tiles': [
    //           `https://tile.thunderforest.com/transport-dark/{z}/{x}/{y}@2x.png?apikey=${import.meta.env.VITE_THUNDERFOREST_API_KEY}`,
    //         ],
    //         'tileSize': 256,
    //         'attribution':
    //           '<a href="https://www.thunderforest.com/" target="_blank">&copy; Thunderforest</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>'
    //       }
    //     },
    //     'layers': [
    //       {
    //         'id': 'simple-tiles',
    //         'type': 'raster',
    //         'source': 'raster-tiles',
    //         'minzoom': 0,
    //         'maxzoom': 22
    //       }
    //     ]
    //   }
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


export default function MapView() {
  let mapContainer: HTMLDivElement | undefined;
  let frameId: number;
  let smoothedMyBearing = 0;
  const [mapReady, setMapReady] = createSignal(false);
  const [clickPopupPos, setClickPopupPos] = createSignal<{ lat: number, lng: number } | null>(null);
  const isFollowing = useStore($isFollowing);
  const [finishPointer, setFinishPointer] = createSignal<{ x: number, y: number, bearing: number, distance: number } | null>(null);
  const [playerPointers, setPlayerPointers] = createStore<{ pid: string, pointer: { x: number, y: number, bearing: number, distance: number } }[]>([]);
  const [pingPointers, setPingPointers] = createSignal<{ pid: string, pointer: { x: number, y: number, bearing: number, distance: number } }[]>([]);
  const playerMarkers = new Map<string, maplibregl.Marker>();

  onMount(() => {

    if (!mapContainer) {
      console.error('[Map] Fatal: Map container ref is missing!');
      return;
    }

    const rect = mapContainer.getBoundingClientRect();
    if (rect.height === 0) {
      console.warn('[Map] Warning: Container height is 0. Map may be invisible.');
    }

    try {
      const startPos = $gameBounds.get().start;
      mapInstance = new maplibregl.Map({
        container: mapContainer,
        style: {
          version: 8,
          sources: {},
          layers: []
        },
        center: startPos ? [startPos[1], startPos[0]] : [-3.1883, 55.9533],
        zoom: 14,
        fadeDuration: 0,
        doubleClickZoom: false,
      });
    } catch (err) {
      console.error('[Map] Error creating MapLibre instance:', err);
      return;
    }

    mapInstance.on('error', (e) => {
      console.error('[Map] Internal Map Error:', e);
    });

    const updateBasemap = async (setting: string) => {
      const unlock = await map_update_lock.lock(); // too many cooks spoil the painter's algorithm
      try {
        await ensureMapLoaded(mapInstance);

        const styleSpec = basemapSettingToStyle(setting);

        const existingLayers = mapInstance.getStyle()?.layers;
        const existingSources = mapInstance.getStyle()?.sources;
        for (const layer of existingLayers) {
          if (layer.id.startsWith('basemap-')) {
            mapInstance.removeLayer(layer.id);
          }
        }
        for (const sourceId in existingSources) {
          if (sourceId.startsWith('basemap-')) {
            mapInstance.removeSource(sourceId);
          }
        }

        if (typeof styleSpec === 'string') {
          try {
            const response = await fetch(styleSpec);
            const style = await response.json();
            give_me_more_trains(style);
            style.glyphs && mapInstance.setGlyphs(style.glyphs);
            style.sprite && mapInstance.setSprite(style.sprite);
            for (const [sourceId, source] of Object.entries(style.sources)) {
              mapInstance.addSource(`basemap-${sourceId}`, source as any);
            }
            for (const layer of style.layers) {
              const newLayer = {
                ...layer,
                id: `basemap-${layer.id}`,
                source: layer.source ? `basemap-${layer.source}` : undefined
              };
              mapInstance.addLayer(newLayer, getBeforeId(`basemap-${layer.id}`, mapInstance));
            }
          } catch (err) {
            console.error('[Map] Failed to fetch basemap style:', err);
          }
        } else {
          const sourceKey = Object.keys(styleSpec.sources)[0];
          const source = styleSpec.sources[sourceKey];
          const layer = styleSpec.layers[0];

          mapInstance.addSource(`basemap-${sourceKey}`, source as any);
          mapInstance.addLayer({
            ...layer,
            id: `basemap-${layer.id}`,
            source: `basemap-${sourceKey}`
          } as any, getBeforeId(`basemap-${layer.id}`, mapInstance));
        }
      } finally {
        unlock();
      }
    };

    const updateRailwaysLayer = async (setting: string) => {
      const unlock = await map_update_lock.lock();
      try {
        const pathMap: Record<string, string | null> = {
          'Infrastructure': '/standard/',
          'Speed': '/maxspeed/',
          'Electrification': '/electrification/',
          'Gauge': '/gauge/',
          'Disabled': null
        };

        const path = pathMap[setting];
        const layerExists = !!mapInstance.getLayer('openrailwaymap-layer');
        const sourceExists = !!mapInstance.getSource('openrailwaymap');

        if (path === null) {
          if (layerExists) {
            // don't wait for map load for removal
            mapInstance.setLayoutProperty('openrailwaymap-layer', 'visibility', 'none');
          }
        } else {
          await ensureMapLoaded(mapInstance);
          if (layerExists) {
            mapInstance.removeLayer('openrailwaymap-layer');
          }
          if (sourceExists) {
            mapInstance.removeSource('openrailwaymap');
          }

          mapInstance.addSource('openrailwaymap', {
            type: 'raster',
            tiles: [`https://tiles.openrailwaymap.org${path}{z}/{x}/{y}.png`],
            tileSize: 256,
            attribution: '&copy; <a href="https://www.openrailwaymap.org">OpenRailwayMap</a>'
          });

          mapInstance.addLayer({
            id: 'openrailwaymap-layer',
            type: 'raster',
            source: 'openrailwaymap',
            paint: { 'raster-opacity': 1 }
          }, getBeforeId("openrailwaymap-layer", mapInstance));
        }
      } finally {
        unlock();
      }
    };

    const updateTransportLayer = async (setting: string) => {
      const unlock = await map_update_lock.lock();
      try {
        const sourceId = 'public-transport';
        if (!setting) {
          const existingLayers = mapInstance.getStyle().layers
          .filter(l => l.id.startsWith(`${sourceId}-`))
          .map(l => l.id);
          for (const layerId of existingLayers) {
            mapInstance.removeLayer(layerId);
          }
          if (mapInstance.getSource(sourceId)) {
            mapInstance.removeSource(sourceId);
          }
          return;
        }
        const style = await fetch('./public_transport.json').then(r => r.json());

        for (const layer of style.layers) {
          const fullLayerId = `${sourceId}-${layer.id}`;
          if (mapInstance.getLayer(fullLayerId)) {
            mapInstance.removeLayer(fullLayerId);
          }
        }
        if (mapInstance.getSource(sourceId)) {
          mapInstance.removeSource(sourceId);
        }

        await ensureMapLoaded(mapInstance);

        mapInstance.addSource(sourceId, style.sources.openmaptiles as any);

        for (const layer of style.layers) {
          mapInstance.addLayer({
            ...layer,
            id: `${sourceId}-${layer.id}`,
            source: sourceId
          }, getBeforeId(`${sourceId}-${layer.id}`, mapInstance));
        }
      } finally {
        unlock();
      }
    };

    const updateBathymetryLayer = async (setting: string) => {
      const unlock = await map_update_lock.lock();
      try {
        const layerExists = !!mapInstance.getLayer('water-bathymetry');
        const sourceExists = !!mapInstance.getSource('gebco');
        if (layerExists) {
          mapInstance.removeLayer('water-bathymetry');
        }
        if (sourceExists) {
          mapInstance.removeSource('gebco');
        }
        if (!setting) {
          return;
        }
        mapInstance.addSource('gebco', {
          type: 'vector',
          tiles: [`https://compute.olie.science/versatiles/tiles/bathymetry-vectors/{z}/{x}/{y}`],
          minzoom: 0,
          maxzoom: 10,
          attribution: '<a href="https://download.versatiles.org/" target="_blank">VersaTiles, GEBCO & OpenDEM</a>'
        });

        const baseColorValue = (mapInstance.getStyle().layers.find(layer => layer.id === 'basemap-water')?.paint as any)?.['fill-color'] || "#b3dbe6"; // approx osm carto
        const colorString: string = Array.isArray(baseColorValue) ? "#b3dbe6" : baseColorValue as any; // fallback to carto if there's a complex expression
        const isRaster = baseColorValue === '#b3dbe6'; // this is stupid

        const baseHsl = hsl(colorString);
        const isDark = baseHsl.l < 0.5;

        // todo: check versatiles uses these and only these (the base gebco layer does iirc)
        const stops = [
          -9500, -9000, -8500, -8000, -7500, -7000, -6500, -6000, -5500, -5000,
          -4500, -4000, -3500, -3000, -2500, -2000, -1750, -1500, -1250, -1000,
          -750, -500, -250, -200, -100, -50, -25, 0
        ];

        const extremeLightness = isDark ? 0.95 : 0.05;

        const fillColorExpression = [
          "step",
          ["get", "mindepth"],
          isDark ? "#ffffff" : "#000000"
        ];

        stops.forEach((depth, index) => {
          const t = index / (stops.length - 1);
          let stepHsl = hsl(baseHsl.toString());

          // much more extreme logic for dark mode
          if (isDark) {
            stepHsl.l = extremeLightness - (extremeLightness - baseHsl.l) * t;
          } else {
            stepHsl.l = 0.95 - (0.95 - baseHsl.l) * t;
          }

          fillColorExpression.push(depth as any, stepHsl.formatHex()); // depth has to be a number but typescript disagrees (!)
        });

        mapInstance.addLayer({
          id: 'water-bathymetry',
          type: 'fill',
          source: 'gebco',
          'source-layer': 'bathymetry',
          paint: {
            "fill-color": fillColorExpression as any,
            "fill-opacity": isRaster ? 0.5 : 1,
          },
        }, getBeforeId("water-bathymetry", mapInstance));

      } finally {
        unlock();
      }
    };

    const updateHillShadeLayer = async (setting: boolean) => {
      const unlock = await map_update_lock.lock();
      try {
        await ensureMapLoaded(mapInstance);

        const layerExists = !!mapInstance.getLayer('mapterhorn-layer');
        const sourceExists = !!mapInstance.getSource('mapterhorn');
        if (layerExists) {
          mapInstance.removeLayer('mapterhorn-layer');
        }
        if (sourceExists) {
          mapInstance.removeSource('mapterhorn');
        }
        if (!setting) {
          return;
        }

        mapInstance.addSource('mapterhorn', {
          type: 'raster-dem',
          url: 'https://tiles.mapterhorn.com/tilejson.json',
          maxzoom: 15,
        });
        mapInstance.addLayer({
          id: 'mapterhorn-layer',
          type: 'hillshade',
          source: 'mapterhorn',
          paint: {
            'hillshade-shadow-color': '#000',
            'hillshade-highlight-color': '#fff',
            'hillshade-accent-color': '#fff',
            'hillshade-exaggeration': 0.1,
            'hillshade-method': 'igor',
          }
        }, getBeforeId("mapterhorn-layer", mapInstance));
      } finally {
        unlock();
      }
    };

    const updateTerrain = async (setting: boolean) => {
      const unlock = await map_update_lock.lock();
      try {
        await ensureMapLoaded(mapInstance);

        const sourceExists = !!mapInstance.getSource('mapterhorn-3d');
        if (!sourceExists) {
          mapInstance.addSource('mapterhorn-3d', {
            type: 'raster-dem',
            url: 'https://tiles.mapterhorn.com/tilejson.json',
            maxzoom: 15,
          });
        }
        if (!setting) {
          mapInstance.setTerrain(null);
        } else {
          mapInstance.setTerrain({
            source: 'mapterhorn-3d',
            exaggeration: 3,
          });
        }

      } finally {
        unlock();
      }
    }

    mapInstance.on('load', () => {
      mapInstance.boxZoom.disable(); // give shift back
      // mapInstance.setProjection({type: 'globe'}); // kinda trippy
      mapInstance.addSource('course-markers', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      mapInstance.addSource('course-markers-h3', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      mapInstance.addLayer({
        id: 'course-markers-h3-filled', type: 'fill', source: 'course-markers-h3',
        paint: { 'fill-color': '#10b981', 'fill-opacity': 0.8 }
      }, getBeforeId("course-markers-h3-filled", mapInstance));

      mapInstance.addLayer({
        id: 'course-markers-icon',
        type: 'symbol',
        source: 'course-markers',
        layout: {
          'text-field': ['get', 'icon'],
          'text-size': 32,
          'text-allow-overlap': true,
          'text-offset': [0, -0.2]
        },
        paint: {
          'text-color': '#10b981',
          'text-halo-color': '#000000',
          'text-halo-width': 2,
        }
      }, getBeforeId("course-markers-icon", mapInstance));
      mapInstance.addLayer({
        id: 'course-markers-label',
        type: 'symbol',
        source: 'course-markers',
        layout: {
          'text-field': ['get', 'label'],
          'text-size': 14,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          'text-allow-overlap': true
        },
        paint: {
          'text-color': '#000000',
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
        }
      }, getBeforeId("course-markers-label", mapInstance));

      mapInstance.addSource('routes', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        attribution: '<a href="https://github.com/bovine3dom/fahrtle?tab=readme-ov-file#fahrtle" target="_blank">❤️ bovine3dom & fahrtle</a>'
      });

      mapInstance.addLayer({
        id: 'routes-casing', type: 'line', source: 'routes',
        paint: {
          'line-color': '#ffffff',
          'line-width': 7,
          'line-opacity': ['get', 'opacity'],
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' }
      }, getBeforeId("routes-casing", mapInstance));


      mapInstance.addLayer({
        id: 'routes-line', type: 'line', source: 'routes',
        filter: ['==', '$type', 'LineString'],
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 3,
          'line-opacity': ['get', 'opacity'],
        },
        layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'sort_key'] }
      }, getBeforeId("routes-line", mapInstance));

      mapInstance.addSource('h3-cell', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      mapInstance.addLayer({
        id: 'h3-cell-line', type: 'line', source: 'h3-cell',
        paint: { 'line-color': '#ff00ff', 'line-width': 3, 'line-opacity': 0.8 }
      }, getBeforeId("h3-cell-line", mapInstance));

      mapInstance.addSource('preview-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      mapInstance.addLayer({
        id: 'preview-route-casing', type: 'line', source: 'preview-route',
        paint: {
          'line-color': '#ffffff',
          'line-width': 10,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' }
      }, getBeforeId("preview-route-casing", mapInstance));

      mapInstance.addLayer({
        id: 'preview-route-line', type: 'line', source: 'preview-route',
        filter: ['==', '$type', 'LineString'],
        paint: {
          'line-color': '#444',
          'line-width': 6,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' }
      }, getBeforeId("preview-route-line", mapInstance));

      mapInstance.addLayer({
        id: 'preview-route-labels',
        type: 'symbol',
        source: 'preview-route',
        filter: ['==', '$type', 'Point'],
        layout: {
          'text-field': ['concat', ['get', 'stop_name'], ' (', ['get', 'arrival_time'], ')'],
          'text-size': 14,
          'text-offset': [0, 0.6],
          'text-anchor': 'top',
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: {
          'text-color': '#000000',
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
        }
      }, getBeforeId("preview-route-labels", mapInstance));

      mapInstance.addLayer({
        id: 'routes-labels',
        type: 'symbol',
        source: 'routes',
        filter: ['all', ['==', '$type', 'Point'], ['!=', 'stop_name', 'Stopped']],
        layout: {
          'text-field': ['concat', ['get', 'stop_name'], ' (', ['get', 'arrival_time'], ')'],
          'text-size': 14,
          'text-offset': [0, 0.6],
          'text-anchor': 'top',
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#ffffff',
          'text-halo-width': 2,
        }
      }, getBeforeId("routes-labels", mapInstance));

      mapInstance.addSource('stops', {
        type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        attribution: '&copy; <a href="https://transitous.org/sources" target="_blank">Transitous et al.</a>'
      });

      mapInstance.addLayer(NIGHT_LAYER, getBeforeId("nightlayer", mapInstance));

      mapInstance.addLayer({
        id: 'stops-layer',
        type: 'symbol',
        source: 'stops',
        layout: {
          'text-field': ['get', 'emoji'],
          'text-size': 12,
          'text-allow-overlap': true,
          'text-ignore-placement': false,
          'text-anchor': 'left',
          'symbol-z-order': 'source',
          'symbol-sort-key': ['get', 'crow_km'],
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': ['get', 'halo_color'],
          'text-halo-width': 0.8,
        }
      }, getBeforeId("stops-layer", mapInstance));

      mapInstance.addSource('pings', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      mapInstance.addLayer({
        id: 'pings',
        type: 'circle',
        source: 'pings',
        paint: {
          'circle-radius': 30,
          'circle-color': '#ff6600',
          'circle-opacity': 1,
          'circle-blur': 1
        }
      }, getBeforeId("pings", mapInstance));

      let clickTimeout: any = null;

      const throttledUpdate = throttle(1000, () => {
        if (mapInstance) {
          updateStops(mapInstance);
          $mapZoom.set(mapInstance.getZoom());
        }
      });
      mapInstance.on('moveend', throttledUpdate);
      mapInstance.on('zoomend', throttledUpdate);

      const disableFollowing = () => $isFollowing.set(false);
      mapInstance.on('dragstart', disableFollowing);
      mapInstance.on('wheel', disableFollowing);
      mapInstance.on('touchstart', disableFollowing);
      mapInstance.on('mousedown', (e) => {
        if (e.originalEvent.button === 0) disableFollowing();
      });

      mapInstance.on('dblclick', (e) => {
        if (clickTimeout) {
          clearTimeout(clickTimeout);
          clickTimeout = null;
        }
        if ($pickerMode.get() || $playerSettings.get().walkConfirm) return;
        submitWaypoint(e.lngLat.lat, e.lngLat.lng);
      });

      // middle click to send ping, shift+middle to teleport (dev only)
      mapInstance.on('mousedown', (e) => {
        if (e.originalEvent.button === 1) {
          if (e.originalEvent.shiftKey && !import.meta.env.PROD) {
            submitWaypointsBatch([
              { lat: e.lngLat.lat, lng: e.lngLat.lng, time: $clock.get() },
            ], { isTeleport: true });
          } else {
            sendPing(e.lngLat.lat, e.lngLat.lng);
          }
        }
      });

      mapInstance.on('click', (e) => {
        !import.meta.env.PROD && console.log(`{ lat = "${e.lngLat.lat}", lon = "${e.lngLat.lng}" }`);
        !import.meta.env.PROD && getCountry({lat: e.lngLat.lat, lon: e.lngLat.lng}).then((c) => console.log(countryToFlag(c || '')));

        if (clickTimeout) clearTimeout(clickTimeout);
        const mode = $pickerMode.get();
        if (mode) {
          $pickedPoint.set({ lat: e.lngLat.lat, lng: e.lngLat.lng, target: mode });
          $pickerMode.set(null);
          return;
        }
        if ($playerSettings.get().walkConfirm) {
          setClickPopupPos({ lat: e.lngLat.lat, lng: e.lngLat.lng });
          return;
        }

        clickTimeout = setTimeout(() => {
          handleMapClickForDepartures(e.lngLat.lat, e.lngLat.lng, e.originalEvent.shiftKey);
          clickTimeout = null;
        }, 300);
      });


      if (mapInstance) {
        throttledUpdate();
      }
      setMapReady(true);
      startAnimationLoop();
    });

    const context = useStore($lastClickContext);
    const boardPage = useStore($departureBoardPage);

    const buildQuery = (queryMode: 'departures' | 'arrivals', ctx: NonNullable<ReturnType<typeof context>>, offset: number = 0) => {
      const timeField = queryMode === 'departures' ? 'departure_time' : 'next_arrival';
      const h3Field = queryMode === 'departures' ? 'h3' : 'next_h3';
      const limBy = $playerSettings.get().hidePotentialDuplicateDepartures ? `
          LIMIT 1 BY
            source,
            departure_time,
            h3ToParent(next_h3, 9) -- eugh but this then excludes e.g. night trains which split...
      ` : '';
      const limByInner = $playerSettings.get().hidePotentialDuplicateDepartures ? `
           LIMIT 1 BY
             stop_uuid,
             departure_time,
             route_short_name,
             trip_headsign,
             final_name
      ` : '';
      return `
        SELECT * FROM (
          SELECT * FROM (
            SELECT *, ((toHour(${timeField}) * 60 + toMinute(${timeField})) - ${ctx.targetMinutes} + 1440) % 1440 sort_time
            FROM transitous_everything_20260218_edgelist_fahrtle2
            WHERE ${h3Field} IN (${ctx.h3Conditions})
            ORDER by sort_time ASC, travel_time ASC
            ${limByInner}
            LIMIT 1000
          )
          ORDER BY geoDistance(stop_lon, stop_lat, final_lon, final_lat) DESC, travel_time ASC -- hmm geoDistance should probably be rounded
          ${limBy}
        )
        ORDER BY sort_time ASC
        LIMIT 200 OFFSET ${offset}
      `;
    };

    const processResults = (res: any, currentMode: 'departures' | 'arrivals'): DepartureResult[] => {
      if (!res || !res.data) return [];
      return res.data.map((row: DepartureResult) => {
        row.bearing = getBearing(row.stop_lat, row.stop_lon, row.next_lat, row.next_lon);
        row.bearing_origin = getBearing(row.next_lat, row.next_lon, row.initial_lat, row.initial_lon); // for arrivals, the "next" stop is our stop
        const dist = haversineDist({ lat: row.stop_lat, lon: row.stop_lon }, {
          lat: row[currentMode === 'departures' ? 'final_lat' : 'initial_lat'],
          lon: row[currentMode === 'departures' ? 'final_lon' : 'initial_lon'],
        });
        const start = new Date(row.initial_arrival || ""); // todo: add initial_departure
        const finish = new Date(row.final_arrival || "");
        if (finish < start) finish.setDate(finish.getDate() + 1); // not going to work for trips across timezones but who cares for now
        row.dist = dist || 0;
        const duration = (finish.getTime() - start.getTime()) / (1000 * 60 * 60);
        row.speed = duration > 0 ? (dist || 0) / duration : 0; // never actually zero here but ts whines
        return row;
      });
    };

    createEffect(() => {
      const ctx = context();
      if (ctx === null) return;
      ctx.clickTime; // force reactivity on repeated clicks in same position

      $departureBoardPage.set(0);
      $departureBoardHasMore.set(true);

      const departuresQuery = buildQuery('departures', ctx, 0);
      const arrivalsQuery = buildQuery('arrivals', ctx, 0);

      $departureBoardResults.set({ departures: [], arrivals: [] });

      chQuery(departuresQuery)
        .then(res => processResults(res, 'departures'))
        .then(departuresData => {
          if (departuresData.length > 0) {
            $departureBoardResults.setKey('departures', departuresData);
            $departureBoardHasMore.set(departuresData.length >= 200);
            $previewRoute.set(null);
            $boardMinimized.set(false);
          }
        })
        .catch(err => console.error(`[ClickHouse] Departures query failed:`, err));
      chQuery(arrivalsQuery)
        .then(res => processResults(res, 'arrivals'))
        .then(arrivalsData => {
          $departureBoardResults.setKey('arrivals', arrivalsData);
        })
        .catch(err => {
          console.error(`[ClickHouse] Arrivals query failed:`, err);
        });
    });

    createEffect(() => {
      const ctx = context();
      const page = boardPage();
      if (ctx === null || page === 0) return;

      const mode = $boardMode.get();
      const offset = page * 200;
      const query = buildQuery(mode, ctx, offset);

      $departureBoardLoadingMore.set(true);

      chQuery(query)
        .then(res => processResults(res, mode))
        .then(newData => {
          if (newData.length > 0) {
            const current = $departureBoardResults.get();
            const key = mode as 'departures' | 'arrivals';
            $departureBoardResults.setKey(key, [...current[key], ...newData]);
            $departureBoardHasMore.set(newData.length >= 200);
          } else {
            $departureBoardHasMore.set(false);
          }
          $departureBoardLoadingMore.set(false);
        })
        .catch(err => {
          console.error(`[ClickHouse] Load more query failed:`, err);
          $departureBoardLoadingMore.set(false);
        });
    });

    const pickerMode = useStore($pickerMode);
    createEffect(() => {
      const mode = pickerMode();
      if (mapInstance && mapInstance.getCanvas()) {
        mapInstance.getCanvas().style.cursor = mode ? 'crosshair' : 'grab';
      }
    });
    const playerSettings = useStore($playerSettings);
    createEffect(() => {
      const setting = playerSettings().baseMap;
      updateBasemap(setting);
      updateBathymetryLayer(setting); // change colour if we need to
    });

    createEffect(() => {
      const setting = playerSettings().railwaysLayer;
      updateRailwaysLayer(setting);
    });

    createEffect(() => {
      // backwards compat with old basemap (rip) setting
      const setting = playerSettings().publicTransportLayer || (["Transport dark", "Transport"].includes(playerSettings().baseMap));
      updateTransportLayer(setting);
    });

    createEffect(() => {
      const setting = playerSettings().bathymetry;
      updateBathymetryLayer(setting);
    });

    createEffect(() => {
      const setting = playerSettings().hillShade;
      updateHillShadeLayer(setting);
    });

    createEffect(() => {
      const setting = playerSettings().terrain3d;
      updateTerrain(setting);
    });

    const simTime = useStore($clock);
    let i = 0;
    createEffect(async () => {
      simTime(); // force reactivity
      i++;
      await ensureMapLoaded(mapInstance);
      if (!mapInstance) return;
      NIGHT_LAYER.setDate(new Date(simTime()));
    });

    (window as any).mapInstance = mapInstance;
  });

  const bounds = useStore($gameBounds);
  const roomState = useStore($roomState);
  createEffect((prevState) => {
    const currentState = roomState();

    if (prevState === 'COUNTDOWN' && currentState === 'RUNNING') {
      const b = untrack(() => bounds());
      if (b.start && mapInstance) {
        console.log('[Map] Race started! Zooming to start line.');
        mapInstance.flyTo({
          center: [b.start[1], b.start[0]],
          zoom: 14,
          duration: 2000,
          essential: true
        });
      }
    }
    return currentState;
  });

  let finishCells: string[] = [];
  createEffect(() => {
    const b = bounds();
    if (b.finish) {
      try {
        const center = latLngToCell(b.finish[0], b.finish[1], 11);
        finishCells = gridDisk(center, 1);
      } catch (e) {
        console.error("Error calculating H3 finish cells", e);
        finishCells = [];
      }
    } else {
      finishCells = [];
    }

    if (!mapReady() || !mapInstance) return;

    const source = mapInstance.getSource('course-markers') as maplibregl.GeoJSONSource;
    if (!source) return;

    const features = [];
    if (b.start) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [b.start[1], b.start[0]] },
        properties: { icon: '🟢', label: 'Start' }
      });
    }
    if (b.finish) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [b.finish[1], b.finish[0]] },
        properties: { icon: '🏁', label: 'Finish' }
      });
    }

    source.setData({ type: 'FeatureCollection', features: features as any });

    const cellsSource = mapInstance.getSource('course-markers-h3') as maplibregl.GeoJSONSource;
    if (!cellsSource) return;

    const cellFeatures = finishCells.map(index => {
      const boundary = cellToBoundary(index);
      const coords = boundary.map(p => [p[1], p[0]]);
      coords.push(coords[0]);
      return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: {}
      };
    });
    cellsSource.setData({ type: 'FeatureCollection', features: cellFeatures as any });
  });

  const previewRoute = useStore($previewRoute);
  createEffect(() => {
    const preview = previewRoute();
    const source = mapInstance?.getSource('preview-route') as maplibregl.GeoJSONSource;
    if (!source) return;
    if (preview) {
      const lineFeature = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: preview.coords },
        properties: { color: '#000' }
      };

      const pointFeatures = preview.coords.map((coord, i) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coord },
        properties: {
          stop_name: preview.stopNames[i],
          arrival_time: preview.stopTimes[i]
        }
      }));

      source.setData({
        type: 'FeatureCollection',
        features: [lineFeature, ...pointFeatures] as any
      });

      if (preview.coords.length > 0) {
        const bounds = new maplibregl.LngLatBounds();
        preview.coords.forEach(coord => bounds.extend(coord));
        mapInstance?.fitBounds(bounds, { padding: 80, duration: 1500 });
      }
      $boardMinimized.set(true);
    } else {
      source.setData({ type: 'FeatureCollection', features: [] });
    }
  });

  const players = useStore($players);
  const playerSettings = useStore($playerSettings);
  createEffect(() => {
    const isReady = mapReady();
    const allPlayers = players();
    if (!mapInstance || !isReady || !allPlayers) return;

    const routeFeatures = [];

    for (const pid in allPlayers) {
      const player = allPlayers[pid];
      const coords = player.waypoints.map(wp => [wp.x, wp.y]);
      if (coords.length > 1) {
        routeFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { color: player.color, sort_key: Number(!player.isGhost), opacity: player.isGhost ? 0 : 1 }
        });

        if (!(player.id == 'the-stig-🏎️') && playerSettings().showWaypoints) { // it adds his driving directions which is cute but also silly
          const pointFeatures = player.waypoints
            .filter(wp => wp.stopName && !wp.isWalk && !wp.isWait)
            .map(wp => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [wp.x, wp.y] },
              properties: {
                stop_name: wp.stopName,
                arrival_time: wp.timeStr || "",
                opacity: player.isGhost ? 0 : 1,
                color: player.color // this seems awkward, why do we need to specify it per point
              }
            }));
          routeFeatures.push(...pointFeatures);
        }
      }
    }


    const rSource = mapInstance.getSource('routes') as maplibregl.GeoJSONSource;
    if (rSource) {
      rSource.setData({ type: 'FeatureCollection', features: routeFeatures as any });
    }
  });

  const myId = useStore($myPlayerId);
  const isFinished = createMemo(() => players()[myId() || ''].finishTime != null);
  createEffect(async () => {
    const finished = isFinished(); // ... i really don't understand why this is necessary
    await ensureMapLoaded(mapInstance);
    if (finished) {
      mapInstance.setPaintProperty('routes-casing', 'line-opacity', 1);
      mapInstance.setPaintProperty('routes-line', 'line-opacity', 1);
      mapInstance.setPaintProperty('routes-labels', 'text-opacity', 1);
    } else {
      mapInstance.setPaintProperty('routes-casing', 'line-opacity', ['get', 'opacity']);
      mapInstance.setPaintProperty('routes-line', 'line-opacity', ['get', 'opacity']);
      mapInstance.setPaintProperty('routes-labels', 'text-opacity', ['get', 'opacity']);
    }
  });

  const startAnimationLoop = () => {
    let lastFrameTime = performance.now();
    let frameCount = 0;
    let autoZoomEnabled = $playerSettings.get().autoZoom;

    const loop = (timestamp: number) => {
      frameId = requestAnimationFrame(loop);
      frameCount++;

      const dt = timestamp - lastFrameTime;
      lastFrameTime = timestamp;

      if (!mapInstance || dt < 1) return;

      const now = getServerTime();
      const allPlayers = $players.get();
      const currentSpeeds: Record<string, number> = {};
      const currentBearings: Record<string, number> = {};
      const currentDists: Record<string, number | null> = {};
      const vehicleFeatures: any[] = [];

      const isRunning = $roomState.get() === 'RUNNING';
      const startTime = $gameStartTime.get();

      const SMOOTHING_TIME_CONSTANT = 100;
      const alpha = 1 - Math.exp(-dt / SMOOTHING_TIME_CONSTANT);
      const myId = $myPlayerId.get();
      let myTargetPos: [number, number] | null = null;
      let myTargetSpeed = 0;
      let myTargetBearing = 0;

      for (const pid in allPlayers) {
        const player = allPlayers[pid];
        let targetPos: [number, number] | null = null;

        if (player.segments.length === 0) {
          if (player.waypoints.length > 0) {
            const p = player.waypoints[0];
            targetPos = [p.x, p.y];
          }
        } else {
          const last = player.segments[player.segments.length - 1];
          targetPos = last.end;

          for (const seg of player.segments) {
            if (now >= seg.startTime && now < seg.endTime) {
              const t = (now - seg.startTime) / (seg.endTime - seg.startTime);
              targetPos = [
                lerp(seg.start[0], seg.end[0], t),
                lerp(seg.start[1], seg.end[1], t)
              ];

              const dist = haversineDist({ lon: seg.start[0], lat: seg.start[1] }, { lon: seg.end[0], lat: seg.end[1] });
              const durationHours = (seg.endTime - seg.startTime) / (1000 * 60 * 60);
              const speed = durationHours > 0 ? (dist || 0) / durationHours : 0; // never actually zero here but ts whines
              currentSpeeds[pid] = speed;
              currentBearings[pid] = getBearing(seg.start[1], seg.start[0], seg.end[1], seg.end[0]);
              break;
            }
          }

          const b = $gameBounds.get().finish;
          const distToFinish = haversineDist(targetPos ? { lon: targetPos[0], lat: targetPos[1] } : null, b?.length === 2 ? { lat: b[0], lon: b[1] } : null);
          currentDists[pid] = distToFinish;
        }

        if (targetPos) {
          const previousPos = playerPositions[pid] || targetPos;

          const smoothedPos: [number, number] = [
            lerp(previousPos[0], targetPos[0], alpha),
            lerp(previousPos[1], targetPos[1], alpha)
          ];

          playerPositions[pid] = smoothedPos;

          vehicleFeatures.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: smoothedPos },
            properties: { id: player.id, color: player.color }
          });

          if (pid === myId) {
            myTargetPos = targetPos;
            myTargetSpeed = currentSpeeds[pid] || 0;
            if (currentBearings[pid] !== undefined) {
              myTargetBearing = currentBearings[pid];
              smoothedMyBearing = lerpBearing(smoothedMyBearing, myTargetBearing, alpha);
            }

            if (frameCount % 60 === 0) {
              autoZoomEnabled = $playerSettings.get().autoZoom;

              const zone = getTimeZone(smoothedPos[1], smoothedPos[0]);
              if ($playerTimeZone.get() !== zone) {
                $playerTimeZone.set(zone);
              }
              // delete positions that are not in the game
              for (const pid in playerPositions) {
                if (!allPlayers[pid]) {
                  delete playerPositions[pid];
                }
              }
            }
            if (isRunning && startTime && !player.finishTime && finishCells.length > 0) {
              if (frameCount % 10 === 0) {
                try {
                  const myCell = latLngToCell(smoothedPos[1], smoothedPos[0], 11);
                  if (finishCells.includes(myCell)) {
                    const finishTimeMs = now - startTime;
                    finishRace(finishTimeMs);
                    updatePlayerStats((stats) => ({
                      ...stats,
                      racesFinished: stats.racesFinished + 1,
                    }));
                    const bounds = $gameBounds.get();
                    const dailyIndex = $currentDailyRaceIndex.get();
                    if (bounds.ghosts && dailyIndex !== null) {
                      submitGhostWaypoints(dailyIndex, finishTimeMs);
                    }
                  }
                } catch (e) { /* ignore H3 errors */ }
              }
            }
          }
        }
      }

      const updateMarkers = () => {
        for (const pid in allPlayers) {
          const player = allPlayers[pid];
          const pos = playerPositions[pid];
          if (!pos) continue;

          let marker = playerMarkers.get(pid);
          if (!marker) {
            const el = document.createElement('div');
            el.className = 'player-marker';
            el.style.width = '12px';
            el.style.height = '12px';
            el.style.borderRadius = '50%';
            el.style.background = player.color;
            el.style.border = '2px solid white';
            el.style.boxShadow = '0 0 4px rgba(0,0,0,0.3)';

            marker = new maplibregl.Marker({ element: el })
              .setLngLat(pos)
              .addTo(mapInstance);
            playerMarkers.set(pid, marker);
          } else {
            marker.setLngLat(pos);
            marker.getElement().style.background = player.color;
          }
        }

        playerMarkers.forEach((marker, pid) => {
          if (!allPlayers[pid]) {
            marker.remove();
            playerMarkers.delete(pid);
          }
        });
      };

      updateMarkers();

      const PING_DURATION = 10000;
      if (frameCount % 10 === 0) {
        $playerSpeeds.set(currentSpeeds);
        $playerDistances.set(currentDists);

        const finish = $gameBounds.get().finish;
        if (finish) {
          setFinishPointer(getPointer(finish[0], finish[1]));
        } else {
          setFinishPointer(null);
        }

        const t_playerPointers = Object.entries(playerPositions).map(([pid, pos]) => {
          const pointer = getPointer(pos[1], pos[0]);
          return { pid, pointer };
        });
        const validPointers = t_playerPointers.filter(p => p.pointer !== null) as { pid: string, pointer: { x: number, y: number, bearing: number, distance: number } }[];
        setPlayerPointers(reconcile(validPointers, { key: 'pid' }));

        const now = Date.now();
        const allPings = $pings.get();
        const pingFeatures = [];
        for (const pid in allPings) {
          const ping = allPings[pid];
          if (now - ping.timestamp < PING_DURATION) {
            pingFeatures.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [ping.lon, ping.lat] },
              properties: {}
            });
          }
        }
        const pingSource = mapInstance.getSource('pings') as maplibregl.GeoJSONSource;
        if (pingSource) {
          pingSource.setData({ type: 'FeatureCollection', features: pingFeatures as any });
        }
        const pingPointerData = Object.entries(allPings)
          .filter(([_, ping]) => now - ping.timestamp < PING_DURATION)
          .map(([pid, ping]) => {
            const pointer = getPointer(ping.lat, ping.lon);
            return { pid, pointer };
          })
          .filter(p => p.pointer !== null) as { pid: string, pointer: { x: number, y: number, bearing: number, distance: number } }[];
        setPingPointers(pingPointerData);
      }

      if (isFollowing() && mapInstance) {
        const firstPersonFollow = $playerSettings.get().firstPersonFollow;
        const myPos = myTargetPos;
        const mySpeed = myTargetSpeed;
        const centre = mapInstance.getCenter();
        const approxEq = (a: number, b: number) => Math.abs(a - b) < 0.000001;

        if (myPos) {
          const REFERENCE_SPEED = 50; // km/h
          const REFERENCE_ZOOM = firstPersonFollow ? 16 : 15;  // zoom level at reference speed
          const MIN_ZOOM = firstPersonFollow ? 13 : 5;
          const MAX_ZOOM = firstPersonFollow ? 18 : 16;
          const dilation = $globalRate.get() / 20; // normalise to walking dilation
          const safeSpeed = Math.max(1, mySpeed * dilation || 0);

          let nextZoom: number | undefined;

          if (autoZoomEnabled) {
            let targetZoom = REFERENCE_ZOOM - Math.log2(safeSpeed / REFERENCE_SPEED);
            targetZoom = Math.min(Math.max(targetZoom, MIN_ZOOM), MAX_ZOOM);

            const currentZoom = mapInstance.getZoom();
            // Only update zoom if we are far enough from target to avoid micro-jitters
            if (Math.abs(currentZoom - targetZoom) > 0.01) {
              nextZoom = lerp(currentZoom, targetZoom, alpha);
            }
          }

          if (!approxEq(myPos[0], centre.lng) || !approxEq(myPos[1], centre.lat) || nextZoom !== undefined) {
            if (firstPersonFollow) {
              const pitch = 75; // high pitch for first person

              mapInstance.jumpTo({
                center: myPos,
                pitch: pitch,
                bearing: smoothedMyBearing,
                zoom: nextZoom ?? mapInstance.getZoom(),
              });
            } else {
              const jumpOptions: any = { center: myPos };
              if (nextZoom !== undefined) jumpOptions.zoom = nextZoom;
              mapInstance.jumpTo(jumpOptions);
            }
          }
        }
      }
    };
    requestAnimationFrame(loop);
  };

  onCleanup(() => {
    cancelAnimationFrame(frameId);
    playerMarkers.forEach(m => m.remove());
    playerMarkers.clear();
    mapInstance?.remove();
  });

  const toggleFollow = () => {
    const following = !isFollowing();
    $isFollowing.set(following);
    if (following && mapInstance) {
      smoothedMyBearing = mapInstance.getBearing();
    }
    if (following) {
      const myId = $myPlayerId.get();
      const myPos = myId ? playerPositions[myId] : null;
      if (myPos && mapInstance && myId) {
        const mySpeed = $playerSpeeds.get()[myId] || 0;
        const targetZoom = 18 - Math.min(1, mySpeed / 400) * 7;
        mapInstance.easeTo({
          center: myPos,
          zoom: targetZoom,
          duration: 1000,
          essential: true
        });
      }
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%', background: '#eee' }} />
      
      <Show when={clickPopupPos()}>
        {(pos) => {
          const initialPos = { lat: pos().lat, lng: pos().lng };
          const popup = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            anchor: 'bottom',
            maxWidth: 'none',
            offset: [0, 15],
          })
            .setLngLat([initialPos.lng, initialPos.lat])
            .setHTML('<div id="map-click-popup-container"></div>')
            .addTo(mapInstance);

          const handleClose = () => {
            document.removeEventListener('click', closeOnOutsideClick);
            popup.remove();
            setClickPopupPos(null);
          };

          const closeOnOutsideClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const popupEl = document.querySelector('.maplibregl-popup-content');
            if (popupEl && !popupEl.contains(target)) {
              handleClose();
            }
          };

          setTimeout(() => {
            document.addEventListener('click', closeOnOutsideClick);
          }, 0);

          const handleShowDepartures = () => {
            $boardMinimized.set(false);
          };

          const container = document.getElementById('map-click-popup-container');
          if (container) {
            import('./MapClickPopup').then(({ default: Popup }) => {
              import('solid-js/web').then(({ render }) => {
                render(() => Popup({ lat: initialPos.lat, lng: initialPos.lng, onClose: handleClose, onShowDepartures: handleShowDepartures }), container);
              });
            });
          }

          return null;
        }}
      </Show>

      <button
        class="follow-btn"
        classList={{ active: isFollowing() }}
        onClick={toggleFollow}
        title={isFollowing() ? "Stop Following" : "Follow Me"}
      >
        <svg viewBox="0 0 24 24" fill="none" class="reticle-icon">
          <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" />
          <circle cx="12" cy="12" r="3" fill="currentColor" />
          <path d="M12 2V4M12 20V22M2 12H4M20 12H22" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>

      <Show when={finishPointer()}>
        {(p) => (
          <div
            style={{
              position: 'absolute',
              left: `${p().x}px`,
              top: `${p().y}px`,
              transform: `translate(-50%, -50%)`,
              display: 'flex',
              'align-items': 'center',
              gap: '8px',
              "pointer-events": 'none',
              "z-index": 100,
            }}
          >
            <div
              style={{
                transform: `rotate(${p().bearing}deg)`,
              }}
            >
              <PointerArrow color="#10b981" size={28} />
            </div>
            <div
              style={{
                color: '#10b981',
                "font-size": '14px',
                "font-weight": 'bold',
                "text-shadow": '0 0 1px #000',
                "white-space": 'nowrap'
              }}
            >
              finish {sensibleNumber(p().distance)} km
            </div>
          </div>
        )}
      </Show>

      <For each={playerPointers}>
        {(p) => (
          <div
            style={{
              position: 'absolute',
              left: `${p.pointer.x}px`,
              top: `${p.pointer.y}px`,
              transform: `translate(-50%, -50%)`,
              display: 'flex',
              'align-items': 'center',
              gap: '4px',
              "pointer-events": 'none',
              "z-index": 100,
            }}
          >
            <div
              style={{
                transform: `rotate(${p.pointer.bearing}deg)`,
              }}
            >
              <PointerArrow color={players()[p.pid]?.color || '#fff'} />
            </div>
            <div
              style={{
                color: players()[p.pid]?.color || '#fff',
                "font-size": '14px',
                "font-weight": 'bold',
                "text-shadow": '0 0 1px #000',
                "white-space": 'nowrap'
              }}
            >
              {p.pid} {sensibleNumber(p.pointer.distance)} km
            </div>
          </div>
        )}
      </For>

      <For each={pingPointers()}>
        {(p) => (
          <div
            style={{
              position: 'absolute',
              left: `${p.pointer.x}px`,
              top: `${p.pointer.y}px`,
              transform: `translate(-50%, -50%)`,
              display: 'flex',
              'align-items': 'center',
              gap: '4px',
              "pointer-events": 'none',
              "z-index": 100,
            }}
          >
            <div
              style={{
                transform: `rotate(${p.pointer.bearing}deg)`,
              }}
            >
              <PointerArrow color="#ff6600" />
            </div>
            <div
              style={{
                color: '#ff6600',
                "font-size": '14px',
                "font-weight": 'bold',
                "text-shadow": '0 0 1px #000',
                "white-space": 'nowrap'
              }}
            >
              {p.pid}'s ping {sensibleNumber(p.pointer.distance)} km
            </div>
          </div>
        )}
      </For>

      <style>{`
        .follow-btn {
          position: absolute;
          bottom: 24px;
          right: 24px;
          width: 56px;
          height: 56px;
          border-radius: 50%;
          background: #0064ab;
          border: 4px solid #003a79;
          color: #fff;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          z-index: 10;
          padding: 12px;
        }

        .follow-btn:hover {
          transform: scale(1.1);
          background: #0076c8;
        }

        .follow-btn.active {
          background: #ffed02;
          color: #003a79;
          border-color: #003a79;
          box-shadow: 0 0 20px rgba(255, 237, 2, 0.4);
        }

        .reticle-icon {
          width: 64px;
          height: 64px;
        }

        .follow-btn.active .reticle-icon {
          animation: pulse-reticle 2s infinite;
        }

        @keyframes pulse-reticle {
          0% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.15); opacity: 0.8; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

const ensureMapLoaded = (map: maplibregl.Map) => {
  return new Promise<void>((resolve) => {
    if (map.isStyleLoaded()) resolve();
    else map.once('idle', () => resolve());
  });
};
