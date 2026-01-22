import { onMount, onCleanup, createEffect, createSignal, untrack, Show, For } from 'solid-js';
import { useStore } from '@nanostores/solid';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { $players, submitWaypoint, $departureBoardResults, $clock, $stopTimeZone, $playerTimeZone, $myPlayerId, $previewRoute, $boardMinimized, $playerSpeeds, $playerDistances, $pickerMode, $pickedPoint, $gameBounds, $roomState, $gameStartTime, finishRace, $globalRate, $isFollowing, type DepartureResult, submitWaypointsBatch, $mapZoom, $boardMode, $lastClickContext } from './store';
import { getServerTime } from './time-sync';
import { playerPositions } from './playerPositions';
import { latLngToCell, cellToBoundary, gridDisk } from 'h3-js';
import { chQuery } from './clickhouse';
import { getTimeZone } from './timezone';
import { getRouteEmoji } from './getRouteEmoji';
import { interpolateSpectral } from 'd3';
import { haversineDist, lerp, getBearing } from './utils/geo';
import { sensibleNumber } from './utils/format';
import { throttle } from 'throttle-debounce';

let mapInstance: maplibregl.Map | undefined;

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
  const normalized = Math.min(crowKm / 100, 1);
  return interpolateSpectral(normalized);
};

let lastUpdatePos: [number, number] | null = null;
let lastUpdateTime = 0;
let isStopsLayerVisible = false;

const updateStops = async (map: maplibregl.Map) => {
  const zoom = map.getZoom();
  if (zoom < 14) {
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
    const dist = haversineDist([center.lng, center.lat], lastUpdatePos);
    // don't update if we haven't moved at least 100m and it's been less than 5 seconds
    if (dist !== null && dist < 0.1 && (now - lastUpdateTime) < 5000) {
      return;
    }
  }

  lastUpdatePos = [center.lng, center.lat];
  lastUpdateTime = now;

  const bounds = map.getBounds();
  const query = `
    SELECT DISTINCT
      crow_km,
      stop_lat,
      stop_lon,
      stop_name,
      route_type
    FROM transitous_everything_20260117_stop_statistics${zoom >= 16 ? "_unmerged" : ""}
    WHERE stop_lat BETWEEN ${bounds.getSouth()} AND ${bounds.getNorth()}
      AND stop_lon BETWEEN ${bounds.getWest()} AND ${bounds.getEast()}
    LIMIT 500
  `;

  try {
    const res = await chQuery(query);
    if (res && res.data) {
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
          color: getCrowKmColor(stop.crow_km || 0)
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
  const distance = haversineDist([centerMap.lat, centerMap.lng], [targetLat, targetLng]) || 0;

  return { x: intersection.x, y: intersection.y, bearing, distance };
};

let STYLE: string | maplibregl.StyleSpecification = "https://tiles.openfreemap.org/styles/positron"

const params = new URLSearchParams(window.location.search)

if (params.has('transport')) {
  STYLE = {
    'version': 8,
    'sources': {
      'raster-tiles': {
        'type': 'raster',
        'tiles': [
          `https://tile.thunderforest.com/transport/{z}/{x}/{y}@2x.png?apikey=${import.meta.env.VITE_THUNDERFOREST_API_KEY}`,
        ],
        'tileSize': 256,
        'attribution':
          '<a href="https://www.thunderforest.com/" target="_blank">&copy; Thunderforest</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>'
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
}



export default function MapView() {
  let mapContainer: HTMLDivElement | undefined;
  let frameId: number;
  const [mapReady, setMapReady] = createSignal(false);
  const isFollowing = useStore($isFollowing);
  const [finishPointer, setFinishPointer] = createSignal<{ x: number, y: number, bearing: number, distance: number } | null>(null);
  const [playerPointers, setPlayerPointers] = createSignal<{ pid: string, pointer: { x: number, y: number, bearing: number, distance: number } }[]>([]);
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
        style: STYLE,
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

    mapInstance.on('load', () => {

      // todo: make configurable
      mapInstance!.addSource('mapterhorn', {
        type: 'raster-dem',
        url: 'https://tiles.mapterhorn.com/tilejson.json',
        maxzoom: 15,
      });
      mapInstance!.addLayer({
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
      });

      mapInstance!.addSource('openrailwaymap', {
        type: 'raster',
        tiles: ['https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '&copy; <a href="https://www.openrailwaymap.org">OpenRailwayMap</a>'
      });
      mapInstance!.addLayer({
        id: 'openrailwaymap-layer',
        type: 'raster',
        source: 'openrailwaymap',
        paint: { 'raster-opacity': 1 }
      });

      mapInstance!.addSource('course-markers', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      mapInstance!.addSource('course-markers-h3', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      mapInstance!.addLayer({
        id: 'course-markerks-h3-filled', type: 'fill', source: 'course-markers-h3',
        paint: { 'fill-color': '#10b981', 'fill-opacity': 0.8 }
      });

      mapInstance!.addLayer({
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
      });
      mapInstance!.addLayer({
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
      });

      mapInstance!.addSource('routes', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        attribution: '<a href="https://github.com/bovine3dom/fahrtle?tab=readme-ov-file#fahrtle" target="_blank">❤️ bovine3dom & fahrtle</a>'
      });

      mapInstance!.addLayer({
        id: 'routes-casing', type: 'line', source: 'routes',
        paint: {
          'line-color': '#ffffff',
          'line-width': 7,
          'line-opacity': 1.0
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' }
      });

      mapInstance!.addLayer({
        id: 'routes-line', type: 'line', source: 'routes',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 3,
          'line-opacity': 1.0
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' }
      });

      mapInstance!.addSource('h3-cell', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      mapInstance!.addLayer({
        id: 'h3-cell-line', type: 'line', source: 'h3-cell',
        paint: { 'line-color': '#ff00ff', 'line-width': 3, 'line-opacity': 0.8 }
      });

      mapInstance!.addSource('preview-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      mapInstance!.addLayer({
        id: 'preview-route-line', type: 'line', source: 'preview-route',
        paint: {
          'line-color': '#444',
          'line-width': 6,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' }
      });

      mapInstance!.addSource('stops', {
        type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        attribution: '&copy; <a href="https://transitous.org/sources" target="_blank">Transitous et al.</a>'
      });

      mapInstance!.addLayer({
        id: 'stops-layer',
        type: 'symbol',
        source: 'stops',
        minzoom: 14,
        layout: {
          'text-field': ['get', 'emoji'],
          'text-size': 12,
          'text-allow-overlap': true,
          'text-ignore-placement': false
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#000',
          'text-halo-width': 0.1,
        }
      });

      const pickerMode = useStore($pickerMode);
      createEffect(() => {
        const mode = pickerMode();
        if (mapInstance && mapInstance.getCanvas()) {
          mapInstance.getCanvas().style.cursor = mode ? 'crosshair' : 'grab';
        }
      });

      let clickTimeout: any = null;

      const throttledUpdate = throttle(200, () => {
        if (mapInstance) {
          updateStops(mapInstance);
          $mapZoom.set(mapInstance.getZoom());
        }
      });
      mapInstance!.on('moveend', throttledUpdate);
      mapInstance!.on('zoomend', throttledUpdate);

      const disableFollowing = () => $isFollowing.set(false);
      mapInstance!.on('dragstart', disableFollowing);
      mapInstance!.on('wheel', disableFollowing);
      mapInstance!.on('touchstart', disableFollowing);
      mapInstance!.on('mousedown', (e) => {
        if (e.originalEvent.button === 0) disableFollowing();
      });

      mapInstance!.on('dblclick', (e) => {
        if (clickTimeout) {
          clearTimeout(clickTimeout);
          clickTimeout = null;
        }
        if ($pickerMode.get()) return;
        submitWaypoint(e.lngLat.lat, e.lngLat.lng);
      });

      // middle click to teleport in dev mode
      !import.meta.env.PROD && mapInstance!.on('mousedown', (e) => {
        if (e.originalEvent.button === 1) {
          submitWaypointsBatch([
            { lat: e.lngLat.lat, lng: e.lngLat.lng, time: $clock.get() },
          ])
        }
      });

      mapInstance!.on('click', (e) => {
        if (clickTimeout) clearTimeout(clickTimeout);

        clickTimeout = setTimeout(() => {
          const mode = $pickerMode.get();
          if (mode) {
            $pickedPoint.set({ lat: e.lngLat.lat, lng: e.lngLat.lng, target: mode });
            $pickerMode.set(null);
            return;
          }
          const h3Index = latLngToCell(e.lngLat.lat, e.lngLat.lng, 11);
          const neighborhood = gridDisk(h3Index, 2);

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

          const stopZone = getTimeZone(e.lngLat.lat, e.lngLat.lng);
          $stopTimeZone.set(stopZone);

          const simTime = $clock.get();
          const localDateStr = new Date(simTime).toLocaleString('en-US', { timeZone: stopZone });
          const localDate = new Date(localDateStr);
          const hour = localDate.getHours();
          const minute = localDate.getMinutes();
          $stopTimeZone.set(stopZone);

          const h3Conditions = neighborhood.map(idx => `reinterpretAsUInt64(reverse(unhex('${idx}')))`).join(', ');
          const targetMinutes = hour * 60 + minute;

          $lastClickContext.set({ h3Conditions, targetMinutes, stopTimeZone: stopZone });

          clickTimeout = null;
        }, 300);
      });

      createEffect(() => {
        const context = useStore($lastClickContext)();
        const mode = useStore($boardMode)();
        if (!context) return;

        const timeField = mode === 'departures' ? 'departure_time' : 'next_arrival';
        const h3Field = mode === 'departures' ? 'h3' : 'next_h3';

        const query = `
          SELECT *
          FROM transitous_everything_20260117_edgelist_fahrtle
          WHERE ${h3Field} IN (${context.h3Conditions})
          ORDER by (
            ((toHour(${timeField}) * 60 + toMinute(${timeField})) - ${context.targetMinutes} + 1440) % 1440
          ) ASC
          LIMIT 100
        `;

        chQuery(query)
          .then(res => {
            if (res && res.data) {
              const data = res.data.map((row: DepartureResult) => {
                row.bearing = getBearing(row.stop_lat, row.stop_lon, row.next_lat, row.next_lon);
                row.bearing_origin = getBearing(row.next_lat, row.next_lon, row.initial_lat, row.initial_lon); // for arrivals, the "next" stop is our stop
                return row;
              })
              $departureBoardResults.set(data);
              $previewRoute.set(null);
              $boardMinimized.set(false);
            }
          })
          .catch(err => console.error(`[ClickHouse] Query failed:`, err));
      });

      if (mapInstance) {
        throttledUpdate();
      }
      setMapReady(true);
      startAnimationLoop();
    });
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
      source.setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: preview.coords },
        properties: { color: '#000' }
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
          properties: { color: player.color }
        });
      }
    }

    const rSource = mapInstance.getSource('routes') as maplibregl.GeoJSONSource;
    if (rSource) {
      rSource.setData({ type: 'FeatureCollection', features: routeFeatures as any });
    }
  });

  const startAnimationLoop = () => {
    let lastFrameTime = performance.now();
    let frameCount = 0;

    const loop = (timestamp: number) => {
      frameId = requestAnimationFrame(loop);
      frameCount++;

      const dt = timestamp - lastFrameTime;
      lastFrameTime = timestamp;

      if (!mapInstance || dt < 1) return;

      const now = getServerTime();
      const allPlayers = $players.get();
      const currentSpeeds: Record<string, number> = {};
      const currentDists: Record<string, number | null> = {};
      const vehicleFeatures: any[] = [];

      const isRunning = $roomState.get() === 'RUNNING';
      const startTime = $gameStartTime.get();

      const SMOOTHING_TIME_CONSTANT = 100;
      const alpha = 1 - Math.exp(-dt / SMOOTHING_TIME_CONSTANT);
      const myId = $myPlayerId.get();
      let myTargetPos: [number, number] | null = null;
      let myTargetSpeed = 0;

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

              const dist = haversineDist(seg.start, seg.end);
              const durationHours = (seg.endTime - seg.startTime) / (1000 * 60 * 60);
              const speed = durationHours > 0 ? (dist || 0) / durationHours : 0; // never actually zero here but ts whines
              currentSpeeds[pid] = speed;
              break;
            }
          }

          const b = $gameBounds.get().finish;
          const distToFinish = haversineDist(targetPos, b?.length === 2 ? [b[1], b[0]] : null); // lat lng vs lng lat bane of my life
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

            if (frameCount % 60 === 0) {
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
                    console.log("[Client] Crossed finish line!");
                    finishRace(now - startTime);
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
              .addTo(mapInstance!);
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
        setPlayerPointers(t_playerPointers.filter(p => p.pointer !== null) as { pid: string, pointer: { x: number, y: number, bearing: number, distance: number } }[]);
      }

      if (isFollowing() && mapInstance) {
        const myPos = myTargetPos;
        const mySpeed = myTargetSpeed;
        const centre = mapInstance.getCenter();
        const approxEq = (a: number, b: number) => Math.abs(a - b) < 0.000001;

        if (myPos) {
          const REFERENCE_SPEED = 50; // km/h
          const REFERENCE_ZOOM = 15;  // zoom level at reference speed
          const MIN_ZOOM = 5;
          const MAX_ZOOM = 16;
          const dilation = $globalRate.get() / 20; // normalise to walking dilation
          const safeSpeed = Math.max(1, mySpeed * dilation || 0);

          let targetZoom = REFERENCE_ZOOM - Math.log2(safeSpeed / REFERENCE_SPEED);
          targetZoom = Math.min(Math.max(targetZoom, MIN_ZOOM), MAX_ZOOM);

          const currentZoom = mapInstance.getZoom();
          const nextZoom = lerp(currentZoom, targetZoom, alpha);

          if (!approxEq(myPos[0], centre.lng) || !approxEq(myPos[1], centre.lat) || Math.abs(currentZoom - targetZoom) > 0.01) {
            mapInstance.jumpTo({
              center: myPos,
              zoom: nextZoom
            });
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
      <div ref={mapContainer} style={{ width: '100%', height: '100%', background: '#ffed02' }} />
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
                color: '#10b981',
                "font-size": '32px',
                "text-shadow": '0 0 2px #000',
              }}
            >
              ▲
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

      <For each={playerPointers()}>
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
                color: players()[p.pid]?.color || '#fff',
                "font-size": '24px',
                "text-shadow": '0 0 1px #000',
              }}
            >
              ▲
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
