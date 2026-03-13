type PlayerSetting = {
  type: 'text' | 'color' | 'boolean' | 'select' | 'number';
  value: string | boolean | number | undefined;
  description: string;
  hidden?: boolean;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
};

export const defaultPlayerSettings: Record<string, PlayerSetting> = {
  baseMap: { type: 'select', value: 'Toner-like', description: 'Base map', options: ['Positron', 'Bright', 'OSM Carto', 'Toner-like', 'Liberty (3D)', 'Virtual Earth'] },
  publicTransportLayer: { type: 'boolean', value: true, description: 'Draw OSM public transport routes' },
  name: { type: 'text', value: undefined, description: 'Callsign', hidden: true }, // hide for now until we can change while in progress
  color: { type: 'color', value: undefined, description: 'Player colour' },
  walkConfirm: { type: 'boolean', value: false, description: 'Require confirmation before walking' },
  hidePotentialDuplicateDepartures: { type: 'boolean', value: true, description: 'Hide duplicate departures (may hide some sleepers)' },
  maxStops: { type: 'number', value: 50, description: 'Maximum stops to show', min: 0, max: 1000 },
  showWaypoints: { type: 'boolean', value: true, description: 'Always show waypoints on map' },
  autoZoom: { type: 'boolean', value: true, description: 'Auto zoom' },
  autoFollow: { type: 'boolean', value: true, description: 'Auto follow' },
  hillShade: { type: 'boolean', value: true, description: 'Hillshade' },
  bathymetry: { type: 'boolean', value: true, description: 'Water depths' },
  debug: { type: 'boolean', value: false, description: 'Show debug buttons next to departures' },
  railwaysLayer: { type: 'select', value: 'Disabled', description: 'Railways layer (can be laggy)', options: ['Disabled', 'Infrastructure', 'Speed', 'Electrification', 'Gauge'] },
  terrain3d: { type: 'boolean', value: false, description: '3D terrain' },
  firstPersonFollow: { type: 'boolean', value: false, description: 'Follow camera first person' },
}
