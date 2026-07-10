import { Suspense, lazy, createSignal, onMount, onCleanup, createMemo, Show, createEffect, untrack } from 'solid-js';
import { useStore } from '@nanostores/solid';
import { $currentRoom, leaveRoom, $globalRate, $roomState, $countdownEnd, $gameBounds, setGameBounds, $pickerMode, $pickedPoint, $gameStartTime, $isDaily, $playerStats, updatePlayerStats, raceAgain } from './store';
import { getRealServerTime } from './time-sync';
import Lobby from './Lobby';
import { fitGameBounds, getPlayerScreenPosition } from './Map';
import DepartureBoard from './DepartureBoard';
import { formatDuration, parseUserTime } from './utils/time';
import { parseCoords } from './utils/format';
import { getTimeZone } from './timezone';
import { GamePanel } from './components/GamePanel';
import { CountdownOverlay } from './components/CountdownOverlay';
import SettingsModal from './SettingsModal';
import TutorialModal from './TutorialModal';
import WinModal from './WinModal';
import { players, myId, time, currentWpIndex, nextWaypoint } from './utils/memos';
import confetti from 'canvas-confetti';
import type { Difficulty } from './shared/gameLogic';
const MapView = lazy(() => import('./Map'));

function App() {
  const room = useStore($currentRoom);
  const rate = useStore($globalRate);
  const roomState = useStore($roomState);
  const countdownEnd = useStore($countdownEnd);
  const bounds = useStore($gameBounds);
  const pickerMode = useStore($pickerMode);
  const pickedPoint = useStore($pickedPoint);
  const startTime = useStore($gameStartTime);
  const isDaily = useStore($isDaily);

  const [startStr, setStartStr] = createSignal("");
  const [startTimeStr, setStartTimeStr] = createSignal("");
  const [finishStr, setFinishStr] = createSignal("");
  const [diff, setDiff] = createSignal<Difficulty>("Easy");
  const [compDriver, setCompDriver] = createSignal(false);
  const [useGhosts, setUseGhosts] = createSignal(false);
  const [showWinModal, setShowWinModal] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);

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
        const leftToFinish = Object.values(players()).filter(p => !p.finishTime).length;
        ((p.desiredRate || 1) && leftToFinish > 0) && import('./store').then(({ toggleSnooze }) => toggleSnooze());
        setShowWinModal(true)
      }, 3000);
    }
  });

  const handleSpectate = () => {
    setShowWinModal(false);
    const mid = myId();
    if (mid) {
      const p = players()[mid];
      if (p && (p.desiredRate || 1) <= 1) {
        import('./store').then(({ toggleSnooze }) => toggleSnooze());
      }
    }
    fitGameBounds();
  };

  createEffect(() => {
    const p = pickedPoint();
    if (p) {
      const newPoint: [number, number] = [p.lat, p.lng];
      if (p.target === 'start') {
        setGameBounds({ start: newPoint });
      } else if (p.target === 'finish') {
        setGameBounds({ finish: newPoint });
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
      if (parsed === null && str.trim() !== "") return false;
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
      const normalizedUserTime = (h && m) ? `${h.padStart(2, '0')}:${m}` : userTime;
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
    setGameBounds({ start: s, finish: f, time: ts, difficulty: diff(), computerDriver: compDriver(), ghosts: useGhosts() });
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
    const futurePoints = p.waypoints.filter((wp: any) => (wp.arrivalTime > time()) && !wp.isInterstop);
    if (futurePoints.length === 0) return false;
    if (futurePoints.length > 1) return true;
    if (futurePoints[0].isWalk || futurePoints[0].isWait) return true;
    return false;
  });

  const isOnTransport = createMemo(() => {
    const p = players()[myId()!];
    if (!p) return false;
    const now = time();
    return p.waypoints.some((wp: any) => now >= wp.startTime && now < wp.arrivalTime && !wp.isWalk && !wp.isWait);
  });

  const canSnooze = createMemo(() => canCancel() || !isOnTransport());

  createEffect(() => {
    if (!canCancel() && isOnTransport()) {
      const me = players()[myId()!];
      const isSnoozing = (me?.desiredRate || 1.0) > 1.0;
      isSnoozing && import('./store').then(({ toggleSnooze }) => toggleSnooze());
    }
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
    const sorted_finishers = Object.keys(all).filter(id => all[id].finishTime != null).sort((idA, idB) => {
      const a = all[idA].finishTime as number;
      const b = all[idB].finishTime as number;
      return a - b;
    });
    const sorted_others = Object.keys(all).filter(id => all[id].finishTime == null).sort((idA, idB) => {
      const a = (all[idA] as any)._dist;
      const b = (all[idB] as any)._dist;
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return a - b;
    });
    return sorted_finishers.concat(sorted_others);
  });

  const canRaceAgain = createMemo(() => {
    const activePlayers = Object.values(players()).filter(p => !p.isGhost && p.disconnectedAt == null);
    return roomState() === 'RUNNING' && activePlayers.length > 0 && activePlayers.every(p => p.finishTime != null);
  });

  createEffect(() => {
    if (roomState() !== 'RUNNING' && showWinModal()) setShowWinModal(false);
  });

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
          <GamePanel
            players={players}
            myId={myId}
            time={time}
            startTime={startTime}
            showWinModal={showWinModal()}
            setShowWinModal={setShowWinModal}
            handleSpectate={handleSpectate}
            showSettings={showSettings()}
            setShowSettings={setShowSettings}
            showTutorial={showTutorial()}
            setShowTutorial={setShowTutorial}
            startStr={startStr()}
            setStartStr={setStartStr}
            startTimeStr={startTimeStr()}
            setStartTimeStr={setStartTimeStr}
            finishStr={finishStr()}
            setFinishStr={setFinishStr}
            diff={diff()}
            setDiff={setDiff}
            compDriver={compDriver()}
            setCompDriver={setCompDriver}
            useGhosts={useGhosts()}
            setUseGhosts={setUseGhosts}
            isSaved={isSaved}
            updateBounds={updateBounds}
            pickerMode={pickerMode}
            togglePicker={togglePicker}
            canCancel={canCancel}
            canSnooze={canSnooze}
            isOnTransport={isOnTransport}
            nextWaypoint={nextWaypoint}
            futureWaypoints={futureWaypoints}
            sortedPlayerIds={sortedPlayerIds}
            bounds={bounds}
            rate={rate}
            elapsedTime={elapsedTime}
            isDaily={isDaily()}
            roomState={roomState}
            leaveConfirm={leaveConfirm()}
            setLeaveConfirm={setLeaveConfirm}
            getOffDropdownOpen={getOffDropdownOpen()}
            setGetOffDropdownOpen={setGetOffDropdownOpen}
            actionFeedback={actionFeedback}
            setActionFeedback={setActionFeedback}
          />
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

          <CountdownOverlay timeLeft={timeLeft()} />

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
          onRaceAgain={canRaceAgain() ? () => {
            raceAgain(players()[myId()!]!.waypoints);
            setShowWinModal(false);
          } : undefined}
        />
      )}
    </>
  );
}

export default App;
