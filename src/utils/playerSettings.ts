type PlayerSetting = {
  type: 'text' | 'color' | 'boolean' | 'select';
  value: string | boolean | undefined;
  description: string;
  hidden?: boolean;
  options?: string[];
};

export const defaultPlayerSettings: Record<string, PlayerSetting> = {
  name: { type: 'text', value: undefined, description: 'Callsign', hidden: true }, // hide for now until we can change while in progress
  color: { type: 'color', value: undefined, description: 'Player colour' },
  autoZoom: { type: 'boolean', value: true, description: 'Auto zoom' },
  autoFollow: { type: 'boolean', value: true, description: 'Auto follow' },
  baseMap: { type: 'select', value: 'Positron', description: 'Base map', options: ['Positron', 'Bright', 'OSM Carto', 'Liberty (3D)', 'Transport', 'Transport dark'] },
  railwaysLayer: { type: 'select', value: 'Disabled', description: 'Railways layer', options: ['Disabled', 'Infrastructure', 'Speed', 'Electrification', 'Gauge'] },
  hillShade: { type: 'boolean', value: true, description: 'Hillshade' },
  debug: { type: 'boolean', value: false, description: 'Show debug buttons next to departures' },
}
