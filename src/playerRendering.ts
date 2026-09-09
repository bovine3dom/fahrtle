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

export function getRenderableTimelineStart<T extends PlayerWithWaypoints>(players: Record<string, T>, playerId: string | null, gameStartTime?: number | null) {
  if (typeof gameStartTime === 'number' && Number.isFinite(gameStartTime)) return gameStartTime;
  const playerStartTime = playerId ? players[playerId]?.waypoints[0]?.startTime : undefined;
  return Number.isFinite(playerStartTime) ? playerStartTime : undefined;
}

export function rebaseRenderableGhosts<T extends PlayerWithWaypoints & { segments: AnimationSegment[] }>(players: Record<string, T>, timelineStart?: number) {
  if (timelineStart === undefined || !Number.isFinite(timelineStart)) return players;
  let updated = players;
  for (const [id, player] of Object.entries(players)) {
    if (!player.isGhost || player.waypoints.length < 2) continue;
    const expectedStart = player.waypoints[1].startTime + timelineStart - player.waypoints[0].startTime;
    if (player.segments[0]?.startTime === expectedStart) continue;
    if (updated === players) updated = { ...players };
    updated[id] = buildRenderablePlayer(player, timelineStart);
  }
  return updated;
}

export function getPlayerMotionAt(player: PlayerWithWaypoints & { segments: AnimationSegment[] }, time: number) {
  const firstWaypoint = player.waypoints[0];
  if (!firstWaypoint) return null;
  let position: [number, number] = [firstWaypoint.x, firstWaypoint.y];

  for (const segment of player.segments) {
    if (time < segment.startTime) break;
    if (time >= segment.endTime) {
      position = segment.end;
      continue;
    }
    const progress = (time - segment.startTime) / (segment.endTime - segment.startTime);
    return {
      position: [
        segment.start[0] + (segment.end[0] - segment.start[0]) * progress,
        segment.start[1] + (segment.end[1] - segment.start[1]) * progress,
      ] as [number, number],
      segment,
    };
  }
  return { position, segment: null };
}
