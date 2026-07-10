type RenderWaypoint = {
  x: number;
  y: number;
  startTime: number;
  arrivalTime: number;
  isInterstop?: boolean;
};

type PlayerWithWaypoints = {
  waypoints: RenderWaypoint[];
  isGhost?: boolean;
};

export type AnimationSegment = {
  start: [number, number];
  end: [number, number];
  startTime: number;
  endTime: number;
  isInterstop: boolean;
};

export function buildRenderablePlayer<T extends PlayerWithWaypoints>(raw: T, gameStartTime?: number): T & { segments: AnimationSegment[] } {
  const rawStartTime = raw.waypoints[0]?.startTime;
  const offset = raw.isGhost && typeof gameStartTime === 'number' && Number.isFinite(gameStartTime) && Number.isFinite(rawStartTime)
    ? gameStartTime - rawStartTime
    : 0;
  const segments = raw.waypoints.slice(1).map((waypoint, index) => {
    const previous = raw.waypoints[index];
    return {
      start: [previous.x, previous.y] as [number, number],
      end: [waypoint.x, waypoint.y] as [number, number],
      startTime: waypoint.startTime + offset,
      endTime: waypoint.arrivalTime + offset,
      isInterstop: waypoint.isInterstop === true,
    };
  });
  return { ...raw, segments };
}

export function buildRenderablePlayers<T extends PlayerWithWaypoints>(players: Record<string, T>, gameStartTime?: number) {
  return Object.fromEntries(Object.entries(players).map(([id, player]) => [id, buildRenderablePlayer(player, gameStartTime)]));
}
