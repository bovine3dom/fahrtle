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
  name: { type: 'text', value: undefined, description: 'Callsign', hidden: true }, // hide for now until we can change while in progress
  color: { type: 'color', value: undefined, description: 'Player colour' },
  autoZoom: { type: 'boolean', value: true, description: 'Auto zoom' },
  autoFollow: { type: 'boolean', value: true, description: 'Auto follow' },
  baseMap: { type: 'select', value: 'Positron', description: 'Base map', options: ['Positron', 'Bright', 'OSM Carto', 'Toner-like', 'Liberty (3D)', 'Transport', 'Transport dark', 'Virtual Earth'] },
  publicTransportLayer: { type: 'boolean', value: false, description: 'Draw OSM public transport routes' },
  railwaysLayer: { type: 'select', value: 'Disabled', description: 'Railways layer', options: ['Disabled', 'Infrastructure', 'Speed', 'Electrification', 'Gauge'] },
  hillShade: { type: 'boolean', value: true, description: 'Hillshade' },
  terrain3d: { type: 'boolean', value: false, description: '3D terrain' },
  bathymetry: { type: 'boolean', value: true, description: 'Water depths' },
  debug: { type: 'boolean', value: false, description: 'Show debug buttons next to departures' },
  firstPersonFollow: { type: 'boolean', value: false, description: 'Follow camera first person' },
  maxStops: { type: 'number', value: 250, description: 'Maximum stops to show', min: 0, max: 1000 },
  showWaypoints: { type: 'boolean', value: true, description: 'Always show waypoints on map' },
  hidePotentialDuplicateDepartures: { type: 'boolean', value: true, description: 'Hide duplicate departures (may hide some sleepers)' },
  walkConfirm: { type: 'boolean', value: false, description: 'Require confirmation before walking' },
}
