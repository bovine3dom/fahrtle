import type maplibregl from 'maplibre-gl';
import { lerp, haversineDist, getBearing } from '../utils/geo';
import { latLngToCell, gridDisk } from 'h3-js';
import { getTimeZone } from '../timezone';
import { getServerTime } from '../time-sync';
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
      let targetPos: [number, number] | null = null;

      if (player.segments.length === 0) {
        if (player.waypoints.length > 0) {
          const p = player.waypoints[0];
          targetPos = [p.x, p.y];
        }
      } else {
        const last = player.segments[player.segments.length - 1];
        targetPos = last.end;

        for (const seg of player.segments) {
          if (now >= seg.startTime && now < seg.endTime) {
            const t = (now - seg.startTime) / (seg.endTime - seg.startTime);
            targetPos = [
              lerp(seg.start[0], seg.end[0], t),
              lerp(seg.start[1], seg.end[1], t)
            ];

            const dist = haversineDist({ lon: seg.start[0], lat: seg.start[1] }, { lon: seg.end[0], lat: seg.end[1] });
            const durationHours = (seg.endTime - seg.startTime) / (1000 * 60 * 60);
            const speed = durationHours > 0 ? (dist || 0) / durationHours : 0;
            currentSpeeds[pid] = speed;
            currentBearings[pid] = getBearing(seg.start[1], seg.start[0], seg.end[1], seg.end[0]);
            break;
          }
        }

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
          if (isRunning && startTime && !player.finishTime) {
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
    const pingPointerData = Object.entries(allPings)
      .filter(([_, ping]) => nowMs - ping.timestamp < PING_DURATION)
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
