// ==> src/App.tsx <==
import { Suspense, lazy, For, createSignal, onMount, onCleanup, createMemo, Show, createEffect, untrack } from 'solid-js';
import { useStore } from '@nanostores/solid';
import { $currentRoom, leaveRoom, $globalRate, $roomState, $countdownEnd, toggleReady, $playerSpeeds, $playerDistances, toggleSnooze, forceRealtime, $gameBounds, setGameBounds, $pickerMode, $pickedPoint, $gameStartTime, updateSetting, stopImmediately, raceAgain, type Difficulty, $isSinglePlayer, $isDaily, $playerStats, updatePlayerStats, $isRerun } from './store';
import { getRealServerTime } from './time-sync';
import Lobby from './Lobby';
import Clock from './Clock';
import { fitGameBounds, getPlayerScreenPosition } from './Map';
import DepartureBoard from './DepartureBoard';
import { formatDuration, parseUserTime } from './utils/time';
import { parseCoords, sensibleNumber } from './utils/format';
import { createClosestCity } from './utils/tiny-cities';
import { getTimeZone } from './timezone';
import { colours } from './colours';
import { calculateCO2Emissions } from './utils/co2';
const MapView = lazy(() => import('./Map'));

import confetti from 'canvas-confetti';
import { getTravelSummary } from './utils/summary';
import WinModal from './WinModal';
import SettingsModal from './SettingsModal';
import TutorialModal from './TutorialModal';
import { players, myId, time, currentWpIndex, nextWaypoint } from './utils/memos';

function getSpeedMode(desiredRate: number | undefined, forceRealtime: boolean | undefined): 'auto' | 'snooze' | 'realtime' {
  if (forceRealtime) return 'realtime';
  if ((desiredRate || 1) > 1) return 'snooze';
  return 'auto';
}

function App() {
  const room = useStore($currentRoom);
  const rate = useStore($globalRate);
  const roomState = useStore($roomState);
  const isRerun = useStore($isRerun);
  const countdownEnd = useStore($countdownEnd);
  const speeds = useStore($playerSpeeds);
  const distances = useStore($playerDistances);
  const bounds = useStore($gameBounds);
  const pickerMode = useStore($pickerMode);
  const pickedPoint = useStore($pickedPoint);
  const startTime = useStore($gameStartTime);
  const isDaily = useStore($isDaily);

  const [minimized, setMinimized] = createSignal(false);
  const [startStr, setStartStr] = createSignal("");
  const [startTimeStr, setStartTimeStr] = createSignal("");
  const [finishStr, setFinishStr] = createSignal("");
  const [diff, setDiff] = createSignal<Difficulty>("Easy");
  const [compDriver, setCompDriver] = createSignal(false);
  const [useGhosts, setUseGhosts] = createSignal(false);
  const [showWinModal, setShowWinModal] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);

  // victory handler
  createEffect(() => {
    const mid = myId();
    if (!mid) return;
    const p = players()[mid];
    if (p && p.finishTime && !untrack(() => showWinModal())) {
      const pos = getPlayerScreenPosition(mid);
      confetti({
        particleCount: 200,
        spread: 140,
        origin: pos ? { x: pos.x, y: pos.y } : { y: 0.6 }
      });
      setTimeout(() => {
        // only snooze if there are players who haven't finished
        const leftToFinish = Object.values(players()).filter(p => !p.finishTime).length;
        ((p.desiredRate || 1) && leftToFinish > 0) && toggleSnooze();
        setShowWinModal(true)
      }, 3000);
    }
  });

  const handleSpectate = () => {
    setShowWinModal(false);

    // Automatically snooze if not already
    const mid = myId();
    if (mid) {
      const p = players()[mid];
      if (p && (p.desiredRate || 1) <= 1) {
        toggleSnooze();
      }
    }

    // Fit game bounds to see everyone
    fitGameBounds();
  };

  createEffect(() => {
    const p = pickedPoint();
    if (p) {
      const currentStart = untrack(() => parseCoords(startStr()));
      const currentFinish = untrack(() => parseCoords(finishStr()));

      const newPoint: [number, number] = [p.lat, p.lng];

      if (p.target === 'start') {
        setGameBounds(newPoint, currentFinish);
      } else if (p.target === 'finish') {
        setGameBounds(currentStart, newPoint);
      }
    }
  });



  createEffect(() => {
    const b = bounds();
    if (b.start) setStartStr(`${b.start[0]}, ${b.start[1]}`);
    else if (!b.start && !startStr()) setStartStr("");

    if (b.finish) setFinishStr(`${b.finish[0]}, ${b.finish[1]}`);
    else if (!b.finish && !finishStr()) setFinishStr("");

    if (b.time) {
      const tz = getTimeZone(b.start?.[0] || 51, b.start?.[1] || 0);
      const date = new Date(b.time);
      const serverTimeStr = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
      }).format(date);
      setStartTimeStr(serverTimeStr);
    }
    else if (!b.time && !startTimeStr()) setStartTimeStr("");

    setDiff(b.difficulty);
    setCompDriver(!!b.computerDriver);
    setUseGhosts(!!b.ghosts);
  });


  const isSaved = createMemo(() => {
    const b = bounds();

    const compare = (p1: [number, number] | null, p2: [number, number] | null) => {
      if (!p1 && !p2) return true;
      if (!p1 || !p2) return false;
      return Math.abs(p1[0] - p2[0]) < 0.000001 && Math.abs(p1[1] - p2[1]) < 0.000001;
    };
    const checkField = (str: string, serverVal: [number, number] | null) => {
      const parsed = parseCoords(str);

      if (parsed === null && str.trim() !== "") {
        return false;
      }

      return compare(parsed, serverVal);
    };

    const rs = roomState();
    const t = time();
    if (rs === 'JOINING' && b.start) {
      const tz = getTimeZone(b.start[0], b.start[1]);
      const date = new Date(t);
      const serverTimeStr = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
      }).format(date);

      const userTime = startTimeStr();
      const [h, m] = userTime.split(':');
      const normalizedUserTime = (h && m)
        ? `${h.padStart(2, '0')}:${m}`
        : userTime;

      if (normalizedUserTime !== serverTimeStr) return false;
    }

    if (b.difficulty !== diff()) return false;
    if (!!b.computerDriver !== compDriver()) return false;
    if (!!b.ghosts !== useGhosts()) return false;
    return checkField(startStr(), b.start) && checkField(finishStr(), b.finish);
  });

  const updateBounds = () => {
    const s = parseCoords(startStr());
    const f = parseCoords(finishStr());

    let ts: number | undefined = undefined;
    if (s) {
      const tz = getTimeZone(s[0], s[1]);
      const p = parseUserTime(startTimeStr(), tz);
      if (p) ts = p;
    }

    setGameBounds(s, f, ts, diff(), compDriver(), useGhosts());
  };

  const togglePicker = (mode: 'start' | 'finish') => {
    if (pickerMode() === mode) {
      $pickerMode.set(null);
    } else {
      $pickerMode.set(mode);
    }
  };

  const canCancel = createMemo(() => {
    const p = players()[myId()!];
    if (!p) return false;
    const futurePoints = p.waypoints.filter(wp => (wp.arrivalTime > time()) && !wp.isInterstop );
    if (futurePoints.length === 0) return false;

    if (futurePoints.length > 1) return true;
    if (futurePoints[0].isWalk || futurePoints[0].isWait) return true;

    return false;
  });

  const isOnTransport = createMemo(() => {
    const p = players()[myId()!];
    if (!p) return false;
    const now = time();
    return p.waypoints.some(wp => now >= wp.startTime && now < wp.arrivalTime && !wp.isWalk && !wp.isWait);
  });

  createEffect(() => {
    if (!canCancel() && isOnTransport()) {
      const me = players()[myId()!];
      const isSnoozing = (me?.desiredRate || 1.0) > 1.0;
      isSnoozing && toggleSnooze()
    }
  })

  const [timeLeft, setTimeLeft] = createSignal<number | null>(null);
  const [leaveConfirm, setLeaveConfirm] = createSignal(false);

  const elapsedTime = createMemo(() => {
    const start = startTime();
    const now = time();
    if (start && now >= start) {
      return formatDuration(now - start);
    }
    return null;
  });

  const sortedPlayerIds = createMemo(() => {
    const all = players();
    const dists = distances();
    // sort finishers first
    const sorted_finishers = Object.keys(all).filter(id => all[id].finishTime != null).sort((idA, idB) => {
      const a = all[idA].finishTime as number;
      const b = all[idB].finishTime as number;
      return a - b;
    });
    const sorted_others = Object.keys(all).filter(id => all[id].finishTime == null).sort((idA, idB) => {
      const a = dists[idA];
      const b = dists[idB];
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return a - b;
    });
    return sorted_finishers.concat(sorted_others);
  });

  const getMedal = (rankIndex: number) => {
    if (rankIndex === 0) return '🥇';
    if (rankIndex === 1) return '🥈';
    if (rankIndex === 2) return '🥉';
    return '';
  };

  createEffect(() => {
    if (leaveConfirm()) {
      const t = setTimeout(() => setLeaveConfirm(false), 5000);
      onCleanup(() => clearTimeout(t));
    }
  });

  onMount(() => {
    const interval = setInterval(() => {
      const end = countdownEnd();
      if (end) {
        const remaining = Math.max(0, Math.ceil((end - getRealServerTime()) / 1000));
        setTimeLeft(remaining);
      } else {
        setTimeLeft(null);
      }
    }, 100);

    const handlePopState = () => {
      if (room()) {
        leaveRoom();
      }
    };
    window.addEventListener('popstate', handlePopState);

    onCleanup(() => {
      clearInterval(interval);
      window.removeEventListener('popstate', handlePopState);
    });
  });

  const [lastTrackedWpIndex, setLastTrackedWpIndex] = createSignal(-1);
  const [lastTrackedRoomState, setLastTrackedRoomState] = createSignal(roomState() ?? 'JOINING');

  createEffect(() => {
    const rs = roomState() ?? 'JOINING';
    const prevRs = lastTrackedRoomState();
    const today = new Date().toISOString().split('T')[0];

    if (prevRs !== 'RUNNING' && rs === 'RUNNING') {
      updatePlayerStats((stats) => ({
        ...stats,
        racesStarted: stats.racesStarted + 1,
        lastPlayedDate: stats.lastPlayedDate !== today ? today : stats.lastPlayedDate,
        daysPlayed: stats.lastPlayedDate !== today ? stats.daysPlayed + 1 : stats.daysPlayed,
      }));
    }
    setLastTrackedRoomState(rs);
  });

  createEffect(() => {
    const p = players()[myId()!];
    const idx = currentWpIndex();
    const prevIdx = lastTrackedWpIndex();

    if (p && idx > prevIdx && prevIdx >= 0) {
      const newWaypoints = p.waypoints.slice(prevIdx, idx);
      const previousWaypoint = prevIdx > 0 ? p.waypoints[prevIdx - 1] : null;
      if (newWaypoints.length > 0) {
        const today = new Date().toISOString().split('T')[0];
        (async () => {
          const { computeStatsDelta } = await import('./utils/stats');
          const currentStats = $playerStats.get();
          const updatedStats = await computeStatsDelta(currentStats, newWaypoints, false, today, previousWaypoint);
          updatePlayerStats(() => updatedStats);
        })();
      }
    }

    if (idx >= 0) {
      setLastTrackedWpIndex(idx);
    }
  });

  const allStations = createMemo(() => {
    const p = players()[myId()!];
    if (!p) return [];
    return p.waypoints
      .map((wp, i) => ({ ...wp, originalIndex: i }))
      .filter(wp => !wp.isInterstop);
  });

  const futureWaypoints = createMemo(() => {
    const t = time();
    return allStations().filter(wp => wp.arrivalTime > t).reverse();
  });

  const [getOffDropdownOpen, setGetOffDropdownOpen] = createSignal(false);
  const [actionFeedback, setActionFeedback] = createSignal<string | null>(null);
  const [showTutorial, setShowTutorial] = createSignal(false);

  createEffect(() => {
    if (room() && !localStorage.getItem('fahrtle_tutorial_shown')) {
      setShowTutorial(true);
      localStorage.setItem('fahrtle_tutorial_shown', 'true');
    }
  });


  return (
    <>
      {!room() ? (
        <Lobby />
      ) : (
        <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>

          {/* Overlay UI */}
          <div style={{
            position: 'absolute', top: '10px', left: '10px', 'z-index': 10,
            background: 'rgba(255,255,255,0.9)', padding: '12px', 'border-radius': '8px',
            'box-shadow': '0 2px 10px rgba(0,0,0,0.1)',
            'width': '320px',
            'max-height': 'calc(100% - 100px)',
            'display': 'flex',
            'flex-direction': 'column',
            transition: 'all 0.2s ease-in-out'
          }}>

            {/* Header Row with Toggle */}
            <div style={{
              display: 'flex',
              'justify-content': 'space-between',
              'align-items': 'center',
              'margin-bottom': minimized() ? '0' : '8px'
            }}>
              {/* If minimized, show Clock here. If expanded, show Room Name */}
              <Show when={!minimized()} fallback={<Clock style={{ flex: 1 }} />}>
                <div style={{ 'font-size': '1.1em', 'font-weight': 'bold' }}>
                  {isDaily() ? 'Daily race' : $isSinglePlayer.get() ? 'Single player' : `Room: ${room()}`}
                </div>
              </Show>

              <div style={{ display: 'flex', 'align-items': 'center' }}>
                <button
                  onClick={() => setShowTutorial(true)}
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    padding: '4px 8px', 'font-size': '1.2em', color: colours.textMuted,
                    opacity: 0.8, transition: 'opacity 0.2s'
                  }}
                  title="Tutorial"
                  onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                  onMouseLeave={(e) => e.currentTarget.style.opacity = '0.8'}
                >
                  ❓
                </button>
                <button
                  onClick={() => setShowSettings(true)}
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    padding: '4px 8px', 'font-size': '1.2em', color: colours.textMuted,
                    opacity: 0.8, transition: 'opacity 0.2s',
                    'margin-left': '2px'
                  }}
                  title="Settings"
                  onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                  onMouseLeave={(e) => e.currentTarget.style.opacity = '0.8'}
                >
                  ⚙️
                </button>
                <button
                  onClick={() => setMinimized(!minimized())}
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    padding: '4px 8px', 'font-size': '1.2em', color: colours.textMuted,
                    'margin-left': '4px'
                  }}
                  title={minimized() ? "Expand" : "Minimize"}
                >
                  {minimized() ? '▼' : '▲'}
                </button>
              </div>
            </div>

            {/* Persistent Controls (Minimized Only) */}
            <Show when={minimized()}>
              <div style={{
                display: 'flex', gap: '8px', 'margin-bottom': '8px',
                'padding-top': '8px'
              }}>
                <Show when={canCancel()} fallback={
                  <Show when={roomState() === 'RUNNING'} fallback={
                    <button
                      onClick={() => {
                        toggleReady();
                        !players()[myId()!].isReady ? fitGameBounds() : null;
                      }}
                      style={{
                        width: '100%', padding: '10px', 'background': players()[myId()!]?.isReady ? colours.bg : colours.primary,
                        color: players()[myId()!]?.isReady ? colours.text : 'white',
                        border: '1px solid colours.border', 'border-radius': '4px', cursor: 'pointer',
                        'font-size': '0.9em', 'font-weight': 'bold', 'margin-bottom': '8px'
                      }}
                    >
                      {players()[myId()!]?.isReady ? 'Unready' : $isSinglePlayer.get() ? 'Start game' : 'Ready up'}
                    </button>
                  }>
                    <button disabled style={{
                      flex: 1, padding: '8px', background: colours.bg, color: colours.textLight,
                      border: '1px solid colours.border', 'border-radius': '4px', cursor: 'not-allowed',
                      'font-size': '0.9em', 'font-weight': 'bold',
                      'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '6px',
                      'min-width': 0
                    }}>
                      <span style={{ 'flex-shrink': 0 }}>🚶</span>
                      <span style={{
                        'white-space': 'nowrap',
                        'overflow': 'hidden',
                        'text-overflow': 'ellipsis',
                        'flex': 1
                      }}>
                        Double click map to walk
                      </span>
                    </button>
                  </Show>
                }>
                  <div style={{ display: 'flex', flex: 1, gap: '2px', position: 'relative', 'min-width': 0 }}>
                    <button
                      onClick={() => {
                        if (nextWaypoint()?.isWalk || nextWaypoint()?.isWait) {
                          stopImmediately();
                          setActionFeedback(nextWaypoint()?.isWait ? "Waiting stopped" : "Walking stopped");
                        } else {
                          stopImmediately(nextWaypoint()?.originalIndex);
                          setActionFeedback(`Stopping at ${nextWaypoint()?.stopName}`);
                        }
                        setTimeout(() => setActionFeedback(null), 3000);
                      }}
                      style={{
                        flex: 1, padding: '8px', 'background': (nextWaypoint()?.isWalk || nextWaypoint()?.isWait) ? colours.success : colours.warning, color: '#fff',
                        'border-top-left-radius': '4px', 'border-bottom-left-radius': '4px',
                        'border-top-right-radius': futureWaypoints().length > 1 ? '0' : '4px',
                        'border-bottom-right-radius': futureWaypoints().length > 1 ? '0' : '4px',
                        cursor: 'pointer',
                        border: (nextWaypoint()?.isWalk || nextWaypoint()?.isWait) ? '1px solid colours.successDark' : '1px solid colours.warningDark',
                        'border-right': futureWaypoints().length > 1 ? 'none' : undefined,
                        'font-size': '0.9em', 'font-weight': 'bold',
                        'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '6px',
                        'min-width': 0
                      }}
                      title={(nextWaypoint()?.isWalk || nextWaypoint()?.isWait) ? "Stop moving immediately" : "Stops at the next upcoming station and cancels remaining trip"}
                    >
                      <span style={{ 'flex-shrink': 0 }}>{actionFeedback() ? '' : '🛑'}</span>
                      <span style={{
                        'white-space': 'nowrap',
                        'overflow': 'hidden',
                        'text-overflow': 'ellipsis',
                        'flex': 1
                      }}>
                        {actionFeedback() || ((nextWaypoint()?.isWalk || nextWaypoint()?.isWait) ? (nextWaypoint()?.isWait ? 'Stop waiting' : 'Stop walking') : `${nextWaypoint()?.stopName || ''}`)}
                      </span>
                    </button>
                    <Show when={futureWaypoints().length > 1}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setGetOffDropdownOpen(!getOffDropdownOpen());
                        }}
                        style={{
                          padding: '0 4px',
                          background: (nextWaypoint()?.isWalk || nextWaypoint()?.isWait) ? colours.success : colours.warning,
                          color: '#fff',
                          'border-top-left-radius': '0px',
                          'border-bottom-left-radius': '0px',
                          border: (nextWaypoint()?.isWalk || nextWaypoint()?.isWait) ? '1px solid colours.successDark' : '1px solid colours.warningDark',
                          cursor: 'pointer'
                        }}
                      >
                        {getOffDropdownOpen() ? '▲' : '▼'}
                      </button>
                      <Show when={getOffDropdownOpen()}>
                        <div
                          ref={(el) => {
                            requestAnimationFrame(() => {
                              el.scrollTop = el.scrollHeight; // scroll to bottom once rendered on mount
                            });
                          }}
                          style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            background: '#fff',
                            border: '1px solid #ccc',
                            'box-shadow': '0 2px 10px rgba(0,0,0,0.1)',
                            'border-radius': '4px',
                            'margin-top': '4px',
                            'min-width': '200px',
                            'z-index': 100,
                            'max-height': '200px',
                            'overflow-y': 'auto'
                          }}>
                          <For each={futureWaypoints()}>
                            {(wp) => (
                              <div
                                onClick={() => {
                                  stopImmediately(wp.originalIndex)
                                  setGetOffDropdownOpen(false);
                                  setActionFeedback(`Alighting scheduled for ${wp.stopName}`);
                                  setTimeout(() => setActionFeedback(null), 3000);
                                }}
                                style={{
                                  padding: '8px 12px',
                                  cursor: 'pointer',
                                  'font-size': '0.85em',
                                  border: 'none',
                                  'border-bottom': '1px solid #eee',
                                  display: 'flex',
                                  'align-items': 'center',
                                  gap: '8px'
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.background = colours.bg}
                                onMouseLeave={(e) => e.currentTarget.style.background = '#fff'}
                              >
                                <span>{wp.emoji || '🏳️'}</span>
                                <span style={{ flex: 1, 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
                                  {wp.timeStr || ''} {wp.stopName || 'Unnamed stop'}
                                </span>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </Show>
                  </div>
                </Show>

                {roomState() === 'RUNNING' && (() => {
                  const me = players()[myId()!];
                  const mode = getSpeedMode(me?.desiredRate, me?.forceRealtime);
                  const handleAutoClick = () => {
                    if (mode === 'snooze') toggleSnooze();
                    else if ((mode === 'realtime') || (mode === 'auto')) forceRealtime();
                  };
                  const handleSnoozeClick = () => {
                    if (mode === 'auto') toggleSnooze();
                    else if (mode === 'snooze') toggleSnooze(); // toggle off -> auto
                    else if (mode === 'realtime') {
                      forceRealtime();
                      setTimeout(() => toggleSnooze(), 0);
                    }
                  };
                  const handleRealtimeClick = () => {
                    if (mode === 'realtime') forceRealtime(); // toggle off -> auto
                    else forceRealtime();
                  };
                  return (
                    <div style={{ display: 'flex', 'flex-shrink': 0 }}>
                      <button
                        onClick={handleRealtimeClick}
                        style={{
                          padding: '6px 8px', 'background': mode === 'realtime' ? colours.success : colours.bg,
                          color: mode === 'realtime' ? colours.white : colours.text,
                          border: `1px solid ${mode === 'realtime' ? colours.successDark : colours.border}`,
                          'border-right': 'none', 'border-radius': '4px 0 0 4px',
                          cursor: 'pointer', 'font-size': '1em',
                          'box-shadow': mode === 'realtime' ? 'inset 0 2px 4px rgba(0,0,0,0.3)' : 'none',
                          transform: mode === 'realtime' ? 'translateY(1px)' : 'none',
                        }}
                        title="Realtime (1x forced)"
                      >
                        ⏱
                      </button>
                      <button
                        onClick={handleAutoClick}
                        style={{
                          padding: '6px 8px', 'background': mode === 'auto' ? colours.primary : colours.bg,
                          color: mode === 'auto' ? colours.white : colours.text,
                          border: `1px solid ${mode === 'auto' ? colours.primaryDark : colours.border}`,
                          'border-right': 'none', 'border-left': 'none', 'border-radius': '0',
                          cursor: 'pointer', 'font-size': '1em',
                          'box-shadow': mode === 'auto' ? 'inset 0 2px 4px rgba(0,0,0,0.3)' : 'none',
                          transform: mode === 'auto' ? 'translateY(1px)' : 'none',
                        }}
                        title="Auto"
                      >
                        ▶️ 
                      </button>
                      <button
                        onClick={handleSnoozeClick}
                        style={{
                          padding: '6px 8px', 'background': mode === 'snooze' ? colours.primary : colours.bg,
                          color: mode === 'snooze' ? colours.white : colours.text,
                          border: `1px solid ${mode === 'snooze' ? colours.primaryDark : colours.border}`,
                          'border-left': 'none', 'border-radius': '0 4px 4px 0',
                          cursor: 'pointer', 'font-size': '1em',
                          'box-shadow': mode === 'snooze' ? 'inset 0 2px 4px rgba(0,0,0,0.3)' : 'none',
                          transform: mode === 'snooze' ? 'translateY(1px)' : 'none',
                        }}
                        title="Snooze (500x)"
                      >
                        ⏩
                      </button>
                    </div>
                  );
                })()}
              </div>
            </Show>

            {/* Expanded Content */}
            <Show when={!minimized()}>
              <div style={{ display: 'flex', 'flex-direction': 'column', 'max-height': 'calc(100vh - 100px)', 'min-height': 0 }}>
                <div style={{ 'overflow-y': 'auto', 'padding-right': '4px', 'flex': 1, 'min-height': 0 }}>
                  {/* Header Info */}
                  <div style={{ 'margin-bottom': '8px' }}>
                    <Clock />
                    <div style={{ 'font-size': '0.75em', 'font-weight': 'bold', 'color': colours.text, 'margin-bottom': '6px', 'text-align': 'center' }}>
                      {createClosestCity(() => bounds().start ? { lat: bounds().start![0], lon: bounds().start![1] } : null)()} ➡️ {createClosestCity(() => bounds().finish ? { lat: bounds().finish![0], lon: bounds().finish![1] } : null)()}
                    </div>
                    <div style={{ 'font-size': '0.85em', 'color': colours.warningDark, 'margin-top': '2px' }}>
                      Time dilation: {rate().toFixed(2)}x
                    </div>
                    <Show when={elapsedTime()}>
                      <div style={{ 'font-size': '0.85em', 'color': colours.successDark, 'margin-top': '2px', 'font-weight': 'bold' }}>
                        Elapsed: {elapsedTime()}
                      </div>
                    </Show>
                  </div>

                  <Show when={roomState() === 'JOINING' && !isRerun()}>
                    <div style={{
                      'background': colours.bg, 'padding': '8px', 'border-radius': '4px',
                      'border': '1px solid colours.border', 'margin-bottom': '10px'
                    }}>
                      <Show when={bounds()}>
                        <div style={{ 'font-size': '0.75em', 'font-weight': 'bold', 'color': colours.text, 'margin-bottom': '6px' }}>
                          {createClosestCity(() => bounds().start ? { lat: bounds().start![0], lon: bounds().start![1] } : null)()} ➡️ {createClosestCity(() => bounds().finish ? { lat: bounds().finish![0], lon: bounds().finish![1] } : null)()}
                        </div>
                      </Show>

                      <Show when={!isDaily()}>
                        <div style={{ 'margin-bottom': '6px' }}>
                          <label style={{ 'display': 'block', 'font-size': '0.7em', 'color': 'colours.textMuted' }}>Start time: </label>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <input
                              type="time"
                              value={startTimeStr()}
                              onInput={(e) => setStartTimeStr(e.currentTarget.value)}
                              style={{ width: '100%', 'font-size': '0.8em', padding: '4px', 'box-sizing': 'border-box', 'font-family': 'unset' }}
                            />
                          </div>
                        </div>
                      </Show>

                      <Show when={!isDaily()}>
                        <div style={{ 'margin-bottom': '6px' }}>
                          <label style={{ 'display': 'block', 'font-size': '0.7em', 'color': 'colours.textMuted' }}>Start (lat, lng, but, seriously, use the picker): </label>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <input
                              type="text"
                              value={startStr()}
                              onInput={(e) => setStartStr(e.currentTarget.value)}
                              placeholder="e.g. 55.953, -3.188"
                              style={{ width: '100%', 'font-size': '0.8em', padding: '4px', 'box-sizing': 'border-box' }}
                            />
                            <button
                              onClick={() => togglePicker('start')}
                              title="Pick on Map"
                              style={{
                                background: pickerMode() === 'start' ? colours.primary : colours.border,
                                color: pickerMode() === 'start' ? 'white' : colours.text,
                                border: 'none', 'border-radius': '4px', cursor: 'pointer', width: '28px', padding: 0,
                              }}
                            >
                              🧭
                            </button>
                          </div>
                        </div>

                        <div style={{ 'margin-bottom': '6px' }}>
                          <label style={{ 'display': 'block', 'font-size': '0.7em', 'color': 'colours.textMuted' }}>Finish (lat, lng)</label>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <input
                              type="text"
                              value={finishStr()}
                              onInput={(e) => setFinishStr(e.currentTarget.value)}
                              placeholder="e.g. 51.507, -0.127"
                              style={{ width: '100%', 'font-size': '0.8em', padding: '4px', 'box-sizing': 'border-box' }}
                            />
                            <button
                              onClick={() => togglePicker('finish')}
                              title="Pick on Map"
                              style={{
                                background: pickerMode() === 'finish' ? colours.primary : colours.border,
                                color: pickerMode() === 'finish' ? 'white' : colours.text,
                                border: 'none', 'border-radius': '4px', cursor: 'pointer', width: '28px', padding: 0
                              }}
                            >
                              🧭
                            </button>
                          </div>
                        </div>
                      </Show>
                      <div style={{ 'margin-bottom': '12px' }}>
                        <label style={{ 'display': 'block', 'font-size': '0.7em', 'color': 'colours.textMuted' }}>Difficulty: </label>
                        <input
                          type="range"
                          min="0"
                          max="2"
                          step="1"
                          value={['Easy', 'Normal', 'Transport nerd'].indexOf(diff())}
                          onInput={e => {
                            const values: Difficulty[] = ['Easy', 'Normal', 'Transport nerd'];
                            setDiff(values[parseInt(e.currentTarget.value)]);
                          }}
                          style={{ width: '100%', cursor: 'pointer' }}
                        />
                        <div style={{ display: 'flex', 'justify-content': 'space-between', 'font-size': '0.65rem', 'color': 'colours.textMuted' }}>
                          <span style={{ opacity: diff() === 'Easy' ? 1 : 0.5 }}>Easy</span>
                          <span style={{ opacity: diff() === 'Normal' ? 1 : 0.5 }}>Normal</span>
                          <span style={{ opacity: diff() === 'Transport nerd' ? 1 : 0.5 }}>Nerd</span>
                        </div>
                        <div style={{ 'font-size': '0.7em', 'color': '#777', 'font-style': 'italic', 'margin': '4px 0', 'min-height': '1.2em' }}>
                          {diff() === 'Easy' && "Adds arrival times, speeds and destinations"}
                          {diff() === 'Normal' && "Adds cardinal directions"}
                          {diff() === 'Transport nerd' && "Adds debug info 💻"}
                        </div>
                      </div>

                      <div style={{ 'margin-bottom': '12px' }}>
                        <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                          <input
                            type="checkbox"
                            role="switch"
                            checked={compDriver()}
                            onChange={(e) => setCompDriver(e.currentTarget.checked)}
                            style={{ cursor: 'pointer' }}
                          />
                          <label style={{ 'font-size': '0.8rem', 'color': colours.textMuted, 'font-weight': 'bold', cursor: 'pointer' }} onClick={() => setCompDriver(!compDriver())}>
                            Add robot opponent 🤖
                          </label>
                        </div>
                      </div>

                      <Show when={isDaily()}>
                        <div style={{ 'margin-bottom': '12px' }}>
                          <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
                            <input
                              type="checkbox"
                              role="switch"
                              checked={useGhosts()}
                              onChange={(e) => setUseGhosts(e.currentTarget.checked)}
                              style={{ cursor: 'pointer' }}
                            />
                            <label style={{ 'font-size': '0.8rem', 'color': colours.textMuted, 'font-weight': 'bold', cursor: 'pointer' }} onClick={() => setUseGhosts(!useGhosts())}>
                              Play against ghosts 👻
                            </label>
                          </div>
                        </div>
                      </Show>

                      <button
                        onClick={updateBounds}
                        disabled={isSaved()}
                        style={{
                          width: '100%', padding: '4px',
                          'background': isSaved() ? colours.success : colours.textDark,
                          'color': 'white',
                          border: 'none', 'border-radius': '4px',
                          'cursor': isSaved() ? 'default' : 'pointer',
                          'font-size': '0.8em',
                          'font-weight': 'bold',
                          'transition': 'all 0.2s'
                        }}
                      >
                        {isSaved() ? 'Synced ✓' : 'Confirm settings'}
                      </button>
                    </div>
                  </Show>

                  {/* Player List */}
                  <div style={{
                    'margin-top': '10px',
                    'padding-top': '8px',
                    'border-top': '1px solid #ccc'
                  }}>
                    <div style={{ 'font-size': '0.75em', 'text-transform': 'uppercase', 'color': '#666', 'margin-bottom': '6px', 'letter-spacing': '0.5px' }}>
                      Active Pilots
                    </div>
                    <div style={{ 'max-height': '200px', 'overflow-y': 'auto' }}>
                      <For each={sortedPlayerIds()}>
                        {(id, index) => {
                          const p = () => players()[id];
                          const isFinished = createMemo(() => p().finishTime != null);
                          const nextWpIndex = createMemo(() => p().segments.findIndex((s: any) => s.startTime > time() && !s.isInterstop));
                          const nextWp = createMemo(() => p().waypoints[nextWpIndex() || 1]); // default to first real waypoint
                          const mySpeed = createMemo(() => (speeds()[id] || 0).toFixed(0));
                          const myDist = createMemo(() => sensibleNumber(distances()[id] || 0));

                          // onClick={() => flyToPlayer(p().id)}
                          return (
                            <div
                              onClick={() => {
                                console.log(getTravelSummary(p(), $gameBounds.get()))
                              }}
                              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.05)'}
                              onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                              style={{
                                display: 'flex', 'align-items': 'center', gap: '8px', 'margin-bottom': '4px',
                                'font-weight': p().id === myId() ? '800' : '400',
                                'color': p().id === myId() ? colours.textDark : colours.textBody,
                                cursor: 'pointer',
                                padding: '4px',
                                'min-height': '42px',
                                'border-radius': '4px',
                                transition: 'background 0.2s',
                                'background': isFinished() ? 'rgba(255, 237, 74, 0.1)' : 'transparent',
                                'border': isFinished() ? '1px solid rgba(255, 215, 0, 0.3)' : '1px solid transparent'
                              }}>
                              <div style={{ position: 'relative', width: '12px', height: '12px', 'flex-shrink': 0 }}>
                                <div style={{
                                  width: '12px', height: '12px', 'border-radius': '50%',
                                  background: p().color,
                                  'border': '1px solid rgba(0,0,0,0.2)'
                                }} />
                                <Show when={p().id === myId()}>
                                  <input
                                    type="color"
                                    value={p().color}
                                    onInput={(e) => updateSetting('color', e.currentTarget.value)}
                                    onClick={(e) => e.stopPropagation()}
                                    style={{
                                      position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                                      opacity: 0, cursor: 'pointer', 'z-index': 1
                                    }}
                                  />
                                </Show>
                              </div>
                              <div style={{ 'flex': 1, 'min-width': 0 }}>
                                <div style={{
                                  'font-size': '0.9em',
                                  'white-space': 'nowrap',
                                  'overflow': 'hidden',
                                  'text-overflow': 'ellipsis',
                                }}>
                                  <Show when={isFinished()}>
                                    <span style={{ "margin-right": "4px" }}>{getMedal(index())}</span>
                                  </Show>
                                  {p().id} {p().id === myId() ? '(You)' : ''} {p().forceRealtime ? '⏱' : (p().desiredRate || 1) > 1 && '💤'}
                                </div>
                                <Show when={isFinished()}>
                                  <div style={{ 'font-size': '0.75em', 'color': colours.successDark, 'font-weight': 'bold' }}>
                                    Finished in {formatDuration(p().finishTime!)}, {sensibleNumber(calculateCO2Emissions(p().waypoints))} kgCO₂e
                                  </div>
                                </Show>
                                <Show when={!isFinished()}>
                                  <Show when={nextWp()} fallback={
                                    <Show when={p().viewingStopName}>
                                      <div style={{
                                        'overflow': 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'display': 'block',
                                        'font-size': '0.7em', 'color': colours.textMuted, 'margin-top': '0px', 'align-items': 'center', 'gap': '4px'
                                      }}>
                                        🔍 Looking at departures @ {p().viewingStopName}
                                      </div>
                                    </Show>
                                  }>
                                    {(wp) => (
                                      <div style={{
                                        'overflow': 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'display': 'block',
                                        'font-size': '0.7em', 'color': colours.textMuted, 'margin-top': '0px', 'align-items': 'center', 'gap': '4px'
                                      }}>
                                        <Show when={wp().route_short_name}>
                                          <span
                                            class="route-pill"
                                            style={{
                                              "background-color": wp().route_color ? `#${wp().route_color}` : '#333',
                                              "color": '#fff'
                                            }}
                                          >
                                            {wp().route_short_name}
                                          </span>
                                        </Show>
                                        {wp().emoji + " " || ''} &rarr; {wp().stopName} {wp().timeStr ? `(${wp().timeStr})` : ''}
                                      </div>
                                    )}
                                  </Show>
                                </Show>
                              </div>

                              {/* Speed / Ready Status */}
                              <Show when={roomState() === 'RUNNING' && !isFinished()}>
                                <span style={{
                                  'font-size': '0.75em',
                                  'font-family': 'monospace',
                                  'color': colours.textMuted,
                                  'margin-right': '6px',
                                  'min-width': '60px',
                                  'text-align': 'right'
                                }}>
                                  {mySpeed()} km/h {myDist()} km
                                </span>
                              </Show>
                              {roomState() !== 'RUNNING' && (
                                p().isReady ? (
                                  <span style={{ color: colours.successDark, 'font-size': '0.8em', 'font-weight': 'bold' }}>✓</span>
                                ) : (
                                  <span style={{ color: colours.textLight, 'font-size': '0.8em' }}>...</span>
                                )
                              )}
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                </div>

                {/* Footer Actions */}
                <div style={{ 'margin-top': '12px', 'border-top': '1px solid #ccc', 'padding-top': '8px', 'flex-shrink': 0 }}>
                  <Show when={canCancel()} fallback={
                    <Show when={roomState() === 'RUNNING'} >
                      <button disabled style={{
                        width: '100%', padding: '8px', background: colours.bg, color: colours.textLight,
                        border: '1px solid colours.border', 'border-radius': '4px', cursor: 'not-allowed',
                        'font-size': '0.9em', 'font-weight': 'bold', 'margin-bottom': '8px',
                        'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '6px'
                      }}>
                        <span>🚶</span> Double click map to walk
                      </button>
                    </Show>
                  }>
                    <div style={{ display: 'flex', gap: '2px', position: 'relative', 'margin-bottom': '8px' }}>
                      <button
                        onClick={() => {
                          if (nextWaypoint()?.isWalk || nextWaypoint()?.isWait) {
                            stopImmediately();
                            setActionFeedback(nextWaypoint()?.isWait ? "Waiting stopped" : "Walking stopped");
                          } else {
                            stopImmediately(nextWaypoint()?.originalIndex);
                            setActionFeedback(`Alighting scheduled for ${nextWaypoint()?.stopName}`);
                          }
                          setTimeout(() => setActionFeedback(null), 3000);
                        }}
                        style={{
                          flex: 1, padding: '8px', 'background': (nextWaypoint()?.isWalk || nextWaypoint()?.isWait) ? colours.success : colours.warning, color: '#fff',
                          'border-top-left-radius': '4px', 'border-bottom-left-radius': '4px',
                          'border-top-right-radius': futureWaypoints().length > 1 ? '0' : '4px',
                          'border-bottom-right-radius': futureWaypoints().length > 1 ? '0' : '4px',
                          cursor: 'pointer',
                          border: (nextWaypoint()?.isWalk || nextWaypoint()?.isWait) ? '1px solid colours.successDark' : '1px solid colours.warningDark',
                          'border-right': futureWaypoints().length > 1 ? 'none' : undefined,
                          'font-size': '0.9em', 'font-weight': 'bold',
                          'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '6px'
                        }}
                        title={(nextWaypoint()?.isWalk || nextWaypoint()?.isWait) ? "Stop moving immediately" : "Stops at the next upcoming station and cancels remaining trip"}
                      >
                        <span>{actionFeedback() ? '' : '🛑'}</span> {actionFeedback() || ((nextWaypoint()?.isWalk || nextWaypoint()?.isWait) ? (nextWaypoint()?.isWait ? 'Stop waiting' : 'Stop walking') : `Get off at ${nextWaypoint()?.stopName || ''}`)}
                      </button>
                      <Show when={futureWaypoints().length > 1}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setGetOffDropdownOpen(!getOffDropdownOpen());
                          }}
                          style={{
                            padding: '0 8px',
                            background: (nextWaypoint()?.isWalk || nextWaypoint()?.isWait) ? colours.success : colours.warning,
                            color: '#fff',
                            'border-top-left-radius': '0px',
                            'border-bottom-left-radius': '0px',
                            'border-top-right-radius': '4px',
                            'border-bottom-right-radius': '4px',
                            border: (nextWaypoint()?.isWalk || nextWaypoint()?.isWait) ? '1px solid colours.successDark' : '1px solid colours.warningDark',
                            'border-left': '1px solid rgba(255,255,255,0.3)',
                            cursor: 'pointer'
                          }}
                        >
                          {getOffDropdownOpen() ? '▲' : '▼'}
                        </button>
                        <Show when={getOffDropdownOpen()}>
                          <div
                            ref={(el) => {
                              requestAnimationFrame(() => {
                                el.scrollTop = el.scrollHeight; // scroll to bottom once rendered on mount
                              });
                            }}
                            style={{
                              position: 'absolute',
                              top: '100%',
                              left: 0,
                              background: '#fff',
                              border: '1px solid #ccc',
                              'box-shadow': '0 2px 10px rgba(0,0,0,0.1)',
                              'border-radius': '4px',
                              'margin-top': '4px',
                              'min-width': '200px',
                              'z-index': 100,
                              'max-height': '200px',
                              'overflow-y': 'auto'
                            }}>
                            <For each={futureWaypoints()}>
                              {(wp) => (
                                <div
                                  onClick={() => {
                                    stopImmediately(wp.originalIndex)
                                    setGetOffDropdownOpen(false);
                                    setActionFeedback(`Alighting scheduled for ${wp.stopName}`);
                                    setTimeout(() => setActionFeedback(null), 3000);
                                  }}
                                  style={{
                                    padding: '8px 12px',
                                    cursor: 'pointer',
                                    'font-size': '0.9em',
                                    border: 'none',
                                    'border-bottom': '1px solid #eee',
                                    display: 'flex',
                                    'align-items': 'center',
                                    gap: '8px'
                                  }}
                                  onMouseEnter={(e) => e.currentTarget.style.background = colours.bg}
                                  onMouseLeave={(e) => e.currentTarget.style.background = '#fff'}
                                >
                                  <span>{wp.emoji || '🏳️'}</span>
                                  <span style={{ flex: 1 }}>{wp.timeStr || ''} {wp.stopName || 'Unnamed stop'}</span>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </Show>
                    </div>
                  </Show>
                  {roomState() !== 'RUNNING' && (
                    <button
                      onClick={() => {
                        toggleReady();
                        !players()[myId()!].isReady ? fitGameBounds() : null;
                      }}
                      style={{
                        width: '100%', padding: '10px', 'background': players()[myId()!]?.isReady ? colours.bg : colours.primary,
                        color: players()[myId()!]?.isReady ? colours.text : 'white',
                        border: '1px solid colours.border', 'border-radius': '4px', cursor: 'pointer',
                        'font-size': '0.9em', 'font-weight': 'bold', 'margin-bottom': '8px'
                      }}
                    >
                      {players()[myId()!]?.isReady ? 'Unready' : $isSinglePlayer.get() ? 'Start game' : 'Ready up'}
                    </button>
                  )}
                  {/* Snooze Button */}
                  <Show when={roomState() === 'RUNNING'}>
                    <Show when={players()[myId()!]}>
                      {(me) => {
                        const mode = createMemo(() => getSpeedMode(me().desiredRate, me().forceRealtime));
                        const handleAutoClick = () => {
                          if (mode() === 'snooze') toggleSnooze();
                          else if ((mode() === 'realtime') || (mode() === 'auto')) forceRealtime();
                        };
                        const handleSnoozeClick = () => {
                          if (mode() === 'auto') toggleSnooze();
                          else if (mode() === 'snooze') toggleSnooze(); // toggle off -> auto
                          else if (mode() === 'realtime') {
                            forceRealtime();
                            setTimeout(() => toggleSnooze(), 0);
                          }
                        };
                        const handleRealtimeClick = () => {
                          if (mode() === 'realtime') forceRealtime(); // toggle off -> auto
                          else forceRealtime();
                        };
                        return (
                          <>
                            <div style={{ display: 'flex', 'margin-top': '8px' }}>
                              <button
                                onClick={handleRealtimeClick}
                                style={{
                                  flex: 1, padding: '8px', 'background': mode() === 'realtime' ? colours.success : colours.bg,
                                  color: mode() === 'realtime' ? colours.white : colours.text,
                                  border: `1px solid ${mode() === 'realtime' ? colours.successDark : colours.border}`,
                                  'border-right': 'none', 'border-radius': '4px 0 0 4px',
                                  cursor: 'pointer', 'font-size': '0.9em', 'font-weight': 'bold',
                                  'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '4px',
                                  'box-shadow': mode() === 'realtime' ? 'inset 0 2px 4px rgba(0,0,0,0.3)' : 'none',
                                  transform: mode() === 'realtime' ? 'translateY(1px)' : 'none',
                                }}
                                title="Realtime (1x forced)"
                              >
                                ⏱ Realtime
                              </button>
                              <button
                                onClick={handleAutoClick}
                                style={{
                                  flex: 1, padding: '8px', 'background': mode() === 'auto' ? colours.primary : colours.bg,
                                  color: mode() === 'auto' ? colours.white : colours.text,
                                  border: `1px solid ${mode() === 'auto' ? colours.primaryDark : colours.border}`,
                                  'border-right': 'none', 'border-left': 'none', 'border-radius': '0',
                                  cursor: 'pointer', 'font-size': '0.9em', 'font-weight': 'bold',
                                  'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '4px',
                                  'box-shadow': mode() === 'auto' ? 'inset 0 2px 4px rgba(0,0,0,0.3)' : 'none',
                                  transform: mode() === 'auto' ? 'translateY(1px)' : 'none',
                                }}
                                title="Auto"
                              >
                                ▶️ Auto
                              </button>
                              <button
                                onClick={handleSnoozeClick}
                                style={{
                                  flex: 1, padding: '8px', 'background': mode() === 'snooze' ? colours.primary : colours.bg,
                                  color: mode() === 'snooze' ? colours.white : colours.text,
                                  border: `1px solid ${mode() === 'snooze' ? colours.primaryDark : colours.border}`,
                                  'border-left': 'none', 'border-radius': '0 4px 4px 0',
                                  cursor: 'pointer', 'font-size': '0.9em', 'font-weight': 'bold',
                                  'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '4px',
                                  'box-shadow': mode() === 'snooze' ? 'inset 0 2px 4px rgba(0,0,0,0.3)' : 'none',
                                  transform: mode() === 'snooze' ? 'translateY(1px)' : 'none',
                                }}
                                title="Snooze (500x)"
                              >
                                ⏩ Snooze
                              </button>
                            </div>
                            <Show when={me().finishTime}>
                              <button
                                onClick={() => setShowWinModal(true)}
                                style={{
                                  width: '100%', padding: '8px', 'background': colours.bg,
                                  color: colours.text,
                                  border: '1px solid colours.border',
                                  'border-radius': '4px', cursor: 'pointer', 'font-size': '0.9em', 'font-weight': 'bold',
                                  'margin-top': '8px', 'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '6px'
                                }}
                                title="Show results"
                              >
                                Show results 📝
                              </button>
                            </Show>
                          </>
                        );
                      }}
                    </Show>
                  </Show>
                  <button
                    onClick={() => {
                      if (leaveConfirm()) {
                        leaveRoom();
                      } else {
                        setLeaveConfirm(true);
                      }
                    }}
                    style={{
                      width: '100%', padding: '6px',
                      'background': leaveConfirm() ? colours.danger : colours.dangerLight,
                      'color': leaveConfirm() ? colours.white : colours.dangerDark,
                      border: `1px solid ${colours.dangerBorder}`, 'border-radius': '4px', cursor: 'pointer', 'font-size': '0.85em',
                      'margin-top': '8px',
                      transition: 'all 0.2s'
                    }}
                  >
                    {leaveConfirm() ? 'Click again to confirm' : $isSinglePlayer.get() ? 'Return to main menu' : 'Leave room'}
                  </button>

                  <div class="interaction-hint" style={{ 'font-size': '0.75em', 'color': colours.textLight, 'margin-top': '6px', 'text-align': 'center' }}>
                    {roomState() === 'RUNNING' ? 'Click map for departures, double click to board or walk' : 'Waiting for game to start...'}
                  </div>
                </div>
              </div>
            </Show>
          </div>
          <DepartureBoard />

          <Suspense fallback={
            <div style={{
              color: 'white', background: '#333', height: '100%',
              display: 'flex', 'justify-content': 'center', 'align-items': 'center'
            }}>
              Loading Map Engine...
            </div>
          }>
            <MapView />
          </Suspense>

          {roomState() === 'COUNTDOWN' && (
            <div style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
              'z-index': 100, background: 'rgba(0,0,0,0.8)', padding: '2rem 4rem',
              'border-radius': '16px', color: 'white', 'text-align': 'center',
              'pointer-events': 'none', 'backdrop-filter': 'blur(4px)'
            }}>
              <div style={{ 'font-size': '1.5rem', opacity: 0.8, 'margin-bottom': '8px' }}>Mission starts in</div>
              <div style={{ 'font-size': '6rem', 'font-weight': 'bold', 'line-height': 1 }}>{timeLeft()}</div>
            </div>
          )}

          <Show when={showSettings()}>
            <SettingsModal onClose={() => setShowSettings(false)} />
          </Show>

          <Show when={showTutorial()}>
            <TutorialModal onClose={() => setShowTutorial(false)} />
          </Show>
        </div>
      )}
      {showWinModal() && players()[myId()!] && (
        <WinModal
          player={players()[myId()!]!}
          onSpectate={handleSpectate}
          onClose={() => setShowWinModal(false)}
          onRaceAgain={() => {
            raceAgain(players()[myId()!]!.waypoints);
            setShowWinModal(false);
          }}
        />
      )}
    </>
  );
}

export default App;
