import { createSignal, createEffect, createMemo } from 'solid-js';
import { type Player, $gameBounds, $players, $gameStartTime, $playerStats } from './store';
import { getTravelSummary } from './utils/summary';
import { sensibleNumber } from './utils/format';
import { formatDuration } from './utils/time';
import { colours } from './colours';
import { countryToFlag } from './utils/tiny-countries';

const btnBase = { flex: 1, padding: '10px', 'font-weight': 'bold', 'font-size': '0.9em', 'border-radius': '8px', cursor: 'pointer' };
const boxBase = { background: colours.bgLight, padding: '12px', 'border-radius': '8px', border: `1px solid ${colours.borderLight}`, 'font-family': 'monospace', 'font-size': '0.85em', 'white-space': 'pre-wrap', color: colours.textBody };
const c = { blue: colours.primary, grey: colours.textMuted, border: colours.borderLight };
const s: Record<string, any> = {
  overlay: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.5)', 'z-index': 1000, display: 'flex', 'justify-content': 'center', 'align-items': 'center', 'backdrop-filter': 'blur(4px)' },
  modal: { background: 'white', padding: '24px', 'border-radius': '16px', 'box-shadow': '0 4px 20px rgba(0,0,0,0.2)', 'max-width': '90%', width: '400px', display: 'flex', 'flex-direction': 'column', gap: '16px' },
  contentBox: { ...boxBase, 'max-height': '200px', 'overflow-y': 'auto' },
  statsBox: { ...boxBase, 'max-height': '400px', 'overflow-y': 'auto' },
  tabBtn: (active: boolean) => ({ ...btnBase, background: 'none', border: 'none', 'border-bottom': active ? `2px solid ${c.blue}` : '2px solid transparent', color: active ? c.blue : c.grey }),
  tabContainer: { display: 'flex', borderBottom: `1px solid ${c.border}` },
  row: { display: 'flex', gap: '12px' },
};

interface WinModalProps {
  player: Player;
  onSpectate: () => void;
  onClose: () => void;
  onRaceAgain?: () => void;
}

const WinModal = (props: WinModalProps) => {
  const [copied, setCopied] = createSignal(false);
  const [stealthMode, setStealthMode] = createSignal(false);
  const [travelSummary, setTravelSummary] = createSignal('Loading...');
  const [activeTab, setActiveTab] = createSignal<'summary' | 'stats'>('summary');
  const statsValue = $playerStats.get();

  const stig = () => Object.values($players.get()).find(p => p.id === 'the-stig-🏎️');
  const stigDuration = () => {
    const s = stig();
    if (!s || s.waypoints.length === 0) return null;
    if (s.finishTime) return s.finishTime;
    const gameStart = $gameStartTime.get() || s.waypoints[0].startTime;
    return s.waypoints[s.waypoints.length - 1].arrivalTime - gameStart;
  };

  createEffect(() => {
    getTravelSummary(props.player, $gameBounds.get(), stealthMode(), stigDuration() || undefined)
      .then(summary => setTravelSummary(summary));
  });

  const copyToClipboard = () => {
    navigator.clipboard.writeText(travelSummary());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div onClick={props.onClose} style={s.overlay}>
      <div onClick={(e) => e.stopPropagation()} style={s.modal}>
        <div style={{ 'text-align': 'center' }}>
          <div style={{ 'font-size': '2rem', 'margin-bottom': '8px' }}>🎉</div>
          <div style={{ 'font-size': '1.5rem', 'font-weight': 'bold', 'color': colours.textDark }}>Mission complete!</div>
          <div style={{ 'color': colours.textMuted }}>You have reached your destination.</div>
        </div>

        <div style={s.tabContainer}>
          <button onClick={() => setActiveTab('summary')} style={s.tabBtn(activeTab() === 'summary')}>Summary</button>
          <button onClick={() => setActiveTab('stats')} style={s.tabBtn(activeTab() === 'stats')}>Stats</button>
        </div>

        {activeTab() === 'summary' && (
          <div style={s.contentBox}>{travelSummary()}</div>
        )}

        {activeTab() === 'stats' && (
          <StatsTab stats={statsValue} />
        )}

        <div style={s.row}>
          <button onClick={props.onSpectate} style={{ ...btnBase, background: colours.white, color: colours.textDark, border: `1px solid ${colours.border}` }}>Spectate 🔭</button>
          <button onClick={() => setStealthMode(!stealthMode())} style={{ ...btnBase, background: stealthMode() ? colours.success : colours.grey, color: colours.white, border: 'none', transition: 'background 0.2s' }}>{!stealthMode() ? 'Stealth 🥷' : 'Nerd 🤓'}</button>
          <button onClick={copyToClipboard} style={{ ...btnBase, background: copied() ? colours.success : colours.primary, color: colours.white, border: 'none', transition: 'background 0.2s' }}>{copied() ? 'Copied! ✓' : 'Copy results 📋'}</button>
        </div>
        {props.onRaceAgain && (
        <div style={s.row}>
          <button onClick={props.onRaceAgain} style={{ ...btnBase, background: colours.success, color: colours.white, border: 'none', transition: 'background 0.2s' }}>Race again! 👻</button>
        </div>
        )}
      </div>
    </div>
  );
};

function computeBreakdownData(byCountry: Record<string, any>, countries: string[], transports: string[]) {
  let filteredByCountry: Record<string, any> = {};
  if (countries.length > 0) {
    for (const c of countries) {
      if (byCountry[c]) filteredByCountry[c] = byCountry[c];
    }
  } else {
    filteredByCountry = byCountry;
  }

  const aggregateByTransport = (cs: any, trans: string[]) => {
    let timeMs = 0;
    let distanceKm = 0;
    for (const t of trans) {
      timeMs += cs.transportTimeMs[t] ?? 0;
      distanceKm += cs.transportDistanceKm[t] ?? 0;
    }
    return { timeMs, distanceKm, isWait: timeMs > 0 && distanceKm === 0 };
  };

  let breakdown: Record<string, { timeMs: number; distanceKm: number; isWait: boolean }>;
  let type: 'country' | 'transport';

  if (countries.length > 0) {
    breakdown = {};
    for (const cs of Object.values(filteredByCountry)) {
      const transToUse = transports.length > 0 ? transports : Object.keys(cs.transportTimeMs);
      for (const t of transToUse) {
        if (!breakdown[t]) breakdown[t] = { timeMs: 0, distanceKm: 0, isWait: false };
        breakdown[t].timeMs += cs.transportTimeMs[t] ?? 0;
        breakdown[t].distanceKm += cs.transportDistanceKm[t] ?? 0;
      }
    }
    for (const t of Object.keys(breakdown)) {
      breakdown[t].isWait = breakdown[t].timeMs > 0 && breakdown[t].distanceKm === 0;
    }
    type = 'transport';
  } else {
    breakdown = {};
    for (const [c, cs] of Object.entries(filteredByCountry)) {
      const transToUse = transports.length > 0 ? transports : Object.keys(cs.transportTimeMs);
      breakdown[c] = aggregateByTransport(cs, transToUse);
    }
    type = 'country';
  }

  const filtered = Object.entries(breakdown)
    .filter(([_, d]) => d.distanceKm > 0 || d.isWait)
    .sort((a, b) => b[1].timeMs - a[1].timeMs);

  return { breakdown: Object.fromEntries(filtered), type };
}

const StatsTab = (props: { stats: ReturnType<typeof $playerStats.get> }) => {
  const [selectedCountries, setSelectedCountries] = createSignal<string[]>([]);
  const [selectedTransports, setSelectedTransports] = createSignal<string[]>([]);

  const allCountries = () => Object.keys(props.stats.byCountry);
  const allTransports = () => {
    const transports = new Set<string>();
    for (const cs of Object.values(props.stats.byCountry)) {
      for (const t of Object.keys(cs.transportCount)) {
        if (t !== '❓') transports.add(t);
      }
    }
    return Array.from(transports).sort();
  };

  const toggleSelection = <T,>(item: T, current: T[], setter: (v: T[]) => void) => {
    if (current.includes(item)) setter(current.filter(x => x !== item));
    else setter([...current, item]);
  };

  const breakdownData = createMemo(() => computeBreakdownData(props.stats.byCountry, selectedCountries(), selectedTransports()));

  const totals = createMemo(() => {
    const data = breakdownData();
    let totalTimeMs = 0;
    let totalDistanceKm = 0;
    for (const d of Object.values(data.breakdown)) {
      totalTimeMs += d.timeMs;
      totalDistanceKm += d.distanceKm;
    }
    return { totalTimeMs, totalDistanceKm, avgSpeed: totalTimeMs > 0 ? (totalDistanceKm / (totalTimeMs / 3600000)) : 0 };
  });

  const showByCountry = () => breakdownData().type === 'country';

  const filterBtnStyle = (isSelected: boolean, isLarge: boolean = false) => ({
    padding: '2px 6px', 'font-size': isLarge ? '1.1em' : '1em',
    background: isSelected ? colours.primary : colours.white,
    border: `1px solid ${colours.border}`, 'border-radius': '4px', cursor: 'pointer'
  });

  return (
    <>
      <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '4px', 'margin-bottom': '8px' }}>
        {allCountries().map(c => (
          <button
            onClick={() => toggleSelection(c, selectedCountries(), setSelectedCountries)}
            style={filterBtnStyle(selectedCountries().includes(c), true)}
          >
            {countryToFlag(c)}
          </button>
        ))}
        {allTransports().map(t => (
          <button
            onClick={() => toggleSelection(t, selectedTransports(), setSelectedTransports)}
            style={filterBtnStyle(selectedTransports().includes(t))}
          >
            {t}
          </button>
        ))}
      </div>

      <div style={s.statsBox}>
        <div style={{ 'margin-bottom': '12px' }}>
          <div><strong>Days played:</strong> {props.stats.daysPlayed}</div>
          <div><strong>Races started:</strong> {props.stats.racesStarted}</div>
          <div><strong>Races finished:</strong> {props.stats.racesFinished}</div>
        </div>

        {Object.keys(breakdownData().breakdown).length > 0 && (
          <div>
            <table style={{ width: '100%', 'border-collapse': 'collapse', 'margin-top': '4px' }}>
              <thead>
                <tr>
                  <th style={{ width: '10%', 'text-align': 'left' }}>{showByCountry() ? 'Country' : 'Type'}</th>
                  <th style={{ width: '30%', 'text-align': 'right' }}>Time</th>
                  <th style={{ width: '30%', 'text-align': 'right' }}>Distance</th>
                  <th style={{ width: '30%', 'text-align': 'right' }}>Average km/h</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(breakdownData().breakdown).map(([key, data]) => (
                  <tr>
                    <td>{showByCountry() ? countryToFlag(key) : key}</td>
                    <td style={{ 'text-align': 'right' }}>{formatDuration(data.timeMs)}</td>
                    <td style={{ 'text-align': 'right' }}>{sensibleNumber(data.distanceKm)} km</td>
                    <td style={{ 'text-align': 'right' }}>{sensibleNumber(data.timeMs > 0 ? (data.distanceKm / (data.timeMs / 3600000)) : 0)}</td>
                  </tr>
                ))}
                <tr style={{ 'font-weight': 'bold', 'border-top': `2px solid ${colours.border}` }}>
                  <td>Total</td>
                  <td style={{ 'text-align': 'right' }}>{formatDuration(totals().totalTimeMs)}</td>
                  <td style={{ 'text-align': 'right' }}>{sensibleNumber(totals().totalDistanceKm)} km</td>
                  <td style={{ 'text-align': 'right' }}>{sensibleNumber(totals().avgSpeed)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
};

export default WinModal;
