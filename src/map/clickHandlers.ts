import maplibregl from 'maplibre-gl';
import { latLngToCell, cellToBoundary, gridDisk } from 'h3-js';
import { getTimeZone } from '../timezone';
import { $stopTimeZone, $lastClickContext, $clock } from '../store';

export function handleMapClickForDepartures(map: maplibregl.Map, lat: number, lng: number, shiftKey: boolean = false) {
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

  const source = map?.getSource('h3-cell') as maplibregl.GeoJSONSource;
  if (source) {
    source.setData({
      type: 'FeatureCollection',
      features: features as any
    });

    setTimeout(() => {
      const s = map.getSource('h3-cell') as maplibregl.GeoJSONSource;
      if (s) s.setData({ type: 'FeatureCollection', features: [] });
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
