import { For, Show, createSignal, createEffect } from 'solid-js';
import { colours } from './colours';
import { getRaceByIndex, TODAYS_DATE, BASE_DATE } from './utils/daily';
import { createClosestCity } from './utils/tiny-cities';

interface RaceCalendarProps {
  onSelect: (raceIndex: number) => void;
  onClose: () => void;
}

export function RaceCalendar(props: RaceCalendarProps) {
  const baseDate = new Date(BASE_DATE[0], BASE_DATE[1], BASE_DATE[2]);
  const diffTime = TODAYS_DATE.getTime() - baseDate.getTime();
  const totalDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
  const raceIndices = Array.from({ length: totalDays }, (_, i) => totalDays - 1 - i);

  const [races, setRaces] = createSignal<{ index: number; start: string; finish: string; date: Date }[]>([]);
  const [loading, setLoading] = createSignal(true);

  createEffect(async () => {
    const results = await Promise.all(
      raceIndices.map(async (idx) => {
        const race = await getRaceByIndex(idx);
        const sCity = createClosestCity(() => ({ lat: race.start[0], lon: race.start[1] }))();
        const fCity = createClosestCity(() => ({ lat: race.finish[0], lon: race.finish[1] }))();
        
        const raceDate = new Date(baseDate);
        raceDate.setDate(raceDate.getDate() + idx);
        
        return {
          index: idx,
          start: sCity || 'Unknown',
          finish: fCity || 'Unknown',
          date: raceDate
        };
      })
    );
    setRaces(results);
    setLoading(false);
  });

  const formatDate = (date: Date) => {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  return (
    <div style={{
      position: 'absolute',
      top: '100%',
      left: '0',
      'z-index': '100',
      background: 'rgb(30, 41, 59)',
      'backdrop-filter': 'none',
      'border-radius': '8px',
      padding: '12px',
      'box-shadow': '0 10px 25px rgba(0,0,0,0.3)',
      'margin-top': '8px',
      'width': '250px',
      'max-height': '250px',
      'overflow-y': 'auto',
      'scrollbar-width': 'thin',
      'scrollbar-color': `${colours.border} transparent`
    }}>
      <div style={{
        'font-size': '0.85rem',
        'font-weight': 'bold',
        'margin-bottom': '8px',
        'text-align': 'center'
      }}>
        Previous Races
      </div>
      
      <Show when={!loading()} fallback={
        <div style={{ 'text-align': 'center', 'font-size': '0.8rem', color: colours.border }}>
          Loading...
        </div>
      }>
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
          <For each={races()}>
            {(race) => (
              <button
                type="button"
                onClick={() => {
                  props.onSelect(race.index);
                  props.onClose();
                }}
                style={{
                  background: 'rgba(15, 23, 42, 0.4)',
                  border: 'none',
                  'border-radius': '6px',
                  padding: '8px',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  'text-align': 'left',
                  width: '100%'
                }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(15, 23, 42, 0.7)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(15, 23, 42, 0.4)'}
              >
                <div style={{
                  'font-size': '0.75rem',
                  color: colours.warningBright,
                  'margin-bottom': '2px'
                }}>
                  {formatDate(race.date)}
                </div>
                <div style={{
                  'font-size': '0.8rem',
                  color: 'white',
                  'white-space': 'nowrap',
                  overflow: 'hidden',
                  'text-overflow': 'ellipsis'
                }}>
                  {race.start} ➡️ {race.finish}
                </div>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
