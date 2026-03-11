import { createResource, createSignal, For, Show, createEffect } from 'solid-js';
import { colours } from './colours';
import { formatDuration } from './utils/time';
import { getRaceByIndex } from './utils/daily';
import { cityDbPromise, getClosestCityObject } from './utils/tiny-cities';
import { sensibleNumber } from './utils/format';

const s: Record<string, any> = {
  overlay: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.7)', 'z-index': 1000, display: 'flex', 'justify-content': 'center', 'align-items': 'center', 'backdrop-filter': 'blur(4px)' },
  modal: { background: 'rgba(15, 23, 42, 0.95)', padding: '24px', 'border-radius': '16px', 'box-shadow': '0 4px 20px rgba(0,0,0,0.5)', 'max-width': '90%', width: '500px', display: 'flex', 'flex-direction': 'column', gap: '16px', 'max-height': '80vh', border: '1px solid rgba(255,255,255,0.1)' },
  title: { 'text-align': 'center', 'font-size': '1.5rem', 'font-weight': 'bold', color: 'white' },
  tableContainer: { 'overflow-y': 'auto', 'max-height': '50vh' },
  table: { width: '100%', 'border-collapse': 'collapse', 'font-size': '0.9em', color: 'white' },
  th: { padding: '8px', 'text-align': 'left', 'border-bottom': '2px solid rgba(255,255,255,0.2)', 'font-weight': 'bold' },
  td: { padding: '8px', 'border-bottom': '1px solid rgba(255,255,255,0.1)' },
  rank: { width: '40px', 'text-align': 'center' as const },
  time: { 'text-align': 'right' as const },
  closeBtn: { padding: '10px 20px', background: colours.primary, color: 'white', border: 'none', 'border-radius': '8px', cursor: 'pointer', 'font-weight': 'bold' },
  loading: { 'text-align': 'center', padding: '20px', color: colours.textLight },
  error: { 'text-align': 'center', padding: '20px', color: colours.danger },
};

interface LeaderboardEntry {
  playerName: string;
  raceIndex: string;
  finishTime: number;
  kgCO2e: number;
}

interface LeaderboardModalProps {
  version: number;
  onClose: () => void;
}

export default function LeaderboardModal(props: LeaderboardModalProps) {
  const [leaderboard] = createResource(
    () => props.version,
    async (version) => {
      const apiUrl = import.meta.env.PROD ? '' : 'http://localhost:8080/';
      const response = await fetch(`${apiUrl}api/leaderboard/${version}`);
      if (!response.ok) throw new Error('Failed to fetch leaderboard');
      return response.json() as Promise<LeaderboardEntry[]>;
    }
  );

  const raceIndices = () => {
    const entries = leaderboard() || [];
    const indices = new Set(entries.map(e => e.raceIndex));
    return Array.from(indices).map(Number).sort((a, b) => b - a);
  };

  const chartData = () => {
    const entries = leaderboard() || [];
    const indices = raceIndices().slice(0, 10).reverse();
    return indices.map(idx => ({
      raceIndex: idx,
      count: entries.filter(e => parseInt(e.raceIndex, 10) === idx).length
    }));
  };

  const maxCount = () => Math.max(...chartData().map(d => d.count), 1);

  const [raceLabels, setRaceLabels] = createSignal<Record<number, string>>({});

  // getting the values to update reactively in the select was a massive pita
  createEffect(async () => {
    const indices = raceIndices();
    if (indices.length === 0) return;
    
    await cityDbPromise;
    
    const labels: Record<number, string> = {};
    for (const idx of indices) {
      const race = await getRaceByIndex(idx);
      const startCity = getClosestCityObject(race.start[0], race.start[1]);
      const finishCity = getClosestCityObject(race.finish[0], race.finish[1]);
      labels[idx] = `${startCity} → ${finishCity}`;
    }
    setRaceLabels(labels);
  });

  const getSelectedRaceFromUrl = () => {
    const params = new URLSearchParams(window.location.search);
    const race = params.get('leaderboard');
    if (race) {
      const parts = race.split('-');
      if (parts.length > 1) {
        return parseInt(parts[1], 10);
      }
    }
    return null;
  };

  const setSelectedRaceInUrl = (raceIndex: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set('leaderboard', `${props.version}-${raceIndex}`);
    window.history.pushState(window.history.state, '', url);
  };

  const defaultRaceIndex = () => {
    const indices = raceIndices();
    return indices.length > 0 ? indices[0] : null;
  };

  const [selectedRace, setSelectedRace] = createSignal<number | null>(null);

  createEffect(() => {
    const entries = leaderboard();
    if (entries) {
      const urlRace = getSelectedRaceFromUrl();
      if (urlRace !== null && raceIndices().includes(urlRace)) {
        setSelectedRace(urlRace);
      } else {
        const defaultIdx = defaultRaceIndex();
        setSelectedRace(defaultIdx);
        if (defaultIdx !== null) {
          setSelectedRaceInUrl(defaultIdx);
        }
      }
    }
  });

  const handleRaceChange = (e: Event) => {
    const value = parseInt((e.target as HTMLSelectElement).value, 10);
    setSelectedRace(value);
    setSelectedRaceInUrl(value);
  };

  const currentRaceEntries = () => {
    const entries = leaderboard() || [];
    const race = selectedRace();
    if (race === null) return [];
    return entries.filter(e => parseInt(e.raceIndex, 10) === race);
  };

  return (
    <div onClick={props.onClose} style={s.overlay}>
      <div onClick={(e) => e.stopPropagation()} style={s.modal}>
        <div style={s.title}>🏆 Leaderboard</div>
        
        <Show when={leaderboard.loading}>
          <div style={s.loading}>Loading...</div>
        </Show>
        
        <Show when={leaderboard.error}>
          <div style={s.error}>Failed to load leaderboard</div>
        </Show>
        
        <Show when={leaderboard() && raceIndices().length > 0}>
          <select 
            value={selectedRace() ?? ''} 
            onChange={handleRaceChange}
            class="dark-select"
            style={{ width: '100%', padding: '10px', 'font-size': '1em', 'border-radius': '8px', border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer' }}
          >
            <For each={raceIndices()}>
              {(idx) => (
                <option value={idx}>#{idx}: {raceLabels()[idx] || `Race #${idx}`}</option>
              )}
            </For>
          </select>
        </Show>
        
        <Show when={leaderboard() && selectedRace() !== null}>
          <div style={s.tableContainer}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={{ ...s.th, ...s.rank }}>#</th>
                  <th style={s.th}>Player</th>
                  <th style={{ ...s.th, ...s.time }}>Time</th>
                  <th style={{ ...s.th, ...s.time}}>kgCO₂e</th>
                </tr>
              </thead>
              <tbody>
                <For each={currentRaceEntries()}>
                  {(entry, idx) => (
                    <tr>
                      <td style={{ ...s.td, ...s.rank }}>
                        {idx() === 0 ? '🥇' : idx() === 1 ? '🥈' : idx() === 2 ? '🥉' : idx() + 1}
                      </td>
                      <td style={s.td}>{entry.playerName}</td>
                      <td style={{ ...s.td, ...s.time }}>{formatDuration(entry.finishTime)}</td>
                      <td style={{ ...s.td, ...s.time}}>{sensibleNumber(entry.kgCO2e)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        <Show when={leaderboard() && raceIndices().length === 0}>
          <div style={s.loading}>No entries yet</div>
        </Show>
        
        <Show when={leaderboard() && chartData().length > 0}>
          <div style={{ 'margin-top': '8px' }}>
            <div style={{ 'font-size': '0.8rem', color: colours.textLight, 'margin-bottom': '4px', 'text-align': 'center' }}>Players over last 10 races</div>
            <svg width="100%" height="60" viewBox="0 0 400 60" preserveAspectRatio="none" style={{ 'font-size': '8px', fill: colours.textLight }}>
              <For each={(() => {
                const max = maxCount();
                const step = Math.ceil(max / 5 / 5) * 5 || 5;
                return Array.from({ length: Math.min(5, Math.ceil(max / step)) }, (_, i) => (i + 1) * step);
              })()}>
                {(tick) => {
                  const y = 50 - (tick / maxCount()) * 40;
                  return (
                    <>
                      <line x1="0" y1={y} x2="400" y2={y} stroke={colours.border} stroke-width="0.5" stroke-dasharray="2,2" />
                      <text x="0" y={y - 2}>{tick}</text>
                    </>
                  );
                }}
              </For>
              <For each={chartData()}>
                {(d, i) => {
                  const data = chartData();
                  const len = data.length;
                  const x = (i() / (len - 1)) * 380 + 10;
                  const y = 50 - (d.count / maxCount()) * 40;
                  const prevY = i() > 0 ? 50 - (data[i() - 1].count / maxCount()) * 40 : y;
                  return i() > 0 ? (
                    <line 
                      x1={(i() - 1) / (len - 1) * 380 + 10} 
                      y1={prevY} 
                      x2={x} 
                      y2={y} 
                      stroke={colours.primary} 
                      stroke-width="2" 
                    />
                  ) : null;
                }}
              </For>
              <For each={chartData()}>
                {(d, i) => {
                  const data = chartData();
                  const len = data.length;
                  const x = (i() / (len - 1)) * 380 + 10;
                  const y = 50 - (d.count / maxCount()) * 40;
                  return <circle cx={x} cy={y} r="3" fill={colours.primary} />;
                }}
              </For>
            </svg>
          </div>
        </Show>
        
        <button onClick={props.onClose} style={s.closeBtn}>Close</button>
      </div>
    </div>
  );
}
