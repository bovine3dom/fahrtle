import { useStore } from '@nanostores/solid';
import { $departureBoardResults, submitWaypointsBatch, $clock, $stopTimeZone, $previewRoute, clearPreviewRoute, $boardMinimized } from './store';
import { Show, For, createEffect, createSignal } from 'solid-js';
import { chQuery } from './clickhouse';
import { formatInTimeZone, getTimeZoneColor } from './timezone';
import { getRouteEmoji } from './getRouteEmoji';

export default function DepartureBoard() {
  const results = useStore($departureBoardResults);
  const currentTime = useStore($clock);

  const stopZone = useStore($stopTimeZone);
  const isMinimized = useStore($boardMinimized);
  const [filterType, setFilterType] = createSignal<string | null>(null);

  // Auto-unminimize when results are lost (empty) or closed
  createEffect(() => {
    if (!results() || results()!.length === 0) {
      $boardMinimized.set(false);
    }
  });

  // Auto-expand when results appear
  createEffect(() => {
    if (results() && results()!.length > 0) {
      $boardMinimized.set(false);
    }
  });

  const deduplicatedResults = () => {
    const raw = results();
    if (!raw) return [];

    const now = currentTime();
    const zone = stopZone();

    // Convert current simulation time to local STOP wall-time
    const localDateStr = new Date(now).toLocaleString('en-US', { timeZone: zone });
    const localDate = new Date(localDateStr);
    const localSeconds = localDate.getHours() * 3600 + localDate.getMinutes() * 60 + localDate.getSeconds();

    return raw.map(row => {
      const depDate = new Date(row.departure_time);
      const depSeconds = depDate.getHours() * 3600 + depDate.getMinutes() * 60 + depDate.getSeconds();
      const isTomorrow = depSeconds < localSeconds;
      return { ...row, isTomorrow };
    });
  };

  // Clear preview whenever the displayed results change (e.g. closing board, new station)
  createEffect(() => {
    results(); // Track dependency
    clearPreviewRoute();
  });

  const close = () => {
    $departureBoardResults.set([]);
    $boardMinimized.set(false);
    setFilterType(null);
  };

  const handlePreviewClick = (row: any) => {
    console.log(`[DepartureBoard] Preview Clicked: ${row.trip_headsign}`);

    // Query ClickHouse for all stops of this trip starting from THIS departure
    const query = `
          SELECT stop_lat, stop_lon
          FROM transitous_everything_stop_times_one_day_even_saner
          WHERE "ru.source" = '${row['source']}'
            AND "ru.trip_id" = '${row['trip_id']}'
            AND sane_route_id = '${row.sane_route_id}'
            AND departure_time >= '${row.departure_time}'
          ORDER BY departure_time ASC
          LIMIT 100
        `;

    chQuery(query)
      .then(res => {
        if (res && res.data && res.data.length > 0) {
          const coords = res.data.map((r: any) => [r.stop_lon, r.stop_lat]);
          $previewRoute.set({
            id: row['ru.trip_id'],
            color: row.route_color ? `#${row.route_color}` : '#333',
            coordinates: coords as [number, number][]
          });
          console.log($previewRoute.get());
          // Auto-minimize when previewing
          $boardMinimized.set(true);
        }
      })
      .catch(err => console.error(`[ClickHouse] Preview query failed:`, err));
  };

  const handleTripClick = (row: any) => {
    console.log(`[DepartureBoard] Trip Clicked: ${row.trip_id} | Route: ${row.route_long_name}`);
    // (Existing single-click logic just logs for now)
  };

  const handleTripDoubleClick = (row: any) => {
    console.log(`[DepartureBoard] Trip Double-Clicked! Following: ${row.trip_headsign}`);

    // Fetch same data as single click but process it as points
    const query = `
      SELECT stop_name, stop_lat, stop_lon, arrival_time, departure_time
      FROM transitous_everything_stop_times_one_day_even_saner
      WHERE "ru.source" = '${row['source']}'
        AND "ru.trip_id" = '${row['trip_id']}'
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
            time: new Date(idx === 0 ? r.departure_time : r.arrival_time).getTime(),
            stopName: r.stop_name
          }));
          submitWaypointsBatch(points);
          console.log(`[DepartureBoard] Batch submitted: ${points.length} waypoints.`);
          close(); // Auto-close on successful follow
        }
      })
      .catch(err => console.error(`[ClickHouse] Trip batch query failed:`, err));
  };

  const formatClockTime = (time: string | number, showSeconds = false) => {
    if (!time) return '--:--';
    const date = new Date(time);
    const timestamp = date.getTime();
    if (isNaN(timestamp)) return '--:--';
    try {
      return formatInTimeZone(timestamp, stopZone() || 'UTC', showSeconds);
    } catch (e) {
      return date.toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: showSeconds ? '2-digit' : undefined
      });
    }
  };

  const formatRowTime = (timeStr: string) => {
    if (!timeStr) return '--:--';
    // The DB returns local "wall time" string e.g. "2023-10-10 14:00:00"
    // We just want to extract "14:00" without any timezone logic
    try {
      // Check if it matches YYYY-MM-DD HH:mm:ss format roughly
      if (timeStr.length >= 16) {
        return timeStr.substring(11, 16);
      }
      // Fallback
      const d = new Date(timeStr);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (e) {
      return '--:--';
    }
  };

  return (
    <Show when={results() && results()!.length > 0}>
      <div
        class="departure-board-overlay"
        classList={{ minimized: isMinimized() }}
        onClick={close}
      >
        <div
          class="departure-board"
          classList={{ minimized: isMinimized() }}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="board-header">
            <div class="header-main">
              <h1>Departures</h1>
              <div class="stop-name" style={{ color: '#ffed02', "font-weight": "900", }}>
                {deduplicatedResults()[0]?.stop_name || 'Railway Station'}
              </div>
            </div>
            <div class="header-controls">
              <button
                class="control-btn minimize-btn"
                onClick={() => $boardMinimized.set(!isMinimized())}
                title={isMinimized() ? "Expand" : "Minimize"}
              >
                <span class="cross-line" style={{ transform: isMinimized() ? 'rotate(90deg)' : 'none' }}></span>
                <span class="cross-line"></span>
              </button>
              <button class="control-btn close-btn" onClick={close} title="Close Board">✕</button>
            </div>
            <div class="header-clock" style={{ background: getTimeZoneColor(stopZone()) }}>
              <div class="clock-time">{formatClockTime(currentTime(), true)}</div>
              <div class="clock-zone">{stopZone()}</div>
            </div>
          </div>

          {/* Type Filter Toolbar */}
          <div style={{ padding: '0 20px', 'background': '#003a79', display: 'flex', gap: '8px', 'overflow-x': 'auto', 'padding-bottom': '8px' }}>
            <For each={[...new Set(deduplicatedResults().map(r => getRouteEmoji(r.route_type)))]}>
              {(emoji) => (
                <button
                  onClick={() => setFilterType(filterType() === emoji ? null : emoji)}
                  style={{
                    background: filterType() === emoji ? '#ffed02' : 'rgba(255,255,255,0.1)',
                    color: filterType() === emoji ? '#000' : '#fff',
                    border: '1px solid rgba(255,255,255,0.2)',
                    'border-radius': '4px',
                    padding: '4px 8px',
                    cursor: 'pointer',
                    'font-size': '1.2em'
                  }}
                  title={filterType() === emoji ? 'Clear Filter' : `Filter by ${emoji}`}
                >
                  {emoji}
                </button>
              )}
            </For>
          </div>

          <div class="table-container">
            <div class="table-head">
              <div class="col-status"></div>
              <div class="col-time">Time</div>
              <div class="col-route">Line</div>
              <div class="col-dest">Destination</div>
              <div class="col-dir">Dir</div> {/* New Header */}
              <div class="col-type">Type</div>
              <div class="col-preview"></div>
            </div>
            <div class="table-body">
              <For each={deduplicatedResults().filter(r => !filterType() || getRouteEmoji(r.route_type) === filterType())}>
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
                      <div class="col-time" style={{ "line-height": "1.1" }}>
                        <div>{formatRowTime(row.departure_time)}</div>
                        <Show when={row.isTomorrow}>
                          <div style={{ "font-size": "0.65em", "color": "#ffed02", "opacity": "0.8" }}>
                            (tmrw.)
                          </div>
                        </Show>
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

                      <div class="col-dir">
                        <svg
                          class="dir-icon"
                          viewBox="0 0 24 24"
                          style={{
                            transform: `rotate(${row.bearing || 0}deg)`
                          }}
                        >
                          <path d="M12 2L4.5 20.29C4.24 20.93 4.97 21.5 5.56 21.14L12 17.27L18.44 21.14C19.03 21.5 19.76 20.93 19.5 20.29L12 2Z" />
                        </svg>
                      </div>

                      <div class="col-type">{getRouteEmoji(row.route_type)}</div>
                      <div class="col-preview">
                        <button
                          class="preview-btn"
                          onClick={(e) => { e.stopPropagation(); handlePreviewClick(row); }}
                          title="Preview Trip Route"
                        >
                          🔍
                        </button>
                      </div>
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
          transition: all 0.4s ease;
        }

        .departure-board-overlay.minimized {
          background: transparent;
          backdrop-filter: none;
          pointer-events: none;
        }

        .departure-board {
          background: #0064ab; /* Official SNCF Blue */
          width: 90vw;
          max-width: 1000px;
          height: 80vh;
          border-radius: 12px;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          box-shadow: 0 30px 60px rgba(0,0,0,0.5);
          border: 4px solid #003a79;
          position: relative;
          transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
          font-family: 'Avenir', 'Inter', -apple-system, sans-serif;
          pointer-events: auto;
          animation: slideIn 0.3s ease-out;
        }

        .departure-board.minimized {
          height: 64px;
          width: 500px;
          position: absolute;
          bottom: 20px;
          left: 20px;
          border-radius: 8px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
          border: 2px solid #003a79;
        }

        @keyframes slideIn {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }

        .board-header {
          padding: 24px 32px;
          background: #0064ab;
          border-bottom: 2px solid #003a79;
          display: flex;
          align-items: center;
          position: relative;
          min-height: 120px;
          flex-shrink: 0;
          transition: all 0.4s ease;
        }

        .departure-board.minimized .board-header {
          padding: 12px 20px;
          height: 100%;
          border-bottom: none;
        }

        .header-main h1 {
          margin: 0;
          font-size: 14px;
          text-transform: uppercase;
          letter-spacing: 2px;
          color: rgba(255,255,255,0.6);
          transition: all 0.3s ease;
        }

        .departure-board.minimized .header-main h1 {
          display: none;
        }

        .departure-board.minimized .header-clock {
          display: none;
        }

        .stop-name {
          font-size: 32px;
          font-weight: 800;
          margin: 0;
          color: #fff;
        }

        .departure-board.minimized .stop-name {
          font-size: 1rem;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: #ffed02;
        }

        .departure-board.minimized .board-header {
          padding: 0;
          min-height: 0;
        }

        .header-controls {
          display: flex;
          gap: 8px;
          position: absolute;
          top: 24px;
          right: 32px;
          align-items: center;
          z-index: 10;
        }

        .departure-board.minimized .header-controls {
          top: 50%;
          transform: translateY(-50%);
          right: 12px;
        }

        .control-btn {
          background: rgba(255, 255, 255, 0.15);
          border: 1px solid rgba(255, 255, 255, 0.2);
          color: #fff;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          cursor: pointer;
          font-size: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s ease;
          position: relative;
        }

        .cross-line {
          position: absolute;
          width: 14px;
          height: 2px;
          background: #fff;
          transition: transform 0.3s ease;
        }

        .control-btn:hover {
          background: rgba(255, 255, 255, 0.2);
          transform: scale(1.1);
        }

        .close-btn {
          font-weight: bold;
        }

        .header-clock {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          padding: 8px 20px;
          border-radius: 8px;
          color: #fff;
          text-align: center;
          border: 1px solid rgba(255,255,255,0.2);
          display: flex;
          flex-direction: column;
          align-items: center;
          transition: background 1.5s ease;
        }

        .departure-board.minimized .header-clock {
          position: absolute;
          right: 96px;
          left: auto;
          top: 50%;
          transform: translateY(-50%);
          padding: 4px 12px;
          flex-direction: row;
          gap: 12px;
          border: none;
          border-radius: 4px;
        }

        .clock-time {
          font-family: 'Courier New', Courier, monospace;
          font-weight: bold;
          font-size: 1.8rem;
          line-height: 1;
        }

        .departure-board.minimized .clock-time {
          font-size: 1.2rem;
        }

        .clock-zone {
          font-size: 0.7rem;
          opacity: 0.8;
          text-transform: uppercase;
          letter-spacing: 1px;
        }

        .departure-board.minimized .clock-zone {
          display: none;
        }

        .board-table {
          width: 100%;
          padding: 0;
        }

        .table-container {
          flex: 1;
          overflow-y: auto;
          background: #0064ab;
          transition: all 0.4s ease;
        }

        .departure-board.minimized .table-container {
          opacity: 0;
          height: 0;
          pointer-events: none;
        }

        .table-head {
          display: flex;
          background: #003a79;
          padding: 12px 20px;
          border-bottom: 2px solid #0064ab;
        }

        .table-head > div {
          font-weight: 800;
          text-transform: uppercase;
          font-size: 0.9rem;
          color: rgba(255,255,255,0.7);
          letter-spacing: 0.1em;
          display: flex;
          align-items: center;
        }

        .table-body {
          max-height: 60vh;
          overflow-y: auto;
        }

        .table-row {
          display: flex;
          align-items: center;
          padding: 16px 20px;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          transition: background 0.2s;
        }

        .table-row:nth-child(even) {
          background: #003a79;
        }

        .table-row:hover {
          background: rgba(255, 255, 255, 0.1) !important;
          box-shadow: inset 0 0 0 1px #fff;
        }

        .col-status { width: 30px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .col-time { 
          width: 120px; 
          flex-shrink: 0;
        }
        .table-body .col-time {
          color: #ffed02; /* SNCF Time Yellow */
          font-weight: 900;
          font-size: 2.2rem;
          letter-spacing: -0.02em;
        }
        .col-route { width: 100px; flex-shrink: 0; }
        .col-dest { 
          flex: 1; 
          color: #fff; 
          overflow: hidden; 
          white-space: nowrap;
          text-overflow: ellipsis;
          padding-right: 20px;
        }
        .table-body .col-dest {
          font-weight: 900; 
          font-size: 1.8rem; 
        }
          
        .col-dir {
          width: 50px;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .dir-icon {
          width: 24px;
          height: 24px;
          fill: rgba(255, 255, 255, 0.9);
          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
          transition: transform 0.2s ease;
        }

        .table-body .col-type { width: 80px; text-align: center; flex-shrink: 0; border: 1px solid #fff; border-radius: 4px; background: rgba(255,255,255,0.8); }
        .col-preview { width: 60px; text-align: right; flex-shrink: 0; }

        .preview-btn {
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          cursor: pointer;
          color: #fff;
          font-size: 14px;
          padding: 2px 6px;
          transition: all 0.2s ease;
        }

        .preview-btn:hover {
          background: rgba(255, 255, 255, 0.2);
          transform: scale(1.1);
        }

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
