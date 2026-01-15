import { onMount, onCleanup, createEffect, createSignal, untrack } from 'solid-js';
import { useStore } from '@nanostores/solid';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { $players, submitWaypoint, $departureBoardResults, $clock, $stopTimeZone, $playerTimeZone, $myPlayerId, $previewRoute, $boardMinimized, $playerSpeeds, $playerDistances, $pickerMode, $pickedPoint, $gameBounds, $roomState, $gameStartTime, finishRace } from './store';
import { getServerTime } from './time-sync';
import { playerPositions } from './playerPositions';
import { latLngToCell, cellToBoundary, gridDisk } from 'h3-js';
import { chQuery } from './clickhouse';
import { getTimeZone } from './timezone';
import { getRouteEmoji } from './getRouteEmoji';
import { interpolateSpectral } from 'd3';
import { haversineDist, lerp, getBearing } from './utils/geo';

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

const updateStops = async (map: maplibregl.Map) => {
  const zoom = map.getZoom();
  if (zoom < 14) {
    const source = map.getSource('stops') as maplibregl.GeoJSONSource;
    if (source) {
      source.setData({ type: 'FeatureCollection', features: [] });
    }
    return;
  }

  const bounds = map.getBounds();
  const query = `
    SELECT DISTINCT
      crow_km,
      stop_lat,
      stop_lon,
      stop_name,
      route_type
    FROM transitous_everything_stop_statistics${zoom >= 16 ? "_unmerged" : ""}
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
    console.error('[Map] Failed to fetch stops:', err);
  }
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
      mapInstance = new maplibregl.Map({
        container: mapContainer,
        style: STYLE,
        center: [-3.1883, 55.9533],
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

      if (!params.has('transport')) {
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
      }

      mapInstance!.addSource('course-markers', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      mapInstance!.addSource('course-markers-h3', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      mapInstance!.addLayer({
        id: 'h3-cell-line', type: 'fill', source: 'course-markers-h3',
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

      mapInstance!.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

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

      mapInstance!.addSource('vehicles', {
        type: 'geojson', data: { type: 'FeatureCollection', features: [] },
        attribution: '<a href="https://github.com/bovine3dom/fahrtle?tab=readme-ov-file#fahrtle" target="_blank">❤️ bovine3dom & fahrtle</a>'
      });
      mapInstance!.addLayer({
        id: 'vehicles-circle', type: 'circle', source: 'vehicles',
        paint: {
          'circle-radius': 6,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff'
        }
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
          'line-color': ['get', 'color'],
          'line-width': 4,
          'line-dasharray': [2, 1]
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

      mapInstance!.on('dblclick', (e) => {
        if (clickTimeout) {
          clearTimeout(clickTimeout);
          clickTimeout = null;
        }
        if ($pickerMode.get()) return;
        submitWaypoint(e.lngLat.lat, e.lngLat.lng);
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

          const h3Conditions = neighborhood.map(idx => `reinterpretAsUInt64(reverse(unhex('${idx}')))`).join(', ');
          const targetMinutes = hour * 60 + minute;
          const query = `
            SELECT *
            FROM transitous_everything_edgelist_fahrtle
            WHERE h3 IN (${h3Conditions})
            ORDER by (
              ((toHour(departure_time) * 60 + toMinute(departure_time)) - ${targetMinutes} + 1440) % 1440
            ) ASC
            LIMIT 100
          `;

          chQuery(query)
            .then(res => {
              if (res && res.data) {
                const data = res.data.map((row: any) => {
                  row.bearing = getBearing(row.stop_lat, row.stop_lon, row.next_lat, row.next_lon);
                  return row;
                })
                $departureBoardResults.set(data);
                $boardMinimized.set(false);
              }
            })
            .catch(err => console.error(`[ClickHouse] Query failed:`, err));

          clickTimeout = null;
        }, 300);
      });

      mapInstance!.on('moveend', () => {
        if (mapInstance) updateStops(mapInstance);
      });
      mapInstance!.on('zoomend', () => {
        if (mapInstance) updateStops(mapInstance);
      });

      updateStops(mapInstance!);
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

  const Preview = useStore($previewRoute);
  createEffect(() => {
    const preview = Preview();
    if (!mapInstance || !mapInstance.isStyleLoaded()) return;

    const source = mapInstance.getSource('preview-route') as maplibregl.GeoJSONSource;
    if (!source) return;

    if (preview) {
      source.setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: preview.coordinates },
        properties: { color: preview.color }
      });

      if (preview.coordinates.length > 0) {
        const bounds = new maplibregl.LngLatBounds();
        preview.coordinates.forEach(coord => bounds.extend(coord as [number, number]));
        mapInstance.fitBounds(bounds, { padding: 80, duration: 1500 });
      }
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
    let lastFrameTime = 0;
    const FRAME_INTERVAL = 1000 / 30; // 30 FPS
    let frameCount = 0;

    const loop = (timestamp: number) => {
      frameId = requestAnimationFrame(loop);
      frameCount++;

      if (timestamp - lastFrameTime < FRAME_INTERVAL) return;
      lastFrameTime = timestamp;

      if (!mapInstance) return;

      const now = getServerTime();
      const allPlayers = $players.get();
      const currentSpeeds: Record<string, number> = {};
      const currentDists: Record<string, number | null> = {};
      const vehicleFeatures: any[] = [];

      const isRunning = $roomState.get() === 'RUNNING';
      const startTime = $gameStartTime.get();

      for (const pid in allPlayers) {
        const player = allPlayers[pid];

        let currentPos: [number, number] | null = null;

        if (player.segments.length === 0) {
          if (player.waypoints.length > 0) {
            const p = player.waypoints[0];
            currentPos = [p.x, p.y];
          }
        } else {
          const last = player.segments[player.segments.length - 1];
          currentPos = last.end;

          for (const seg of player.segments) {
            if (now >= seg.startTime && now < seg.endTime) {
              const t = (now - seg.startTime) / (seg.endTime - seg.startTime);
              currentPos = [
                lerp(seg.start[0], seg.end[0], t),
                lerp(seg.start[1], seg.end[1], t)
              ];

              const dist = haversineDist(seg.start, seg.end);
              const durationHours = (seg.endTime - seg.startTime) / (1000 * 60 * 60);
              const speed = durationHours > 0 ? dist / durationHours : 0;
              currentSpeeds[pid] = speed;
              break;
            }
          }

          const b = $gameBounds.get().finish;
          const distToFinish = haversineDist(currentPos, b?.length === 2 ? [b[1], b[0]] : null); // lat lng vs lng lat bane of my life
          currentDists[pid] = distToFinish;
        }

        if (currentPos) {
          playerPositions[pid] = currentPos as [number, number];
          vehicleFeatures.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: currentPos },
            properties: { id: player.id, color: player.color }
          });

          const myId = $myPlayerId.get();
          if (pid === myId) {
            if (frameCount % 60 === 0) {
              const zone = getTimeZone(currentPos[1], currentPos[0]);
              if ($playerTimeZone.get() !== zone) {
                $playerTimeZone.set(zone);
              }
            }
            if (isRunning && startTime && !player.finishTime && finishCells.length > 0) {
              if (frameCount % 10 === 0) {
                try {
                  const myCell = latLngToCell(currentPos[1], currentPos[0], 11);
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

      const vSource = mapInstance.getSource('vehicles') as maplibregl.GeoJSONSource;

      if (vSource) vSource.setData({ type: 'FeatureCollection', features: vehicleFeatures });

      $playerSpeeds.set(currentSpeeds);
      $playerDistances.set(currentDists);
    };
    requestAnimationFrame(loop);
  };

  onCleanup(() => {
    cancelAnimationFrame(frameId);
    mapInstance?.remove();
  });

  return <div ref={mapContainer} style={{ width: '100%', height: '100%', background: '#e5e5e5' }} />;
}
