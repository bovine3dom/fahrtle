import { useStore } from '@nanostores/solid';
import { $departureBoardResults } from './store';
import { Show, For } from 'solid-js';

export default function DepartureBoard() {
    const results = useStore($departureBoardResults);

    const deduplicatedResults = () => {
        const raw = results();
        if (!raw) return [];

        const seen = new Set<string>();
        return raw.filter(row => {
            // Create a unique key for this departure
            const key = `${row.departure_time}|${row.route_short_name}|${row.trip_headsign}|${row.stop_name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    };

    const close = () => $departureBoardResults.set(null);

    const formatTime = (dateTimeStr: string) => {
        if (!dateTimeStr) return '--:--';
        const date = new Date(dateTimeStr);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const getRouteEmoji = (type: number) => {
        // Extended GTFS
        if (type >= 100 && type <= 117) return '🚆'; // Rail
        if (type >= 200 && type <= 209) return '🚍'; // Coach
        if (type >= 400 && type <= 405) return '🚇'; // Subway/Metro
        if (type >= 700 && type <= 716) return '🚌'; // Bus
        if (type === 800) return '🚎';               // Trolleybus
        if (type >= 900 && type <= 906) return '🚋'; // Tram
        if (type === 1000 || type === 1200) return '⛴️'; // Ferry
        if (type === 1100) return '✈️';               // Air
        if (type >= 1300 && type <= 1307) return '🚠'; // Aerial Lift
        if (type === 1400) return '🚠';               // Funicular
        if (type >= 1500 && type <= 1507) return '🚕'; // Taxi
        if (type >= 1700) return '🐎';                // Misc

        // Standard GTFS
        switch (type) {
            case 0: return '🚋'; // Tram
            case 1: return '🚇'; // Subway
            case 2: return '🚆'; // Rail
            case 3: return '🚌'; // Bus
            case 4: return '⛴️'; // Ferry
            case 5: return '🚋'; // Cable Tram
            case 6: return '🚠'; // Aerial Lift
            case 7: return '🚠'; // Funicular
            case 11: return '🚎'; // Trolleybus
            case 12: return '🚝'; // Monorail
            default: return '🔘';
        }
    };

    return (
        <Show when={results() && results()!.length > 0}>
            <div class="departure-board-overlay" onClick={close}>
                <div class="departure-board" onClick={(e) => e.stopPropagation()}>
                    <div class="board-header">
                        <span class="header-title">Departures</span>
                        <button class="close-button" onClick={close}>×</button>
                    </div>
                    <div class="board-table">
                        <div class="table-head">
                            <div class="col-time">Time</div>
                            <div class="col-route">Line</div>
                            <div class="col-dest">Destination</div>
                            <div class="col-type">Type</div>
                        </div>
                        <div class="table-body">
                            <For each={deduplicatedResults()}>
                                {(row) => (
                                    <div class="table-row">
                                        <div class="col-time">{formatTime(row.departure_time)}</div>
                                        <div class="col-route">
                                            <span
                                                class="route-pill"
                                                style={{
                                                    "background-color": row.route_color ? `#${row.route_color}` : '#333',
                                                    "color": row.route_text_color ? `#${row.route_text_color}` : '#fff'
                                                }}
                                            >
                                                {row.route_short_name || '??'}
                                            </span>
                                        </div>
                                        <div class="col-dest">
                                            <div class="dest-main">{row.trip_headsign || row.stop_name}</div>
                                            <div class="route-long">{row.route_long_name}</div>
                                        </div>
                                        <div class="col-type">{getRouteEmoji(row.route_type)}</div>
                                    </div>
                                )}
                            </For>
                        </div>
                    </div>
                </div>
            </div>

            <style>{`
        .departure-board-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          backdrop-filter: blur(2px);
        }

        .departure-board {
          background: #002b5c; /* Deep European Blue */
          color: #fff;
          width: 90%;
          max-width: 800px;
          border-radius: 8px;
          border: 4px solid #001a35;
          box-shadow: 0 20px 50px rgba(0,0,0,0.5);
          font-family: 'Inter', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          overflow: hidden;
          animation: slideIn 0.3s ease-out;
        }

        @keyframes slideIn {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }

        .board-header {
          background: #001a35;
          padding: 12px 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 2px solid #004080;
        }

        .header-title {
          font-size: 1.2rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: #ffcc00; /* Contrast yellow */
        }

        .close-button {
          background: transparent;
          border: none;
          color: #fff;
          font-size: 2rem;
          cursor: pointer;
          line-height: 1;
        }

        .board-table {
          width: 100%;
          padding: 0;
        }

        .table-head {
          display: flex;
          background: #003a7a;
          padding: 10px 20px;
          font-weight: 700;
          text-transform: uppercase;
          font-size: 0.85rem;
          color: #a0c4ff;
          border-bottom: 1px solid #004a99;
        }

        .table-body {
          max-height: 60vh;
          overflow-y: auto;
        }

        .table-row {
          display: flex;
          align-items: center;
          padding: 12px 20px;
          border-bottom: 1px solid #003a7a;
          transition: background 0.2s;
        }

        .table-row:hover {
          background: #003a7a;
        }

        .col-time { width: 80px; }
        .col-route { width: 100px; }
        .col-dest { flex: 1; }
        .col-type { width: 60px; text-align: center; }

        .table-body .col-time { 
          font-weight: 700; 
          color: #ffeb3b; 
          font-size: 1.1rem; 
        }

        .table-body .col-type {
          font-size: 1.5rem;
        }

        .route-pill {
          padding: 4px 10px;
          border-radius: 4px;
          font-weight: 800;
          font-size: 0.9rem;
          display: inline-block;
          min-width: 50px;
          text-align: center;
          box-shadow: inset 0 0 4px rgba(0,0,0,0.3);
        }

        .dest-main {
          font-weight: 700;
          font-size: 1.1rem;
          color: #fff;
        }

        .route-long {
          font-size: 0.8rem;
          color: #a0c4ff;
          margin-top: 2px;
        }

        /* Customize Scrollbar */
        .table-body::-webkit-scrollbar {
          width: 8px;
        }
        .table-body::-webkit-scrollbar-track {
          background: #001a35;
        }
        .table-body::-webkit-scrollbar-thumb {
          background: #004a99;
          border-radius: 4px;
        }
      `}</style>
        </Show>
    );
}
