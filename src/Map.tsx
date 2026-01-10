import { onMount, onCleanup } from 'solid-js';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { $activeTrips, $routeLines } from './store'; // Import routeLines
import { getServerTime } from './time-sync';

const lerp = (v0: number, v1: number, t: number) => v0 * (1 - t) + v1 * t;

export default function MapView() {
  let mapContainer: HTMLDivElement | undefined;
  let mapInstance: maplibregl.Map | undefined;
  let frameId: number;

  onMount(() => {
    mapInstance = new maplibregl.Map({
      container: mapContainer!,
      style: 'https://tiles.openfreemap.org/styles/positron',
      center: [0, 0],
      zoom: 2,
      fadeDuration: 0,
    });

    mapInstance.on('load', () => {
      // --- LAYER 1: The Routes (Static Lines) ---
      mapInstance!.addSource('routes-source', {
        type: 'geojson',
        data: $routeLines.get() // Initial Empty Data
      });

      mapInstance!.addLayer({
        id: 'routes-layer',
        type: 'line',
        source: 'routes-source',
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-color': '#888',
          'line-width': 2,
          'line-opacity': 0.6
        }
      });

      // --- LAYER 2: The Vehicles (Moving Dots) ---
      mapInstance!.addSource('vehicles-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      mapInstance!.addLayer({
        id: 'vehicles-layer',
        type: 'circle',
        source: 'vehicles-source',
        paint: {
          'circle-radius': 6,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 1,
          'circle-stroke-color': '#fff'
        }
      });

      // --- REACTIVITY ---
      // When the server sends new lines, update the Route Layer immediately
      // This is low frequency (every 10s), so we can just subscribe.
      const unsub = $routeLines.subscribe((geoJson) => {
         const src = mapInstance?.getSource('routes-source') as maplibregl.GeoJSONSource;
         if (src) src.setData(geoJson);
      });

      // Start the High-Frequency loop for the dots
      startAnimationLoop();
      
      onCleanup(unsub);
    });
  });

  const startAnimationLoop = () => {
    const loop = () => {
      if (!mapInstance) return;

      const now = getServerTime();
      const trips = $activeTrips.get();
      const features = [];

      for (const id in trips) {
        const trip = trips[id];
        let pos = trip.finalPosition;

        // Logic: Find the segment matching the current time
        // This math is virtually free compared to 'turf.along'
        for (const seg of trip.segments) {
          if (now >= seg.startTime && now < seg.endTime) {
            const t = (now - seg.startTime) / (seg.endTime - seg.startTime);
            pos = [
              lerp(seg.start[0], seg.end[0], t),
              lerp(seg.start[1], seg.end[1], t)
            ];
            break; 
          }
        }

        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: pos },
          properties: { 
            id: trip.id, 
            color: trip.team === 'red' ? '#ef4444' : '#3b82f6'
          }
        });
      }

      const src = mapInstance.getSource('vehicles-source') as maplibregl.GeoJSONSource;
      if (src) src.setData({ type: 'FeatureCollection', features: features as any });

      frameId = requestAnimationFrame(loop);
    };
    loop();
  };

  onCleanup(() => cancelAnimationFrame(frameId));

  return <div ref={mapContainer} style={{ width: '100vw', height: '100vh' }} />;
}
