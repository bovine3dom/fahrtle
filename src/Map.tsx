// ==> src/Map.tsx <==
import { onMount, onCleanup } from 'solid-js';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { $players, submitWaypoint, $departureBoardResults, $clock } from './store';
import { getServerTime } from './time-sync';
import { playerPositions } from './playerPositions';
import { latLngToCell, cellToBoundary, gridDisk } from 'h3-js';
import { chQuery } from './clickhouse';

const lerp = (v0: number, v1: number, t: number) => v0 * (1 - t) + v1 * t;
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

export default function MapView() {
  let mapContainer: HTMLDivElement | undefined;
  let frameId: number;

  onMount(() => {
    console.log('[Map] Component Mounted. Container Ref:', mapContainer);

    if (!mapContainer) {
      console.error('[Map] Fatal: Map container ref is missing!');
      return;
    }

    // Check container dimensions
    const rect = mapContainer.getBoundingClientRect();
    console.log(`[Map] Container Dimensions: ${rect.width}x${rect.height}`);
    if (rect.height === 0) {
      console.warn('[Map] Warning: Container height is 0. Map may be invisible.');
    }

    try {
      mapInstance = new maplibregl.Map({
        container: mapContainer,
        // Using a reliable style fallback if needed:
        style: 'https://tiles.openfreemap.org/styles/positron',
        center: [-3.1883, 55.9533],
        zoom: 14,
        fadeDuration: 0,
        doubleClickZoom: false,
      });
      console.log('[Map] Instance created.');
    } catch (err) {
      console.error('[Map] Error creating MapLibre instance:', err);
      return;
    }

    mapInstance.on('error', (e) => {
      console.error('[Map] Internal Map Error:', e);
    });

    mapInstance.on('load', () => {
      console.log('[Map] "load" event fired. Initializing layers...');

      mapInstance!.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      mapInstance!.addLayer({
        id: 'routes-line', type: 'line', source: 'routes',
        paint: { 'line-color': '#888', 'line-width': 2, 'line-opacity': 0.5 }
      });

      mapInstance!.addSource('vehicles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
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

      mapInstance!.on('dblclick', (e) => {
        console.log('[Map] Double-clicked at', e.lngLat);
        submitWaypoint(e.lngLat.lat, e.lngLat.lng);
      });

      mapInstance!.on('click', (e) => {
        const h3Index = latLngToCell(e.lngLat.lat, e.lngLat.lng, 11);
        const neighborhood = gridDisk(h3Index, 2);
        console.log(`[Map] Click at ${e.lngLat.lat}, ${e.lngLat.lng} | H3: ${h3Index} | Neighbors: ${neighborhood.length}`);

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

          // Briefly paint: Clear after 1 second
          setTimeout(() => {
            if (mapInstance) {
              const s = mapInstance.getSource('h3-cell') as maplibregl.GeoJSONSource;
              if (s) s.setData({ type: 'FeatureCollection', features: [] });
            }
          }, 1000);
        }

        // Query ClickHouse for all H3 indices in the neighborhood
        // Filter by current game clock (Hour and Minute)
        const d = new Date($clock.get());
        const hour = d.getHours();
        const minute = d.getMinutes();

        const h3Conditions = neighborhood.map(idx => `reinterpretAsUInt64(reverse(unhex('${idx}')))`).join(', ');
        const query = `
          SELECT * 
          FROM transitous_everything_stop_times_one_day_even_saner 
          WHERE h3 IN (${h3Conditions})
            AND (toHour(departure_time) > ${hour} OR (toHour(departure_time) = ${hour} AND toMinute(departure_time) >= ${minute}))
          ORDER by departure_time asc
          LIMIT 10
        `;

        chQuery(query)
          .then(res => {
            console.log(`[ClickHouse] Results for neighborhood of ${h3Index}:`, res);
            if (res && res.data) {
              $departureBoardResults.set(res.data);
            }
          })
          .catch(err => console.error(`[ClickHouse] Query failed for ${h3Index}:`, err));
      });

      console.log('[Map] Starting animation loop...');
      startAnimationLoop();
    });
  });

  const startAnimationLoop = () => {
    let frameCount = 0;
    const loop = () => {
      if (!mapInstance) return;
      frameCount++;

      // Log once every ~60 frames so console isn't flooded
      if (frameCount % 120 === 0) {
        // console.log('[Map] Animation Heartbeat. Players:', Object.keys($players.get()).length);
      }

      const now = getServerTime();
      const allPlayers = $players.get();

      const vehicleFeatures: any[] = [];
      const routeFeatures: any[] = [];

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

        let currentPos = null;

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
              break;
            }
          }
        }

        if (currentPos) {
          playerPositions[pid] = currentPos as [number, number];
          vehicleFeatures.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: currentPos },
            properties: { id: player.id, color: player.color }
          });
        }
      }

      const vSource = mapInstance.getSource('vehicles') as maplibregl.GeoJSONSource;
      const rSource = mapInstance.getSource('routes') as maplibregl.GeoJSONSource;

      if (vSource) vSource.setData({ type: 'FeatureCollection', features: vehicleFeatures });
      if (rSource) rSource.setData({ type: 'FeatureCollection', features: routeFeatures });

      frameId = requestAnimationFrame(loop);
    };
    loop();
  };

  onCleanup(() => {
    console.log('[Map] Cleaning up...');
    cancelAnimationFrame(frameId);
    mapInstance?.remove();
  });

  // Ensure this div takes up space!
  return <div ref={mapContainer} style={{ width: '100%', height: '100vh', background: '#e5e5e5' }} />;
}
