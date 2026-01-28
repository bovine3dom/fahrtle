import { type Map } from 'maplibre-gl';

// nb: "starts with" rather than exact match, painter's algorithm
// todo: rename layers to be less insane
const ideal_hierarchy: string[] = [
  "basemap-", 
  "mapterhorn-layer",
  "openrailwaymap-layer",
  "course-markers-h3-filled", // finish area hexes
  "course-markers-icon", // start and finish icons
  "course-markers-label", // start and finish text labels
  "routes-casing", // wtf is this? tood: investigate
  "routes-line", // player tracks
  "h3-cell-line", // pink hex departure board 'search area' on click
  "preview-route-line", // route preview
  "stops-layer", // stops for departure boards
] as const; // const ... as const. great language

type HierarchyPrefix = (typeof ideal_hierarchy)[number];

// -1 if fails => everything draws on top -> unwise?
function getPriorityIndex(layerId: string): number {
  return ideal_hierarchy.findIndex(prefix => layerId.startsWith(prefix));
}

export function getBeforeId(
  newLayerPrefix: HierarchyPrefix, 
  mapInstance: Map
): string | undefined {
  const targetPriority = ideal_hierarchy.indexOf(newLayerPrefix);
  const currentLayers = mapInstance.getLayersOrder();
  const bingo = currentLayers.find(layer => getPriorityIndex(layer) > targetPriority) || undefined;
  console.log(newLayerPrefix, bingo);
  return bingo;
}
