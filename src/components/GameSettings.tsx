import { Show } from 'solid-js';
import { createClosestCity } from '../utils/tiny-cities';
import { colours } from '../colours';
import type { Difficulty, GameBounds } from '../shared/gameLogic';

export function GameSettings(props: {
  isDaily: boolean;
  bounds: GameBounds;
  startTimeStr: string;
  setStartTimeStr: (v: string) => void;
  startStr: string;
  setStartStr: (v: string) => void;
  finishStr: string;
  setFinishStr: (v: string) => void;
  diff: Difficulty;
  setDiff: (v: Difficulty) => void;
  compDriver: boolean;
  setCompDriver: (v: boolean) => void;
  useGhosts: boolean;
  setUseGhosts: (v: boolean) => void;
  isSaved: boolean;
  updateBounds: () => void;
  pickerMode: 'start' | 'finish' | null;
  togglePicker: (mode: 'start' | 'finish') => void;
}) {
  return (
    <div style={{
      'background': colours.bg, 'padding': '8px', 'border-radius': '4px',
      'border': '1px solid colours.border', 'margin-bottom': '10px'
    }}>
      <Show when={props.bounds}>
        <div style={{ 'font-size': '0.75em', 'font-weight': 'bold', 'color': colours.text, 'margin-bottom': '6px' }}>
          {createClosestCity(() => props.bounds.start ? { lat: props.bounds.start![0], lon: props.bounds.start![1] } : null)()} ➡️ {createClosestCity(() => props.bounds.finish ? { lat: props.bounds.finish![0], lon: props.bounds.finish![1] } : null)()}
        </div>
      </Show>

      <Show when={!props.isDaily}>
        <div style={{ 'margin-bottom': '6px' }}>
          <label style={{ 'display': 'block', 'font-size': '0.7em', 'color': 'colours.textMuted' }}>Start time: </label>
          <div style={{ display: 'flex', gap: '4px' }}>
            <input
              type="time"
              value={props.startTimeStr}
              onInput={(e) => props.setStartTimeStr(e.currentTarget.value)}
              style={{ width: '100%', 'font-size': '0.8em', padding: '4px', 'box-sizing': 'border-box', 'font-family': 'unset' }}
            />
          </div>
        </div>
      </Show>

      <Show when={!props.isDaily}>
        <div style={{ 'margin-bottom': '6px' }}>
          <label style={{ 'display': 'block', 'font-size': '0.7em', 'color': 'colours.textMuted' }}>Start (lat, lng, but, seriously, use the picker): </label>
          <div style={{ display: 'flex', gap: '4px' }}>
            <input
              type="text"
              value={props.startStr}
              onInput={(e) => props.setStartStr(e.currentTarget.value)}
              placeholder="e.g. 55.953, -3.188"
              style={{ width: '100%', 'font-size': '0.8em', padding: '4px', 'box-sizing': 'border-box' }}
            />
            <button
              onClick={() => props.togglePicker('start')}
              title="Pick on Map"
              style={{
                background: props.pickerMode === 'start' ? colours.primary : colours.border,
                color: props.pickerMode === 'start' ? 'white' : colours.text,
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
              value={props.finishStr}
              onInput={(e) => props.setFinishStr(e.currentTarget.value)}
              placeholder="e.g. 51.507, -0.127"
              style={{ width: '100%', 'font-size': '0.8em', padding: '4px', 'box-sizing': 'border-box' }}
            />
            <button
              onClick={() => props.togglePicker('finish')}
              title="Pick on Map"
              style={{
                background: props.pickerMode === 'finish' ? colours.primary : colours.border,
                color: props.pickerMode === 'finish' ? 'white' : colours.text,
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
          value={['Easy', 'Normal', 'Transport nerd'].indexOf(props.diff)}
          onInput={e => {
            const values: Difficulty[] = ['Easy', 'Normal', 'Transport nerd'];
            props.setDiff(values[parseInt(e.currentTarget.value)]);
          }}
          style={{ width: '100%', cursor: 'pointer' }}
        />
        <div style={{ display: 'flex', 'justify-content': 'space-between', 'font-size': '0.65rem', 'color': 'colours.textMuted' }}>
          <span style={{ opacity: props.diff === 'Easy' ? 1 : 0.5 }}>Easy</span>
          <span style={{ opacity: props.diff === 'Normal' ? 1 : 0.5 }}>Normal</span>
          <span style={{ opacity: props.diff === 'Transport nerd' ? 1 : 0.5 }}>Nerd</span>
        </div>
        <div style={{ 'font-size': '0.7em', 'color': '#777', 'font-style': 'italic', 'margin': '4px 0', 'min-height': '1.2em' }}>
          {props.diff === 'Easy' && "Adds arrival times, speeds and destinations"}
          {props.diff === 'Normal' && "Adds cardinal directions"}
          {props.diff === 'Transport nerd' && "Adds debug info 💻"}
        </div>
      </div>

      <div style={{ 'margin-bottom': '12px' }}>
        <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
          <input
            type="checkbox"
            role="switch"
            checked={props.compDriver}
            onChange={(e) => props.setCompDriver(e.currentTarget.checked)}
            style={{ cursor: 'pointer' }}
          />
          <label style={{ 'font-size': '0.8rem', 'color': colours.textMuted, 'font-weight': 'bold', cursor: 'pointer' }} onClick={() => props.setCompDriver(!props.compDriver)}>
            Add robot opponent 🤖
          </label>
        </div>
      </div>

      <Show when={props.isDaily}>
        <div style={{ 'margin-bottom': '12px' }}>
          <div style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
            <input
              type="checkbox"
              role="switch"
              checked={props.useGhosts}
              onChange={(e) => props.setUseGhosts(e.currentTarget.checked)}
              style={{ cursor: 'pointer' }}
            />
            <label style={{ 'font-size': '0.8rem', 'color': colours.textMuted, 'font-weight': 'bold', cursor: 'pointer' }} onClick={() => props.setUseGhosts(!props.useGhosts)}>
              Play against ghosts 👻
            </label>
          </div>
        </div>
      </Show>

      <button
        onClick={props.updateBounds}
        disabled={props.isSaved}
        style={{
          width: '100%', padding: '4px',
          'background': props.isSaved ? colours.success : colours.textDark,
          'color': 'white',
          border: 'none', 'border-radius': '4px',
          'cursor': props.isSaved ? 'default' : 'pointer',
          'font-size': '0.8em',
          'font-weight': 'bold',
          'transition': 'all 0.2s'
        }}
      >
        {props.isSaved ? 'Synced ✓' : 'Confirm settings'}
      </button>
    </div>
  );
}
