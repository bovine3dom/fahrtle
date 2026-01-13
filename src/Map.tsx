import { onMount, onCleanup, createEffect } from 'solid-js';
import { useStore } from '@nanostores/solid';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { $players, submitWaypoint, $departureBoardResults, $clock, $stopTimeZone, $playerTimeZone, $myPlayerId, $previewRoute, $boardMinimized, $playerSpeeds } from './store';
import { getServerTime } from './time-sync';
import { playerPositions } from './playerPositions';
import { latLngToCell, cellToBoundary, gridDisk } from 'h3-js';
import { chQuery } from './clickhouse';
import { getTimeZone } from './timezone';
import { getRouteEmoji } from './getRouteEmoji';
import { interpolateSpectral } from 'd3';
const haversineDist = (coords1: [number, number], coords2: [number, number]) => {
  const toRad = (x: number) => x * Math.PI / 180;
  const R = 6371; // km
  const dLat = toRad(coords2[1] - coords1[1]);
  const dLon = toRad(coords2[0] - coords1[0]);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(coords1[1])) * Math.cos(toRad(coords2[1])) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

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

// Convert crow_km to color (0-100km range)
// Higher km = better connectivity = cooler colors (purple/blue)
// Lower km = worse connectivity = warmer colors (red/orange)
const getCrowKmColor = (crowKm: number): string => {
  const normalized = Math.min(crowKm / 100, 1); // Normalize to 0-1
  // Invert so higher values get cooler colors (spectral goes red->purple)
  return interpolateSpectral(normalized);
};

// Fetch and update stops based on map bounds
const updateStops = async (map: maplibregl.Map) => {
  const zoom = map.getZoom();
  if (zoom < 14) {
    // Clear stops if zoom is too low
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

export default function MapView() {
  let mapContainer: HTMLDivElement | undefined;
  let frameId: number;

  onMount(() => {
    console.log('[Map] Component Mounted. Container Ref:', mapContainer);

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

      mapInstance!.addSource('stops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
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

      let clickTimeout: any = null;

      mapInstance!.on('dblclick', (e) => {
        if (clickTimeout) {
          clearTimeout(clickTimeout);
          clickTimeout = null;
        }
        submitWaypoint(e.lngLat.lat, e.lngLat.lng);
      });

      mapInstance!.on('click', (e) => {
        if (clickTimeout) clearTimeout(clickTimeout);

        clickTimeout = setTimeout(() => {
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
          const query = `
            SELECT *
            -- FROM transitous_everything_stop_times_one_day_even_saner  -- switch to _edgelist_fahrtle
            FROM transitous_everything_edgelist_fahrtle
            WHERE h3 IN (${h3Conditions})
              AND (toHour(departure_time) > ${hour} OR (toHour(departure_time) = ${hour} AND toMinute(departure_time) >= ${minute}))
            ORDER by departure_time asc
            LIMIT 40
          `;

          // ideally would check if there is only one stop on the service (i.e. ours) and exclude them
          function toRad(deg: number) {
            return deg * Math.PI / 180;
          }

          function toDeg(rad: number) {
            return rad * 180 / Math.PI;
          }

          function getBearing(startLat: number, startLon: number, destLat: number, destLon: number) {
            const y = Math.sin(toRad(destLon - startLon)) * Math.cos(toRad(destLat));
            const x = Math.cos(toRad(startLat)) * Math.sin(toRad(destLat)) -
              Math.sin(toRad(startLat)) * Math.cos(toRad(destLat)) * Math.cos(toRad(destLon - startLon));

            let brng = toDeg(Math.atan2(y, x));
            return (brng + 360) % 360; // Normalize to 0-360
          }

          chQuery(query)
            .then(res => {
              if (res && res.data) {
                const data = res.data.map(row => {
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

      // Update stops on map move/zoom
      mapInstance!.on('moveend', () => {
        if (mapInstance) updateStops(mapInstance);
      });
      mapInstance!.on('zoomend', () => {
        if (mapInstance) updateStops(mapInstance);
      });

      // Initial load of stops
      updateStops(mapInstance!);

      startAnimationLoop();
    });
  });

  createEffect(() => {
    const preview = useStore($previewRoute)();
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

  const startAnimationLoop = () => {
    let frameCount = 0;
    let lastSpeedUpdate = 0;

    const loop = () => {
      if (!mapInstance) return;

      const now = getServerTime();
      const allPlayers = $players.get();
      const currentSpeeds: Record<string, number> = {};

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

              // Calculate speed for this segment
              // Distance (km) / Time (hours)
              const dist = haversineDist(seg.start, seg.end);
              const durationHours = (seg.endTime - seg.startTime) / (1000 * 60 * 60);
              const speed = durationHours > 0 ? dist / durationHours : 0;
              currentSpeeds[pid] = speed;
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

          const myId = $myPlayerId.get();
          if (pid === myId && frameCount % 60 === 0) {
            const zone = getTimeZone(currentPos[1], currentPos[0]);
            if ($playerTimeZone.get() !== zone) {
              $playerTimeZone.set(zone);
            }
          }
        }
      }
      frameCount++;

      const vSource = mapInstance.getSource('vehicles') as maplibregl.GeoJSONSource;
      const rSource = mapInstance.getSource('routes') as maplibregl.GeoJSONSource;

      if (vSource) vSource.setData({ type: 'FeatureCollection', features: vehicleFeatures });
      if (rSource) rSource.setData({ type: 'FeatureCollection', features: routeFeatures });

      // Throttle speed updates to 500ms
      if (Date.now() - lastSpeedUpdate > 500) {
        $playerSpeeds.set(currentSpeeds);
        lastSpeedUpdate = Date.now();
      }

      frameId = requestAnimationFrame(loop);
    };
    loop();
  };

  onCleanup(() => {
    cancelAnimationFrame(frameId);
    mapInstance?.remove();
  });

  return <div ref={mapContainer} style={{ width: '100%', height: '100vh', background: '#e5e5e5' }} />;
}
