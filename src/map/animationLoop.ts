import type maplibregl from 'maplibre-gl';
import { lerp, haversineDist, getBearing } from '../utils/geo';
import { latLngToCell, gridDisk } from 'h3-js';
import { getTimeZone } from '../timezone';
import { getServerTime } from '../time-sync';
import { getPlayerMotionAt } from '../playerRendering';
import {
  $players, $roomState, $gameStartTime, $gameBounds, $playerSettings,
  $playerSpeeds, $playerDistances, $playerTimeZone, $myPlayerId,
  $pings, $globalRate, $isFollowing, finishRace, updatePlayerStats,
  submitGhostWaypoints, $currentDailyRaceIndex
} from '../store';
import { playerPositions } from '../playerPositions';

const lerpBearing = (a: number, b: number, t: number) => {
  let diff = b - a;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return (a + diff * t + 360) % 360;
};

function updateCamera(map: maplibregl.Map, myPos: [number, number], mySpeed: number, alpha: number, autoZoomEnabled: boolean, smoothedMyBearing: number): number {
  if (!$isFollowing.get() || !map || !myPos) return smoothedMyBearing;
  const firstPersonFollow = $playerSettings.get().firstPersonFollow;
  const centre = map.getCenter();
  const approxEq = (a: number, b: number) => Math.abs(a - b) < 0.000001;

  const REFERENCE_SPEED = 50;
  const REFERENCE_ZOOM = firstPersonFollow ? 16 : 15;
  const MIN_ZOOM = firstPersonFollow ? 13 : 5;
  const MAX_ZOOM = firstPersonFollow ? 18 : 16;
  const dilation = $globalRate.get() / 20;
  const safeSpeed = Math.max(1, mySpeed * dilation || 0);

  let nextZoom: number | undefined;
  if (autoZoomEnabled) {
    let targetZoom = REFERENCE_ZOOM - Math.log2(safeSpeed / REFERENCE_SPEED);
    targetZoom = Math.min(Math.max(targetZoom, MIN_ZOOM), MAX_ZOOM);
    const currentZoom = map.getZoom();
    if (Math.abs(currentZoom - targetZoom) > 0.01) {
      nextZoom = lerp(currentZoom, targetZoom, alpha);
    }
  }

  let newBearing = smoothedMyBearing;
  if (!approxEq(myPos[0], centre.lng) || !approxEq(myPos[1], centre.lat) || nextZoom !== undefined) {
    if (firstPersonFollow) {
      newBearing = lerpBearing(smoothedMyBearing, getBearing(
        playerPositions[$myPlayerId.get() || '']?.[1] || myPos[1],
        playerPositions[$myPlayerId.get() || '']?.[0] || myPos[0],
        myPos[1], myPos[0]
      ), alpha);
      map.jumpTo({ center: myPos, pitch: 75, bearing: newBearing, zoom: nextZoom ?? map.getZoom() });
    } else {
      const jumpOptions: any = { center: myPos };
      if (nextZoom !== undefined) jumpOptions.zoom = nextZoom;
      map.jumpTo(jumpOptions);
    }
  }
  return newBearing;
}

export interface AnimationLoopConfig {
  map: maplibregl.Map;
  onSmoothedBearingChange: (bearing: number) => void;
  onUpdatePointers: (pointers: { pid: string, pointer: { x: number, y: number, bearing: number, distance: number } }[]) => void;
  onUpdatePingPointers: (pointers: { pid: string, pointer: { x: number, y: number, bearing: number, distance: number } }[]) => void;
  onFinishPointer: (pointer: { x: number, y: number, bearing: number, distance: number } | null) => void;
  onUpdatePlayerMarkers: () => void;
  getPointer: (lat: number, lng: number) => { x: number, y: number, bearing: number, distance: number } | null;
}

export function startAnimationLoop(map: maplibregl.Map, config: AnimationLoopConfig): () => void {
  let frameId: number;
  let lastFrameTime = performance.now();
  let frameCount = 0;
  let autoZoomEnabled = $playerSettings.get().autoZoom;
  let smoothedMyBearing = map.getBearing();

  const PING_DURATION = 10000;

  const loop = (timestamp: number) => {
    frameId = requestAnimationFrame(loop);
    frameCount++;

    const dt = timestamp - lastFrameTime;
    lastFrameTime = timestamp;

    if (!map || dt < 1) return;

    const now = getServerTime();
    const allPlayers = $players.get();
    const currentSpeeds: Record<string, number> = {};
    const currentBearings: Record<string, number> = {};
    const currentDists: Record<string, number | null> = {};

    const isRunning = $roomState.get() === 'RUNNING';
    const startTime = $gameStartTime.get();

    const SMOOTHING_TIME_CONSTANT = 100;
    const alpha = 1 - Math.exp(-dt / SMOOTHING_TIME_CONSTANT);
    const myId = $myPlayerId.get();
    let myTargetPos: [number, number] | null = null;
    let myTargetSpeed = 0;
    let myTargetBearing = 0;

    for (const pid in allPlayers) {
      const player = allPlayers[pid];
      const motion = getPlayerMotionAt(player, now);
      const targetPos = motion?.position ?? null;

      if (motion?.segment) {
        const dist = haversineDist({ lon: motion.segment.start[0], lat: motion.segment.start[1] }, { lon: motion.segment.end[0], lat: motion.segment.end[1] });
        const durationHours = (motion.segment.endTime - motion.segment.startTime) / (1000 * 60 * 60);
        const speed = durationHours > 0 ? (dist || 0) / durationHours : 0;
        currentSpeeds[pid] = speed;
        currentBearings[pid] = getBearing(motion.segment.start[1], motion.segment.start[0], motion.segment.end[1], motion.segment.end[0]);
      }

      if (player.segments.length > 0) {
        const b = $gameBounds.get().finish;
        const distToFinish = haversineDist(targetPos ? { lon: targetPos[0], lat: targetPos[1] } : null, b?.length === 2 ? { lat: b[0], lon: b[1] } : null);
        currentDists[pid] = distToFinish;
      }

      if (targetPos) {
        const previousPos = playerPositions[pid] || targetPos;

        const smoothedPos: [number, number] = [
          lerp(previousPos[0], targetPos[0], alpha),
          lerp(previousPos[1], targetPos[1], alpha)
        ];

        playerPositions[pid] = smoothedPos;

        if (pid === myId) {
          myTargetPos = targetPos;
          myTargetSpeed = currentSpeeds[pid] || 0;
          if (currentBearings[pid] !== undefined) {
            myTargetBearing = currentBearings[pid];
            smoothedMyBearing = lerpBearing(smoothedMyBearing, myTargetBearing, alpha);
          }

          if (frameCount % 60 === 0) {
            autoZoomEnabled = $playerSettings.get().autoZoom;

            const zone = getTimeZone(smoothedPos[1], smoothedPos[0]);
            if ($playerTimeZone.get() !== zone) {
              $playerTimeZone.set(zone);
            }
            for (const pid in playerPositions) {
              if (!allPlayers[pid]) {
                delete playerPositions[pid];
              }
            }
          }
          if (isRunning && startTime !== null && player.finishTime == null) {
            if (frameCount % 10 === 0) {
              try {
                const finish = $gameBounds.get().finish;
                if (finish) {
                  const center = latLngToCell(finish[0], finish[1], 11);
                  const finishCells = gridDisk(center, 1);
                  const myCell = latLngToCell(smoothedPos[1], smoothedPos[0], 11);
                  if (finishCells.includes(myCell)) {
                    const finishTimeMs = now - startTime;
                    finishRace(finishTimeMs);
                    updatePlayerStats((stats) => ({
                      ...stats,
                      racesFinished: stats.racesFinished + 1,
                    }));
                    const bounds = $gameBounds.get();
                    const dailyIndex = $currentDailyRaceIndex.get();
                    if (bounds.ghosts && dailyIndex !== null) {
                      submitGhostWaypoints(dailyIndex, finishTimeMs);
                    }
                  }
                }
              } catch (e) { /* ignore H3 errors */ }
            }
          }
        }
      }
    }

    if (frameCount % 60 === 0) {
      $playerSpeeds.set(currentSpeeds);
      $playerDistances.set(currentDists);
    }

    const finish = $gameBounds.get().finish;
    if (finish) {
      config.onFinishPointer(config.getPointer(finish[0], finish[1]));
    } else {
      config.onFinishPointer(null);
    }

    const t_playerPointers = Object.entries(playerPositions).map(([pid, pos]) => {
      const pointer = config.getPointer(pos[1], pos[0]);
      return { pid, pointer };
    });
    const validPointers = t_playerPointers.filter(p => p.pointer !== null) as { pid: string, pointer: { x: number, y: number, bearing: number, distance: number } }[];
    config.onUpdatePointers(validPointers);

    const nowMs = Date.now();
    const allPings = $pings.get();
    const activePings = Object.entries(allPings)
      .filter(([_, ping]) => nowMs - ping.timestamp < PING_DURATION);
    const pingSource = map.getSource('pings') as maplibregl.GeoJSONSource | undefined;
    pingSource?.setData({
      type: 'FeatureCollection',
      features: activePings.map(([pid, ping]) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [ping.lon, ping.lat] },
        properties: { playerId: pid }
      })) as any
    });
    const pingPointerData = activePings
      .map(([pid, ping]) => {
        const pointer = config.getPointer(ping.lat, ping.lon);
        return { pid, pointer };
      })
      .filter(p => p.pointer !== null) as { pid: string, pointer: { x: number, y: number, bearing: number, distance: number } }[];
    config.onUpdatePingPointers(pingPointerData);

    if (myTargetPos) {
      smoothedMyBearing = updateCamera(map, myTargetPos, myTargetSpeed, alpha, autoZoomEnabled, smoothedMyBearing);
      config.onSmoothedBearingChange(smoothedMyBearing);
    }
    config.onUpdatePlayerMarkers();
  };

  frameId = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(frameId);
  };
}
