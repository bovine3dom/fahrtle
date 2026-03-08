import { type Map } from 'maplibre-gl';

// nb: "starts with" rather than exact match, painter's algorithm
// todo: rename layers to be less insane
const ideal_hierarchy: string[] = [
  "basemap-",
  "water-bathymetry",
  "mapterhorn-layer",
  "nightlayer",
  "openrailwaymap-layer",
  "public-transport",
  "course-markers-h3-filled", // finish area hexes
  "h3-cell-line", // pink hex departure board 'search area' on click
  "preview-route-casing", // white outline around player tracks
  "preview-route-line", // route preview
  "stops-layer", // stops for departure boards
  "routes-casing", // white outline around player tracks
  "routes-line", // player tracks
  "course-markers-icon", // start and finish icons
  "course-markers-label", // start and finish text labels
  "basemap-label",
  "basemap-place",
  "routes-labels",
  "preview-route-labels", // route preview stop names/times
] as const; // const ... as const. great language

// type HierarchyPrefix = (typeof ideal_hierarchy)[number]; // unused for now

// -1 if fails => everything draws on top -> unwise?
function getPriorityIndex(layerId: string): number {
  let bestIndex = -1;
  let longestMatchLen = 0;

  ideal_hierarchy.forEach((prefix, index) => {
    if (layerId.startsWith(prefix) && prefix.length > longestMatchLen) {
      longestMatchLen = prefix.length;
      bestIndex = index;
    }
  });

  return bestIndex;
}

export function getBeforeId(
  newLayerId: string, 
  mapInstance: Map
): string | undefined {
  const targetPriority = getPriorityIndex(newLayerId);
  const currentLayers = mapInstance.getLayersOrder();
  return currentLayers.find(layer => getPriorityIndex(layer) > targetPriority) || undefined;
}
