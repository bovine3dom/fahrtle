import maplibregl from 'maplibre-gl';
import { haversineDist, getBearing } from '../utils/geo';

export function getPointer(map: maplibregl.Map, targetLat: number, targetLng: number): { x: number, y: number, bearing: number, distance: number } | null {
  const targetLngLat = new maplibregl.LngLat(targetLng, targetLat);
  const bounds = map.getBounds();

  if (bounds.contains(targetLngLat)) return null;

  const canvas = map.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const paddingX = 120;
  const paddingY = 40;

  const centerMap = map.getCenter();
  const centerScreen = map.project(centerMap);
  const targetScreen = map.project(targetLngLat);

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

  const pointerLngLat = map.unproject([intersection.x, intersection.y]);
  const bearing = getBearing(pointerLngLat.lat, pointerLngLat.lng, targetLat, targetLng);
  const distance = haversineDist({ lat: centerMap.lat, lon: centerMap.lng }, { lat: targetLat, lon: targetLng }) || 0;

  return { x: intersection.x, y: intersection.y, bearing, distance };
}
