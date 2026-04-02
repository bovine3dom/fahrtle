import { onMount, onCleanup, createEffect, createMemo, createSignal, untrack, Show, For } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { useStore } from '@nanostores/solid';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { $players, submitWaypoint, $departureBoardResults, $clock, $previewRoute, $boardMinimized, $pickerMode, $pickedPoint, $gameBounds, $roomState, $isFollowing, submitWaypointsBatch, $mapZoom, $lastClickContext, $playerSettings, $departureBoardPage, $departureBoardLoadingMore, $departureBoardHasMore, $boardMode, sendPing, $myPlayerId, $playerSpeeds } from './store';
import { playerPositions } from './playerPositions';
import { latLngToCell, cellToBoundary, gridDisk } from 'h3-js';
import { chQuery } from './clickhouse';
import { sensibleNumber } from './utils/format';
import { throttle } from 'throttle-debounce';
import { getBeforeId } from './utils/layer_order';
import { getBearing, haversineDist } from './utils/geo';
import { NightLayer } from 'maplibre-gl-nightlayer';
import { updateBasemap, updateRailwaysLayer, updateTransportLayer, updateBathymetryLayer, updateHillShadeLayer, updateTerrain } from './map/layers';
import { updateStops } from './map/stops';
import { getPointer } from './map/pointers';
import { startAnimationLoop, type AnimationLoopConfig } from './map/animationLoop';
import { handleMapClickForDepartures } from './map/clickHandlers';
import type { DepartureResult } from './store';

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

export function getMapInstance() {
  return mapInstance;
}

const NIGHT_LAYER = new NightLayer({opacity: 0.5});

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
    box.extend([bounds.start[1], bounds.start[0]]);
    box.extend([bounds.finish[1], bounds.finish[0]]);
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

function updatePlayerMarkers(allPlayers: Record<string, any>, playerPositions: Record<string, [number, number]>, playerMarkers: Map<string, maplibregl.Marker>) {
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
}

export default function MapView() {
  let mapContainer: HTMLDivElement | undefined;
  let cancelAnimation: (() => void) | undefined;
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

    mapInstance.on('load', () => {
      mapInstance.boxZoom.disable();
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
        !import.meta.env.PROD && import('./utils/tiny-countries').then(({ getCountry, countryToFlag }) => {
          getCountry({lat: e.lngLat.lat, lon: e.lngLat.lng}).then((c) => console.log(countryToFlag(c || '')));
        });

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
          handleMapClickForDepartures(mapInstance, e.lngLat.lat, e.lngLat.lng, e.originalEvent.shiftKey);
          clickTimeout = null;
        }, 300);
      });

      if (mapInstance) {
        throttledUpdate();
      }
      setMapReady(true);
      startAnimationLoopWithConfig();
    });

    const startAnimationLoopWithConfig = () => {
      const config: AnimationLoopConfig = {
        map: mapInstance,
        onSmoothedBearingChange: () => {},
        onUpdatePointers: (pointers) => { setPlayerPointers(reconcile(pointers, { key: 'pid' })); },
        onUpdatePingPointers: (pointers) => { setPingPointers(pointers); },
        onFinishPointer: (pointer) => { setFinishPointer(pointer); },
        onUpdatePlayerMarkers: () => {
          updatePlayerMarkers($players.get(), playerPositions, playerMarkers);
        },
        getPointer: (lat, lng) => getPointer(mapInstance, lat, lng),
      };
      cancelAnimation = startAnimationLoop(mapInstance, config);
    };

    const context = useStore($lastClickContext);
    const boardPage = useStore($departureBoardPage);

    const buildQuery = (queryMode: 'departures' | 'arrivals', ctx: NonNullable<ReturnType<typeof context>>, offset: number = 0) => {
      const timeField = queryMode === 'departures' ? 'departure_time' : 'next_arrival';
      const h3Field = queryMode === 'departures' ? 'h3' : 'next_h3';
      const limBy = $playerSettings.get().hidePotentialDuplicateDepartures ? `
          LIMIT 1 BY
            source,
            departure_time,
            h3ToParent(next_h3, 9)
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
            FROM transitous_everything_${$gameBounds.get().league}_edgelist_fahrtle2
            WHERE ${h3Field} IN (${ctx.h3Conditions})
            ORDER by sort_time ASC, travel_time ASC
            ${limByInner}
            LIMIT 1000
          )
          ORDER BY geoDistance(stop_lon, stop_lat, final_lon, final_lat) DESC, travel_time ASC
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
        row.bearing_origin = getBearing(row.next_lat, row.next_lon, row.initial_lat, row.initial_lon);
        const dist = haversineDist({ lat: row.stop_lat, lon: row.stop_lon }, {
          lat: row[currentMode === 'departures' ? 'final_lat' : 'initial_lat'],
          lon: row[currentMode === 'departures' ? 'final_lon' : 'initial_lon'],
        });
        const start = new Date(row.initial_arrival || "");
        const finish = new Date(row.final_arrival || "");
        if (finish < start) finish.setDate(finish.getDate() + 1);
        row.dist = dist || 0;
        const duration = (finish.getTime() - start.getTime()) / (1000 * 60 * 60);
        row.speed = duration > 0 ? (dist || 0) / duration : 0;
        return row;
      });
    };

    createEffect(() => {
      const ctx = context();
      if (ctx === null) return;
      ctx.clickTime;

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
      updateBasemap(mapInstance, setting);
      updateBathymetryLayer(mapInstance, setting);
    });

    createEffect(() => {
      const setting = playerSettings().railwaysLayer;
      updateRailwaysLayer(mapInstance, setting);
    });

    createEffect(() => {
      const setting = playerSettings().publicTransportLayer || (["Transport dark", "Transport"].includes(playerSettings().baseMap));
      updateTransportLayer(mapInstance, setting);
    });

    createEffect(() => {
      const setting = playerSettings().bathymetry;
      updateBathymetryLayer(mapInstance, setting);
    });

    createEffect(() => {
      const setting = playerSettings().hillShade;
      updateHillShadeLayer(mapInstance, setting);
    });

    createEffect(() => {
      const setting = playerSettings().terrain3d;
      updateTerrain(mapInstance, setting);
    });

    const simTime = useStore($clock);
    let i = 0;
    createEffect(async () => {
      simTime();
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

        if (!(player.id == 'the-stig-🏎️') && playerSettings().showWaypoints) {
          const pointFeatures = player.waypoints
            .filter(wp => wp.stopName && !wp.isWalk && !wp.isWait)
            .map(wp => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [wp.x, wp.y] },
              properties: {
                stop_name: wp.stopName,
                arrival_time: wp.timeStr || "",
                opacity: player.isGhost ? 0 : 1,
                color: player.color
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
  const isFinished = createMemo(() => players()[myId() || '']?.finishTime != null);
  createEffect(async () => {
    const finished = isFinished();
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

  onCleanup(() => {
    cancelAnimation?.();
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
