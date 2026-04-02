import maplibregl from 'maplibre-gl';
import { haversineDist } from '../utils/geo';
import type { Coords } from '../utils/geo';
import { chQuery } from '../clickhouse';
import { getRouteEmoji } from '../getRouteEmoji';
import { $gameBounds, $playerSettings, $isFollowing } from '../store';
import { getCrowKmColor } from './layers';
import { hsl } from 'd3';

let lastUpdatePos: Coords | null = null;
let lastUpdateTime = 0;
let isStopsLayerVisible = false;

export const updateStops = async (map: maplibregl.Map) => {
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
    FROM transitous_everything_${$gameBounds.get().league}_stop_statistics_unmerged3
    WHERE stop_lat BETWEEN ${bounds.getSouth()} AND ${bounds.getNorth()}
      AND stop_lon BETWEEN ${bounds.getWest()} AND ${bounds.getEast()}
    ORDER BY crow_km desc
    LIMIT ${$playerSettings.get().maxStops}
  `;

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
