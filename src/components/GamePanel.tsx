import { Show, createMemo, createSignal } from 'solid-js';
import { useStore } from '@nanostores/solid';
import { $currentRoom, leaveRoom, $globalRate, $roomState, toggleReady, $gameBounds, $isSinglePlayer, $isDaily, $isRerun, stopImmediately } from '../store';
import Clock from '../Clock';
import { fitGameBounds } from '../Map';
import { formatDuration } from '../utils/time';
import { colours } from '../colours';
import { SpeedControls } from './SpeedControls';
import { GetOffButton } from './GetOffButton';
import { GameSettings } from './GameSettings';
import { PlayerList } from './PlayerList';
import { createClosestCity } from '../utils/tiny-cities';
import type { Difficulty } from '../shared/gameLogic';

function getSpeedMode(desiredRate: number | undefined, forceRealtime: boolean | undefined): 'auto' | 'snooze' | 'realtime' {
  if (forceRealtime) return 'realtime';
  if ((desiredRate || 1) > 1) return 'snooze';
  return 'auto';
}

export function GamePanel(props: {
  players: () => Record<string, any>;
  myId: () => string | null;
  time: () => number;
  startTime: () => number | null;
  showWinModal: boolean;
  setShowWinModal: (v: boolean) => void;
  handleSpectate: () => void;
  showSettings: boolean;
  setShowSettings: (v: boolean) => void;
  showTutorial: boolean;
  setShowTutorial: (v: boolean) => void;
  startStr: string;
  setStartStr: (v: string) => void;
  startTimeStr: string;
  setStartTimeStr: (v: string) => void;
  finishStr: string;
  setFinishStr: (v: string) => void;
  diff: Difficulty;
  setDiff: (v: Difficulty) => void;
  compDriver: boolean;
  setCompDriver: (v: boolean) => void;
  useGhosts: boolean;
  setUseGhosts: (v: boolean) => void;
  isSaved: () => boolean;
  updateBounds: () => void;
  pickerMode: () => 'start' | 'finish' | null;
  togglePicker: (mode: 'start' | 'finish') => void;
  canCancel: () => boolean;
  canSnooze: () => boolean;
  isOnTransport: () => boolean;
  nextWaypoint: () => any;
  futureWaypoints: () => any[];
  sortedPlayerIds: () => string[];
  bounds: () => any;
  rate: () => number;
  elapsedTime: () => string | null;
  isDaily: boolean;
  isRerun: boolean;
  roomState: () => 'JOINING' | 'COUNTDOWN' | 'RUNNING';
  leaveConfirm: boolean;
  setLeaveConfirm: (v: boolean) => void;
  getOffDropdownOpen: boolean;
  setGetOffDropdownOpen: (v: boolean) => void;
  actionFeedback: () => string | null;
  setActionFeedback: (v: string | null) => void;
}) {
  const room = useStore($currentRoom);
  const roomState = useStore($roomState);
  const isRerun = useStore($isRerun);
  const bounds = useStore($gameBounds);
  const rate = useStore($globalRate);
  const isDaily = useStore($isDaily);

  const [minimized, setMinimized] = createSignal(false);

  const elapsedTime = createMemo(() => {
    const start = props.startTime();
    const now = props.time();
    if (start && now >= start) {
      return formatDuration(now - start);
    }
    return null;
  });

  const canCancel = createMemo(() => {
    const p = props.players()[props.myId()!];
    if (!p) return false;
    const futurePoints = p.waypoints.filter((wp: any) => (wp.arrivalTime > props.time()) && !wp.isInterstop );
    if (futurePoints.length === 0) return false;
    if (futurePoints.length > 1) return true;
    if (futurePoints[0].isWalk || futurePoints[0].isWait) return true;
    return false;
  });

  return (
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
      <div style={{
        display: 'flex',
        'justify-content': 'space-between',
        'align-items': 'center',
        'margin-bottom': minimized() ? '0' : '8px'
      }}>
        <Show when={!minimized()} fallback={<Clock style={{ flex: 1 }} />}>
          <div style={{ 'font-size': '1.1em', 'font-weight': 'bold' }}>
            {isDaily() ? 'Daily race' : $isSinglePlayer.get() ? 'Single player' : `Room: ${room()}`}
          </div>
        </Show>

        <div style={{ display: 'flex', 'align-items': 'center' }}>
          <button
            onClick={() => props.setShowTutorial(true)}
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
            onClick={() => props.setShowSettings(true)}
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
                  !props.players()[props.myId()!].isReady ? fitGameBounds() : null;
                }}
                style={{
                  width: '100%', padding: '10px', 'background': props.players()[props.myId()!]?.isReady ? colours.bg : colours.primary,
                  color: props.players()[props.myId()!]?.isReady ? colours.text : 'white',
                  border: '1px solid colours.border', 'border-radius': '4px', cursor: 'pointer',
                  'font-size': '0.9em', 'font-weight': 'bold', 'margin-bottom': '8px'
                }}
              >
                {props.players()[props.myId()!]?.isReady ? 'Unready' : $isSinglePlayer.get() ? 'Start game' : 'Ready up'}
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
                  Click map to see departures or walk
                </span>
              </button>
            </Show>
          }>
            <GetOffButton
              dropdownOpen={props.getOffDropdownOpen}
              setDropdownOpen={props.setGetOffDropdownOpen}
              actionFeedback={props.actionFeedback}
              setActionFeedback={props.setActionFeedback}
              futureWaypoints={props.futureWaypoints}
              nextWaypoint={props.nextWaypoint}
              stopImmediately={stopImmediately}
            />
          </Show>

          <Show when={roomState() === 'RUNNING'}>
            {(() => {
              const me = props.players()[props.myId()!];
              return <SpeedControls mode={getSpeedMode(me?.desiredRate, me?.forceRealtime)} compact canSnooze={props.canSnooze} />;
            })()}
          </Show>
        </div>
      </Show>

      <Show when={!minimized()}>
        <div style={{ display: 'flex', 'flex-direction': 'column', 'max-height': 'calc(100vh - 100px)', 'min-height': 0 }}>
          <div style={{ 'overflow-y': 'auto', 'padding-right': '4px', 'flex': 1, 'min-height': 0 }}>
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
              <GameSettings
                isDaily={props.isDaily}
                bounds={bounds()}
                startTimeStr={props.startTimeStr}
                setStartTimeStr={props.setStartTimeStr}
                startStr={props.startStr}
                setStartStr={props.setStartStr}
                finishStr={props.finishStr}
                setFinishStr={props.setFinishStr}
                diff={props.diff}
                setDiff={props.setDiff}
                compDriver={props.compDriver}
                setCompDriver={props.setCompDriver}
                useGhosts={props.useGhosts}
                setUseGhosts={props.setUseGhosts}
                isSaved={props.isSaved()}
                updateBounds={props.updateBounds}
                pickerMode={props.pickerMode()}
                togglePicker={props.togglePicker}
              />
            </Show>

            <PlayerList
              sortedPlayerIds={props.sortedPlayerIds}
              players={props.players}
              myId={props.myId}
              roomState={roomState}
              time={props.time}
            />
          </div>

          <div style={{ 'margin-top': '12px', 'border-top': '1px solid #ccc', 'padding-top': '8px', 'flex-shrink': 0 }}>
            <Show when={canCancel()} fallback={
              <Show when={roomState() === 'RUNNING'} >
                <button disabled style={{
                  width: '100%', padding: '8px', background: colours.bg, color: colours.textLight,
                  border: '1px solid colours.border', 'border-radius': '4px', cursor: 'not-allowed',
                  'font-size': '0.9em', 'font-weight': 'bold', 'margin-bottom': '8px',
                  'display': 'flex', 'align-items': 'center', 'justify-content': 'center', 'gap': '6px'
                }}>
                  <span>🚶</span> Click map for menu
                </button>
              </Show>
            }>
              <GetOffButton
                dropdownOpen={props.getOffDropdownOpen}
                setDropdownOpen={props.setGetOffDropdownOpen}
                actionFeedback={props.actionFeedback}
                setActionFeedback={props.setActionFeedback}
                futureWaypoints={props.futureWaypoints}
                nextWaypoint={props.nextWaypoint}
                stopImmediately={stopImmediately}
              />
            </Show>
            {roomState() !== 'RUNNING' && (
              <button
                onClick={() => {
                  toggleReady();
                  !props.players()[props.myId()!].isReady ? fitGameBounds() : null;
                }}
                style={{
                  width: '100%', padding: '10px', 'background': props.players()[props.myId()!]?.isReady ? colours.bg : colours.primary,
                  color: props.players()[props.myId()!]?.isReady ? colours.text : 'white',
                  border: '1px solid colours.border', 'border-radius': '4px', cursor: 'pointer',
                  'font-size': '0.9em', 'font-weight': 'bold', 'margin-bottom': '8px'
                }}
              >
                {props.players()[props.myId()!]?.isReady ? 'Unready' : $isSinglePlayer.get() ? 'Start game' : 'Ready up'}
              </button>
            )}
            <Show when={roomState() === 'RUNNING'}>
              <Show when={props.players()[props.myId()!]}>
                {(me) => {
                  const mode = createMemo(() => getSpeedMode(me().desiredRate, me().forceRealtime));
                  return (
                    <>
                      <div style={{ 'margin-top': '8px' }}>
                        <SpeedControls mode={mode()} canSnooze={props.canSnooze} />
                      </div>
                      <Show when={me().finishTime}>
                        <button
                          onClick={() => props.setShowWinModal(true)}
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
                if (props.leaveConfirm) {
                  leaveRoom();
                } else {
                  props.setLeaveConfirm(true);
                }
              }}
              style={{
                width: '100%', padding: '6px',
                'background': props.leaveConfirm ? colours.danger : colours.dangerLight,
                'color': props.leaveConfirm ? colours.white : colours.dangerDark,
                border: `1px solid ${colours.dangerBorder}`, 'border-radius': '4px', cursor: 'pointer', 'font-size': '0.85em',
                'margin-top': '8px',
                transition: 'all 0.2s'
              }}
            >
              {props.leaveConfirm ? 'Click again to confirm' : $isSinglePlayer.get() ? 'Return to main menu' : 'Leave room'}
            </button>

            <div class="interaction-hint" style={{ 'font-size': '0.75em', 'color': colours.textLight, 'margin-top': '6px', 'text-align': 'center' }}>
              {roomState() === 'RUNNING' ? 'Click map for menu' : 'Waiting for game to start...'}
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
