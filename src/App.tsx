// ==> src/App.tsx <==
import { Suspense, lazy, For, createSignal, onMount, onCleanup, createMemo, Show, createEffect, untrack } from 'solid-js';
import { useStore } from '@nanostores/solid';
import { $currentRoom, leaveRoom, $globalRate, $players, $myPlayerId, $roomState, $countdownEnd, toggleReady, $playerSpeeds, $playerDistances, cancelNavigation, $clock, toggleSnooze, $gameBounds, setGameBounds, $pickerMode, $pickedPoint, $gameStartTime, setPlayerColor, stopImmediately, type Difficulty, $isSinglePlayer } from './store';
import { getRealServerTime } from './time-sync';
import Lobby from './Lobby';
import Clock from './Clock';
import { fitGameBounds, getPlayerScreenPosition } from './Map';
import DepartureBoard from './DepartureBoard';
import { formatDuration, parseUserTime } from './utils/time';
import { parseCoords, sensibleNumber } from './utils/format';
import { findClosestCity } from './utils/geo';
import { getTimeZone } from './timezone';
const MapView = lazy(() => import('./Map'));

import confetti from 'canvas-confetti';
import { getTravelSummary } from './utils/summary';
import WinModal from './WinModal';

function App() {
  const room = useStore($currentRoom);
  const rate = useStore($globalRate);
  const players = useStore($players);
  const myId = useStore($myPlayerId);
  const roomState = useStore($roomState);
  const countdownEnd = useStore($countdownEnd);
  const speeds = useStore($playerSpeeds);
  const distances = useStore($playerDistances);
  const time = useStore($clock);
  const bounds = useStore($gameBounds);
  const pickerMode = useStore($pickerMode);
  const pickedPoint = useStore($pickedPoint);
  const startTime = useStore($gameStartTime);

  const [minimized, setMinimized] = createSignal(false);
  const [startStr, setStartStr] = createSignal("");
  const [startTimeStr, setStartTimeStr] = createSignal("");
  const [finishStr, setFinishStr] = createSignal("");
  const [diff, setDiff] = createSignal<Difficulty>("Easy");
  const [showWinModal, setShowWinModal] = createSignal(false);

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

    setGameBounds(s, f, ts, diff());
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
    const futurePoints = p.waypoints.filter(wp => wp.arrivalTime > time());
    if (futurePoints.length === 0) return false;

    if (futurePoints.length > 1) return true;
    if (futurePoints[0].isWalk) return true;

    return false;
  });

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
    onCleanup(() => clearInterval(interval));
  });

  const nextWaypoint = createMemo(() => {
    const p = players()[myId()!];
    if (!p) return undefined;
    return p.waypoints.find((wp) => wp.arrivalTime > time());
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
            'width': minimized() ? '280px' : 'auto',
            'min-width': '200px',
            'max-width': 'calc(100vw - 20px)',
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
                <div style={{ 'font-size': '1.1em', 'font-weight': 'bold' }}>{$isSinglePlayer.get() ? 'Single player' : `Room: ${room()}`}</div>
              </Show>

              <button
                onClick={() => setMinimized(!minimized())}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  padding: '4px 8px', 'font-size': '1.2em', color: '#64748b',
                  'margin-left': '10px'
                }}
                title={minimized() ? "Expand" : "Minimize"}
              >
                {minimized() ? '▼' : '▲'}
              </button>
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
                        width: '100%', padding: '10px', 'background': players()[myId()!]?.isReady ? '#f1f5f9' : '#3b82f6',
                        color: players()[myId()!]?.isReady ? '#475569' : 'white',
                        border: '1px solid #cbd5e1', 'border-radius': '4px', cursor: 'pointer',
                        'font-size': '0.9em', 'font-weight': 'bold', 'margin-bottom': '8px'
                      }}
                    >
                      {players()[myId()!]?.isReady ? 'Unready' : $isSinglePlayer.get() ? 'Start game' : 'Ready up'}
                    </button>
                  }>
                    <button disabled style={{
                      flex: 1, padding: '8px', background: '#f1f5f9', color: '#94a3b8',
                      border: '1px solid #cbd5e1', 'border-radius': '4px', cursor: 'not-allowed',
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
                  <button
                    onClick={() => nextWaypoint()?.isWalk ? stopImmediately() : cancelNavigation()}
                    style={{
                      flex: 1, padding: '8px', 'background': nextWaypoint()?.isWalk ? '#10b981' : '#f59e0b', color: '#fff',
                      border: nextWaypoint()?.isWalk ? '1px solid #059669' : '1px solid #d97706', 'border-radius': '4px', cursor: 'pointer',
                      'font-size': '0.9em', 'font-weight': 'bold',
                      'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '6px',
                      'min-width': 0
                    }}
                    title={nextWaypoint()?.isWalk ? "Stop moving immediately" : "Stops at the next upcoming station and cancels remaining trip"}
                  >
                    <span style={{ 'flex-shrink': 0 }}>🛑</span>
                    <span style={{
                      'white-space': 'nowrap',
                      'overflow': 'hidden',
                      'text-overflow': 'ellipsis',
                      'flex': 1
                    }}>
                      {nextWaypoint()?.isWalk ? 'Stop walking' : `Get off at ${nextWaypoint()?.stopName || ''}`}
                    </span>
                  </button>
                </Show>

                {roomState() === 'RUNNING' && (() => {
                  const me = players()[myId()!];
                  const isSnoozing = (me?.desiredRate || 1.0) > 1.0;
                  return (
                    <button
                      onClick={() => toggleSnooze()}
                      style={{
                        padding: '8px', 'background': isSnoozing ? '#3b82f6' : '#f1f5f9',
                        color: isSnoozing ? 'white' : '#475569',
                        border: isSnoozing ? '1px solid #2563eb' : '1px solid #cbd5e1',
                        'border-radius': '4px', cursor: 'pointer', 'font-size': '1.2em', 'font-weight': 'bold',
                        'display': 'flex', 'align-items': 'center', 'justify-content': 'center',
                        'width': '42px', 'flex-shrink': 0
                      }}
                      title={isSnoozing ? 'Snoozing (500x)' : 'Snooze'}
                    >
                      <span>{isSnoozing ? '⏩' : '💤'}</span>
                    </button>
                  );
                })()}
              </div>
            </Show>

            {/* Expanded Content */}
            <Show when={!minimized()}>
              <div style={{ 'overflow-y': 'auto', 'padding-right': '4px' }}>
                {/* Header Info */}
                <div style={{ 'margin-bottom': '8px' }}>
                  <Clock />
                  <div style={{ 'font-size': '0.75em', 'font-weight': 'bold', 'color': '#475569', 'margin-bottom': '6px', 'text-align': 'center' }}>
                    {findClosestCity({ latitude: bounds()!.start?.[0] || 0, longitude: bounds()!.start?.[1] || 0 })} ➡️ {findClosestCity({ latitude: bounds()!.finish?.[0] || 0, longitude: bounds()!.finish?.[1] || 0 })}
                  </div>
                  <div style={{ 'font-size': '0.85em', 'color': '#d97706', 'margin-top': '2px' }}>
                    Time dilation: {rate().toFixed(2)}x
                  </div>
                  <Show when={elapsedTime()}>
                    <div style={{ 'font-size': '0.85em', 'color': '#059669', 'margin-top': '2px', 'font-weight': 'bold' }}>
                      Elapsed: {elapsedTime()}
                    </div>
                  </Show>
                </div>

                <Show when={roomState() === 'JOINING'}>
                  <div style={{
                    'background': '#f1f5f9', 'padding': '8px', 'border-radius': '4px',
                    'border': '1px solid #cbd5e1', 'margin-bottom': '10px'
                  }}>
                    <Show when={bounds()}>
                      <div style={{ 'font-size': '0.75em', 'font-weight': 'bold', 'color': '#475569', 'margin-bottom': '6px' }}>
                        {findClosestCity({ latitude: bounds()!.start?.[0] || 0, longitude: bounds()!.start?.[1] || 0 })} ➡️ {findClosestCity({ latitude: bounds()!.finish?.[0] || 0, longitude: bounds()!.finish?.[1] || 0 })}
                      </div>
                    </Show>

                    <div style={{ 'margin-bottom': '6px' }}>
                      <label style={{ 'display': 'block', 'font-size': '0.7em', 'color': '#64748b' }}>Start time: </label>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <input
                          type="time"
                          value={startTimeStr()}
                          onInput={(e) => setStartTimeStr(e.currentTarget.value)}
                          style={{ width: '100%', 'font-size': '0.8em', padding: '4px', 'box-sizing': 'border-box', 'font-family': 'unset' }}
                        />
                      </div>
                    </div>

                    <div style={{ 'margin-bottom': '6px' }}>
                      <label style={{ 'display': 'block', 'font-size': '0.7em', 'color': '#64748b' }}>Start (Lat, lng): </label>
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
                            background: pickerMode() === 'start' ? '#3b82f6' : '#cbd5e1',
                            color: pickerMode() === 'start' ? 'white' : '#475569',
                            border: 'none', 'border-radius': '4px', cursor: 'pointer', width: '28px', padding: 0
                          }}
                        >
                          🧭
                        </button>
                      </div>
                    </div>

                    <div style={{ 'margin-bottom': '6px' }}>
                      <label style={{ 'display': 'block', 'font-size': '0.7em', 'color': '#64748b' }}>Finish (Lat, Lng)</label>
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
                            background: pickerMode() === 'finish' ? '#3b82f6' : '#cbd5e1',
                            color: pickerMode() === 'finish' ? 'white' : '#475569',
                            border: 'none', 'border-radius': '4px', cursor: 'pointer', width: '28px', padding: 0
                          }}
                        >
                          🧭
                        </button>
                      </div>
                    </div>
                    <div style={{ 'margin-bottom': '12px' }}>
                      <label style={{ 'display': 'block', 'font-size': '0.7em', 'color': '#64748b' }}>Difficulty: </label>
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
                      <div style={{ display: 'flex', 'justify-content': 'space-between', 'font-size': '0.65rem', 'color': '#64748b' }}>
                        <span style={{ opacity: diff() === 'Easy' ? 1 : 0.5 }}>Easy</span>
                        <span style={{ opacity: diff() === 'Normal' ? 1 : 0.5 }}>Normal</span>
                        <span style={{ opacity: diff() === 'Transport nerd' ? 1 : 0.5 }}>Nerd</span>
                      </div>
                      <div style={{ 'font-size': '0.7em', 'color': '#777', 'font-style': 'italic', 'margin': '4px 0', 'min-height': '1.2em' }}>
                        {diff() === 'Easy' && "Adds arrival times and destinations"}
                        {diff() === 'Normal' && "Adds cardinal directions"}
                        {diff() === 'Transport nerd' && "Adds debug info 💻"}
                      </div>
                    </div>

                    <button
                      onClick={updateBounds}
                      disabled={isSaved()}
                      style={{
                        width: '100%', padding: '4px',
                        'background': isSaved() ? '#10b981' : '#0f172a',
                        'color': 'white',
                        border: 'none', 'border-radius': '4px',
                        'cursor': isSaved() ? 'default' : 'pointer',
                        'font-size': '0.8em',
                        'font-weight': 'bold',
                        'transition': 'all 0.2s'
                      }}
                    >
                      {isSaved() ? 'Synced ✓' : 'Set course'}
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
                        const nextWp = createMemo(() => p().waypoints.find((wp: any) => wp.arrivalTime > time()));
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
                              'color': p().id === myId() ? '#0f172a' : '#334155',
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
                                  onInput={(e) => setPlayerColor(e.currentTarget.value)}
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
                                {p().id} {p().id === myId() ? '(You)' : ''} {(p().desiredRate || 1) > 1 && '💤'}
                              </div>
                              <Show when={isFinished()}>
                                <div style={{ 'font-size': '0.75em', 'color': '#059669', 'font-weight': 'bold' }}>
                                  Finished in {formatDuration(p().finishTime!)}
                                </div>
                              </Show>
                              <Show when={!isFinished()}>
                                <Show when={nextWp()} fallback={
                                  <Show when={p().viewingStopName}>
                                    <div style={{ 'font-size': '0.7em', 'color': '#64748b', 'margin-top': '0px', 'display': 'flex', 'align-items': 'center', 'gap': '4px' }}>
                                      🔍 Looking at departures @ {p().viewingStopName}
                                    </div>
                                  </Show>
                                }>
                                  {(wp) => (
                                    <div style={{ 'font-size': '0.7em', 'color': '#64748b', 'margin-top': '0px', 'display': 'flex', 'align-items': 'center', 'gap': '4px' }}>
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
                                      {wp().emoji + " " || ''} &rarr; {wp().stopName}
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
                                'color': '#64748b',
                                'margin-right': '6px',
                                'min-width': '60px',
                                'text-align': 'right'
                              }}>
                                {mySpeed()} km/h {myDist()} km
                              </span>
                            </Show>
                            {roomState() !== 'RUNNING' && (
                              p().isReady ? (
                                <span style={{ color: '#059669', 'font-size': '0.8em', 'font-weight': 'bold' }}>✓</span>
                              ) : (
                                <span style={{ color: '#94a3b8', 'font-size': '0.8em' }}>...</span>
                              )
                            )}
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </div>

                {/* Footer Actions */}
                <div style={{ 'margin-top': '12px', 'border-top': '1px solid #ccc', 'padding-top': '8px' }}>
                  <Show when={canCancel()} fallback={
                    <Show when={roomState() === 'RUNNING'} >
                      <button disabled style={{
                        width: '100%', padding: '8px', background: '#f1f5f9', color: '#94a3b8',
                        border: '1px solid #cbd5e1', 'border-radius': '4px', cursor: 'not-allowed',
                        'font-size': '0.9em', 'font-weight': 'bold', 'margin-bottom': '8px',
                        'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '6px'
                      }}>
                        <span>🚶</span> Double click map to walk
                      </button>
                    </Show>
                  }>
                    <button
                      onClick={() => nextWaypoint()?.isWalk ? stopImmediately() : cancelNavigation()}
                      style={{
                        width: '100%', padding: '8px', 'background': nextWaypoint()?.isWalk ? '#10b981' : '#f59e0b', color: '#fff',
                        border: nextWaypoint()?.isWalk ? '1px solid #059669' : '1px solid #d97706', 'border-radius': '4px', cursor: 'pointer',
                        'font-size': '0.9em', 'font-weight': 'bold', 'margin-bottom': '8px',
                        'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '6px'
                      }}
                      title={nextWaypoint()?.isWalk ? "Stop moving immediately" : "Stops at the next upcoming station and cancels remaining trip"}
                    >
                      <span>🛑</span> {nextWaypoint()?.isWalk ? 'Stop walking' : `Get off at ${nextWaypoint()?.stopName || ''}`}
                    </button>
                  </Show>
                  {roomState() !== 'RUNNING' && (
                    <button
                      onClick={() => {
                        toggleReady();
                        !players()[myId()!].isReady ? fitGameBounds() : null;
                      }}
                      style={{
                        width: '100%', padding: '10px', 'background': players()[myId()!]?.isReady ? '#f1f5f9' : '#3b82f6',
                        color: players()[myId()!]?.isReady ? '#475569' : 'white',
                        border: '1px solid #cbd5e1', 'border-radius': '4px', cursor: 'pointer',
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
                        const isSnoozing = createMemo(() => (me().desiredRate || 1.0) > 1.0);
                        return (
                          <>
                            <button
                              onClick={() => toggleSnooze()}
                              style={{
                                width: '100%', padding: '8px', 'background': isSnoozing() ? '#3b82f6' : '#f1f5f9',
                                color: isSnoozing() ? 'white' : '#475569',
                                border: isSnoozing() ? '1px solid #2563eb' : '1px solid #cbd5e1',
                                'border-radius': '4px', cursor: 'pointer', 'font-size': '0.9em', 'font-weight': 'bold',
                                'margin-top': '8px', 'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '6px'
                              }}
                              title="Request 500x speed simulation"
                            >
                              <span>{isSnoozing() ? '⏩' : '💤'}</span> {isSnoozing() ? 'Snoozing (500x)' : 'Snooze'}
                            </button>
                            <Show when={me().finishTime}>
                              <button
                                onClick={() => setShowWinModal(true)}
                                style={{
                                  width: '100%', padding: '8px', 'background': '#f1f5f9',
                                  color: '#475569',
                                  border: '1px solid #cbd5e1',
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
                      'background': leaveConfirm() ? '#b91c1c' : '#fee2e2',
                      'color': leaveConfirm() ? '#ffffff' : '#991b1b',
                      border: '1px solid #fecaca', 'border-radius': '4px', cursor: 'pointer', 'font-size': '0.85em',
                      'margin-top': '8px',
                      transition: 'all 0.2s'
                    }}
                  >
                    {leaveConfirm() ? 'Click again to confirm' : $isSinglePlayer.get() ? 'Return to main menu' : 'Leave room'}
                  </button>

                  <div class="interaction-hint" style={{ 'font-size': '0.75em', 'color': '#94a3b8', 'margin-top': '6px', 'text-align': 'center' }}>
                    {roomState() === 'RUNNING' ? <a href="https://github.com/bovine3dom/fahrtle?tab=readme-ov-file#fahrtle" target="_blank" rel="noopener noreferrer" style={{ color: '#94a3b8' }}>Click map for departures, double click to board or walk<br />Click here for more information</a> : 'Waiting for game to start...'}
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
        </div>
      )}
      {showWinModal() && players()[myId()!] && (
        <WinModal
          player={players()[myId()!]!}
          onSpectate={handleSpectate}
          onClose={() => setShowWinModal(false)}
        />
      )}
    </>
  );
}

export default App;
