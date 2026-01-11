import { useStore } from '@nanostores/solid';
import { $departureBoardResults, submitWaypointsBatch, $clock, $stopTimeZone } from './store';
import { Show, For } from 'solid-js';
import { chQuery } from './clickhouse';
import { formatInTimeZone } from './timezone';

export default function DepartureBoard() {
    const results = useStore($departureBoardResults);
    const currentTime = useStore($clock);

    const stopZone = useStore($stopTimeZone);

    const deduplicatedResults = () => {
        const raw = results();
        if (!raw) return [];

        const now = currentTime();
        const zone = stopZone();
        const seen = new Set<string>();

        // Convert current simulation time to local STOP wall-time
        const localDateStr = new Date(now).toLocaleString('en-GB', { timeZone: zone });
        const localDate = new Date(localDateStr);
        const localSeconds = localDate.getHours() * 3600 + localDate.getMinutes() * 60 + localDate.getSeconds();

        return raw.filter(row => {
            // 1. Filter out past departures (Local time of day only)
            const depDate = new Date(row.departure_time);
            const depSeconds = depDate.getHours() * 3600 + depDate.getMinutes() * 60 + depDate.getSeconds();

            if (depSeconds < localSeconds) return false;

            // 2. Deduplicate
            const key = `${row.departure_time}|${row.route_short_name}|${row.trip_headsign}|${row.stop_name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    };

    const close = () => $departureBoardResults.set([]);

    const handleTripClick = (row: any) => {
        console.log(`[DepartureBoard] Trip Clicked: ${row.trip_id} | Route: ${row.route_long_name}`);

        // Query ClickHouse for all stops of this trip starting from this departure
        const query = `
      SELECT *
      FROM transitous_everything_stop_times_one_day_even_saner
      WHERE "ru.source" = '${row['ru.source']}'
        AND "ru.trip_id" = '${row['ru.trip_id']}'
        AND sane_route_id = '${row.sane_route_id}'
        AND departure_time >= '${row.departure_time}'
      ORDER BY departure_time ASC
      LIMIT 100
    `;

        chQuery(query)
            .then(res => console.log(`[ClickHouse] Trip Stops for ${row.trip_id}:`, res))
            .catch(err => console.error(`[ClickHouse] Trip Stops query failed:`, err));
    };

    const handleTripDoubleClick = (row: any) => {
        console.log(`[DepartureBoard] Trip Double-Clicked! Following: ${row.trip_headsign}`);

        // Fetch same data as single click but process it as points
        const query = `
      SELECT stop_lat, stop_lon, arrival_time, departure_time
      FROM transitous_everything_stop_times_one_day_even_saner
      WHERE "ru.source" = '${row['ru.source']}'
        AND "ru.trip_id" = '${row['ru.trip_id']}'
        AND sane_route_id = '${row.sane_route_id}'
        AND departure_time >= '${row.departure_time}'
      ORDER BY departure_time ASC
      LIMIT 100
    `;

        chQuery(query)
            .then(res => {
                if (res && res.data && res.data.length > 0) {
                    const points = res.data.map((r: any, idx: number) => ({
                        lng: r.stop_lon,
                        lat: r.stop_lat,
                        // Use departure_time for the first stop, arrival_time for subsequent ones
                        time: new Date(idx === 0 ? r.departure_time : r.arrival_time).getTime()
                    }));
                    submitWaypointsBatch(points);
                    console.log(`[DepartureBoard] Batch submitted: ${points.length} waypoints.`);
                    close(); // Auto-close on successful follow
                }
            })
            .catch(err => console.error(`[ClickHouse] Trip batch query failed:`, err));
    };

    const formatTime = (time: string | number, showSeconds = false) => {
        if (!time) return '--:--';
        const date = new Date(time);
        if (isNaN(date.getTime())) return '--:--';
        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: showSeconds ? '2-digit' : undefined
        });
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
                        <div class="header-title">Departures</div>
                        <div class="header-clock">
                            <span class="local-time">{formatInTimeZone(currentTime(), stopZone(), true)}</span>
                            <span class="timezone-label">{stopZone().split('/').pop()?.replace('_', ' ')}</span>
                        </div>
                        <button class="close-button" onClick={close}>Close</button>
                    </div>
                    <div class="board-table">
                        <div class="table-head">
                            <div class="col-status"></div>
                            <div class="col-time">Time</div>
                            <div class="col-route">Line</div>
                            <div class="col-dest">Destination</div>
                            <div class="col-type">Type</div>
                        </div>
                        <div class="table-body">
                            <For each={deduplicatedResults()}>
                                {(row) => {
                                    const depDate = new Date(row.departure_time);
                                    const depSeconds = depDate.getHours() * 3600 + depDate.getMinutes() * 60 + depDate.getSeconds();

                                    const isImminent = () => {
                                        const now = currentTime();
                                        const zone = stopZone();
                                        const localDateStr = new Date(now).toLocaleString('en-US', { timeZone: zone });
                                        const localDate = new Date(localDateStr);
                                        const localSeconds = localDate.getHours() * 3600 + localDate.getMinutes() * 60 + localDate.getSeconds();
                                        const diff = depSeconds - localSeconds;
                                        return diff > 0 && diff <= 120;
                                    };

                                    return (
                                        <div
                                            class="table-row"
                                            style={{ cursor: 'pointer' }}
                                            onClick={() => handleTripClick(row)}
                                            onDblClick={() => handleTripDoubleClick(row)}
                                        >
                                            <div class="col-status">
                                                <Show when={isImminent()}>
                                                    <span class="status-dot imminent"></span>
                                                </Show>
                                            </div>
                                            <div class="col-time">
                                                {formatTime(row.departure_time)}
                                            </div>
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
                                    );
                                }}
                            </For>
                        </div>
                    </div>
                </div>
            </div>

            <style>{`
        /* Imminent Departure Indicator */
        .status-dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          margin-right: 8px;
          vertical-align: middle;
        }

        .status-dot.imminent {
          background-color: #ff9800; /* Orange */
          box-shadow: 0 0 8px #e0b0ff; /* Mauve glow */
          animation: pulse-orange-mauve 1.5s infinite;
        }

        @keyframes pulse-orange-mauve {
          0% { box-shadow: 0 0 0 0 rgba(255, 152, 0, 0.7), 0 0 0 0 rgba(224, 176, 255, 0.4); }
          70% { box-shadow: 0 0 0 10px rgba(255, 152, 0, 0), 0 0 15px 10px rgba(224, 176, 255, 0); }
          100% { box-shadow: 0 0 0 0 rgba(255, 152, 0, 0), 0 0 0 0 rgba(224, 176, 255, 0); }
        }

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
          width: 200px;
        }

        .header-clock {
          flex: 1;
          text-align: center;
          font-family: 'Courier New', Courier, monospace;
          font-weight: bold;
          font-size: 1.2rem;
          display: flex;
          flex-direction: column;
          align-items: center;
          line-height: 1.1;
        }

        .timezone-label {
          font-size: 0.7rem;
          opacity: 0.8;
          text-transform: uppercase;
          letter-spacing: 1px;
        }

        .close-button {
          background: transparent;
          border: none;
          color: #fff;
          font-size: 2rem;
          cursor: pointer;
          line-height: 1;
          width: 200px;
          text-align: right;
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

        .col-status { width: 30px; display: flex; align-items: center; justify-content: center; }
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
