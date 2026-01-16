import { useStore } from '@nanostores/solid';
import { $departureBoardResults, submitWaypointsBatch, $clock, $stopTimeZone, $previewRoute, $boardMinimized, $isFollowing } from './store';
import { Show, For, createEffect, createSignal, createMemo } from 'solid-js';
import { chQuery } from './clickhouse';
import { formatInTimeZone, getTimeZoneColor, getTimeZone, getTimeZoneLanguage, getDepartureLabel } from './timezone';
import { getRouteEmoji } from './getRouteEmoji';
import { parseDBTime, getWallSeconds } from './utils/time';
import { formatRowTime } from './utils/format';

export default function DepartureBoard() {
  const results = useStore($departureBoardResults);
  const currentTime = useStore($clock);

  const stopZone = useStore($stopTimeZone);
  const isMinimized = useStore($boardMinimized);
  const [filterType, setFilterType] = createSignal<string | null>(null);
  const [loadingTripKey, setLoadingTripKey] = createSignal<string | null>(null);

  createEffect(() => {
    if (!results() || results()!.length === 0) {
      $previewRoute.set([]);
      $boardMinimized.set(false);
    }
  });

  createEffect(() => {
    if (results() && results()!.length > 0) {
      $previewRoute.set([]);
      $boardMinimized.set(false);
    }
  });

  const getLocalSeconds = (time: number, zone: string) => {
    const localDateStr = new Date(time).toLocaleString('en-US', { timeZone: zone });
    const localDate = new Date(localDateStr);
    return localDate.getHours() * 3600 + localDate.getMinutes() * 60 + localDate.getSeconds();
  };

  const getRowSeconds = (departureTime: string) => {
    const depDate = new Date(departureTime);
    return depDate.getHours() * 3600 + depDate.getMinutes() * 60 + depDate.getSeconds();
  };

  const deduplicatedResults = createMemo(() => {
    const raw = results();
    if (!raw) return [];

    const now = currentTime();
    const zone = stopZone();
    const localSeconds = getLocalSeconds(now, zone);

    const filtered = []
    let seenNonTomorrow = false;
    for (const row of raw) {
      const depSeconds = getRowSeconds(row.departure_time);
      const isRowTomorrow = depSeconds < localSeconds;
      if (isRowTomorrow) {
        if (seenNonTomorrow) {
          filtered.push(row);
        }
      } else {
        seenNonTomorrow = true;
        filtered.push(row);
      }
    }
    return filtered.length > 0 ? filtered : raw; // tiny bug here: if all results are tomorrow, order is wrong
  }, [], {
    equals: (a, b) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }
  });

  const displayResults = createMemo(() => {
    const rows = deduplicatedResults();
    const filter = filterType();
    if (!filter) return rows;
    return rows.filter(r => getRouteEmoji(r.route_type) === filter);
  });

  const close = () => {
    $departureBoardResults.set([]);
    $previewRoute.set([]);
    $boardMinimized.set(false);
    setFilterType(null);
  };

  const handlePreviewClick = (row: any) => {
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
          $previewRoute.set(coords as [number, number][]);
        }
      })
      .catch(err => console.error(`[ClickHouse] Preview query failed:`, err));
  };

  const handleTripDoubleClick = (row: any) => {
    const key = `${row.source}-${row.trip_id}-${row.departure_time}`;
    setLoadingTripKey(key);
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
          const rawPoints = res.data.map((r: any, idx: number) => {
            const thisStopZone = getTimeZone(r.stop_lat, r.stop_lon);
            const timeStr = idx === 0 ? r.departure_time : r.arrival_time;
            const absoluteTime = parseDBTime(timeStr, thisStopZone);
            return {
              // add small amount of randomness to avoid totally overlapping routes
              lng: r.stop_lon + Math.random() * 0.0001,
              lat: r.stop_lat + Math.random() * 0.0001,
              dbTime: absoluteTime,
              stopName: r.stop_name
            }
          });

          const startPt = rawPoints[0];
          const gameTime = $clock.get();

          const dbSeconds = getWallSeconds(startPt.dbTime, startPt.timeZone);
          const gameSeconds = getWallSeconds(gameTime, startPt.timeZone);

          let diff = dbSeconds - gameSeconds;

          const TOLERANCE = -60; // 1 minute leeway
          if (diff < TOLERANCE) {
            diff += 86400;
          }

          const targetStart = gameTime + (diff * 1000);
          const timeShift = targetStart - startPt.dbTime;
          const points = rawPoints.map((p: any, idx: number) => ({
            lng: p.lng,
            lat: p.lat,
            time: p.dbTime + timeShift,
            stopName: p.stopName,
            isWalk: idx === 0
          }));

          submitWaypointsBatch(points);
          $isFollowing.set(true);
          close();
        }
        setLoadingTripKey(null);
      })
      .catch(err => {
        console.error(`[ClickHouse] Trip batch query failed:`, err);
        setLoadingTripKey(null);
      });
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
              <h1>{getDepartureLabel(getTimeZoneLanguage(stopZone()))}</h1>
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
          <div class="type-filter-toolbar">
            <For each={[...new Set(deduplicatedResults().map(r => getRouteEmoji(r.route_type)))]}>
              {(emoji) => (
                <button
                  class="filter-btn"
                  classList={{ active: filterType() === emoji }}
                  onClick={() => setFilterType(filterType() === emoji ? null : emoji)}
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
              <div class="col-board"></div>
            </div>
            <div class="table-body">
              <For each={displayResults()}>
                {(row) => {
                  const isTomorrow = createMemo(() => {
                    const now = currentTime();
                    const zone = stopZone();
                    const localSeconds = getLocalSeconds(now, zone);
                    const depSeconds = getRowSeconds(row.departure_time);
                    return depSeconds < localSeconds;
                  });

                  const isImminent = createMemo(() => {
                    const depSeconds = getRowSeconds(row.departure_time);
                    const now = currentTime();
                    const zone = stopZone();
                    const localSeconds = getLocalSeconds(now, zone);
                    const diff = depSeconds - localSeconds;
                    return diff > 0 && diff <= 120;
                  });

                  return (
                    <div
                      class="table-row"
                      style={{ cursor: 'pointer' }}
                      onDblClick={() => handleTripDoubleClick(row)}
                    >
                      {/* Desktop Layout (visible on >768px) */}
                      <div class="desktop-row-content">
                        <div class="col-status">
                          <Show when={isImminent()}>
                            <span class="status-dot imminent"></span>
                          </Show>
                        </div>
                        <div class="col-time" style={{ "line-height": "1.1" }}>
                          <div>{formatRowTime(row.departure_time)}</div>
                          <Show when={isTomorrow()}>
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
                        <div class="col-board">
                          <button
                            class="preview-btn"
                            onClick={(e) => { e.stopPropagation(); handleTripDoubleClick(row); }}
                            title="Board"
                            disabled={loadingTripKey() !== null}
                          >
                            <Show when={loadingTripKey() === `${row.source}-${row.trip_id}-${row.departure_time}`} fallback={"🛂"}>
                              <span class="spinner-small"></span>
                            </Show>
                          </button>
                        </div>
                      </div>

                      {/* Mobile Layout (visible on <=768px) */}
                      <div class="mobile-row-content">
                        <div class="mobile-row-top">
                          <div class="mobile-time">
                            <div style={{ display: "flex", "align-items": "center" }}>
                              {formatRowTime(row.departure_time)}
                            </div>
                            <Show when={isImminent()}>
                              <span class="status-dot imminent" style={{ "margin-left": "4px" }}></span>
                            </Show>
                            <Show when={isTomorrow()}>
                              <div class="mobile-tomorrow">tomorrow</div>
                            </Show>
                          </div>
                          <div class="mobile-route-info">
                            <span class="mobile-emoji">{getRouteEmoji(row.route_type)}</span>
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
                          <div class="mobile-dest-arrow">→</div>
                          <div class="mobile-dest-name">{row.trip_headsign || row.stop_name}</div>
                        </div>
                        <div class="mobile-row-bottom">
                          <div class="mobile-secondary-info">
                            {row.route_long_name}
                          </div>
                          <div class="mobile-actions">

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
                            <button
                              class="preview-btn"
                              onClick={(e) => { e.stopPropagation(); handlePreviewClick(row); }}
                              title="Preview Trip Route"
                            >
                              🔍
                            </button>
                            <button
                              class="preview-btn"
                              onClick={(e) => { e.stopPropagation(); handleTripDoubleClick(row); }}
                              title="Board"
                              disabled={loadingTripKey() !== null}
                            >
                              <Show when={loadingTripKey() === `${row.source}-${row.trip_id}-${row.departure_time}`} fallback={"🛂"}>
                                <span class="spinner-small" style={{ "border-top-color": "#000" }}></span>
                              </Show>
                            </button>
                          </div>
                        </div>
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

        .spinner-small {
          display: inline-block;
          width: 14px;
          height: 14px;
          border: 2px solid rgba(255,255,255,0.3);
          border-radius: 50%;
          border-top-color: #fff;
          animation: spin 1s ease-in-out infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
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

        .type-filter-toolbar {
          padding: 8px 20px;
          background: #003a79;
          display: flex;
          gap: 8px;
          overflow-x: auto;
          flex-shrink: 0;
          scrollbar-width: none; /* Firefox */
        }

        .type-filter-toolbar::-webkit-scrollbar {
          display: none; /* Chrome/Safari */
        }

        .filter-btn {
          background: rgba(255, 255, 255, 0.1);
          color: #fff;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          padding: 4px 8px;
          cursor: pointer;
          font-size: 1.2em;
          transition: all 0.2s ease;
        }

        .filter-btn.active {
          background: #ffed02;
          color: #000;
        }

        .board-table {
          width: 100%;
          padding: 0;
        }

        .table-container {
          flex: 1;
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
          background: #003a79 !important;
        }

        .table-row:hover {
          background: rgba(255, 255, 255, 0.1) !important;
          box-shadow: inset 0 0 0 1px #fff;
        }

        .desktop-row-content {
          display: flex;
          align-items: center;
          width: 100%;
        }

        .col-status { width: 30px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .col-time { width: 120px; flex-shrink: 0; }
        .col-route { width: 100px; flex-shrink: 0; }
        .col-dest { 
          flex: 1; 
          color: #fff; 
          overflow: hidden; 
          white-space: nowrap;
          text-overflow: ellipsis;
          padding-right: 20px;
        }

        .table-body .col-time {
          color: #ffed02; /* SNCF Time Yellow */
          font-weight: 900;
          font-size: 2.2rem;
          letter-spacing: -0.02em;
        }

        .table-body .col-dest {
          font-weight: 900; 
          font-size: 1.8rem; 
        }

        .mobile-row-content {
          display: none;
          flex-direction: column;
          width: 100%;
          gap: 4px;
        }

        .table-body .col-type { width: 80px; text-align: center; flex-shrink: 0; border: 1px solid #fff; border-radius: 44px; background: rgba(255,255,255,0.8); }
        .col-preview { width: 60px; text-align: right; flex-shrink: 0; }

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

        .control-btn:hover {
          background: rgba(255, 255, 255, 0.2);
          transform: scale(1.1);
        }

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
       @media (max-width: 768px) {
            .departure-board-overlay {
              align-items: flex-end; /* Align to bottom like a sheet */
            }

            .status-dot {
              margin-top: 10px;
            }

            .type-filter-toolbar {
              background: #fff;
              padding-top: 8px;
              padding-bottom: 12px;
            }

            .filter-btn {
              background: #f0f0f0;
              color: #000;
              border: none;
              border-radius: 50%;
              width: 44px;
              height: 44px;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 0;
              font-size: 1.4rem;
              flex-shrink: 0;
            }

            .filter-btn.active {
              background: #ffed02;
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }

            .dir-icon {
              fill: #000;
              filter: none;
            }

            .departure-board {
              width: 100%;
              height: 90vh; /* Taller on mobile for better viewing */
              border-radius: 20px 20px 0 0; 
              border: none;
            }

            .board-header {
              flex-direction: column;
              align-items: flex-start;
              padding: 20px;
              height: auto;
              min-height: auto;
              gap: 12px;
              background: #c1121c; /* OEBB Red Header */
            }

            .header-main {
              width: 100%;
              padding-right: 60px;
            }

            .header-main h1 {
              font-size: 14px;
              color: rgba(255,255,255,0.9);
              font-weight: bold;
              text-transform: none;
              letter-spacing: normal;
            }

            .stop-name {
              font-size: 1rem;
              color: #fff !important;
              line-height: 1.2;
              white-space: normal;
            }

            .header-clock {
              position: relative;
              top: auto;
              left: auto;
              transform: none;
              width: 100%;
              background: rgba(0,0,0,0.1);
              border: none;
              padding: 8px 12px;
              flex-direction: row;
              justify-content: space-between;
              margin: 0;
            }

            .clock-time {
               font-size: 1.6rem;
            }

            .header-controls {
              top: 20px;
              right: 20px;
            }

            .table-head {
               display: none; /* Hide headers on mobile */
            }

            .table-row {
               padding: 16px;
               border-bottom: 1px solid #eee;
               background: #fff !important; /* White rows like Scotty */
               color: #333;
            }

            .table-row:nth-child(even) {
               background: #f9f9f9 !important;
            }

            .desktop-row-content {
              display: none;
            }

            .mobile-row-content {
              display: flex;
            }

            .mobile-row-top {
              display: flex;
              align-items: center;
              gap: 12px;
              font-size: 0.8rem;
            }

            .mobile-time {
              font-weight: 800;
              width: 55px;
              color: #000;
              display: flex;
              flex-direction: column;
              line-height: 1;
              justify-content: center;
            }

            .mobile-route-info {
              display: flex;
              align-items: center;
              gap: 4px;
            }

            .mobile-emoji {
              font-size: 1.2rem;
            }

            .mobile-dest-arrow {
              color: #888;
              font-weight: 300;
            }

            .mobile-dest-name {
              font-weight: 600;
              color: #000;
              flex: 1;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }

            .mobile-row-bottom {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-left: 67px; /* Align with dest name */
              margin-top: 2px;
            }

            .mobile-secondary-info {
              font-size: 0.8rem;
              color: #666;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
              flex: 1;
              padding-right: 10px;
            }

            .mobile-tomorrow {
              color: #c1121c;
              font-weight: bold;
              font-size: 0.6rem;
              margin-top: 2px;
            }

            .mobile-actions {
              display: flex;
              gap: 8px;
            }

            .table-container {
               background: #fff !important;
               display: flex;
               flex-direction: column;
               flex: 1;
               min-height: 0; /* Allow the container to shrink and scroll its contents */
               overflow: hidden;
            }

            .table-body {
               flex: 1;
               overflow-y: auto !important;
               -webkit-overflow-scrolling: touch;
               min-height: 0;
               max-height: none !important;
            }

            /* Mobile Scrollbar Style (White/Red) */
            .table-body::-webkit-scrollbar-track {
               background: #f0f0f0;
            }
            .table-body::-webkit-scrollbar-thumb {
               background: #c1121c; /* OEBB Red thumb */
               border-radius: 10px;
            }

            .route-pill {
              font-size: 0.6rem;
              padding: 2px 8px;
              border-radius: 4px;
              min-width: 25px;
              box-shadow: none;
            }

            .departure-board.minimized {
              height: 52px;
              width: 260px;
              max-width: calc(100% - 40px);
              position: absolute;
              bottom: 24px;
              left: 50%;
              transform: translateX(-50%);
              border-radius: 26px;
              box-shadow: 0 8px 24px rgba(0,0,0,0.3);
              background: #c1121c; /* OEBB Red */
              border: 1px solid rgba(255,255,255,0.2);
              display: flex;
              align-items: center;
              padding: 0 16px;
              justify-content: space-between;
              overflow: hidden;
            }

            .departure-board.minimized .board-header {
              background: transparent !important;
              padding: 0;
              min-height: 0;
              flex: 1;
              display: flex;
              align-items: center;
              gap: 8px;
            }

            .departure-board.minimized .header-main {
              padding: 0;
            }

            .departure-board.minimized .stop-name {
              font-size: 1.1rem;
              margin: 0;
              color: #fff !important;
              max-width: 130px;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }

            .departure-board.minimized .header-controls {
               position: static;
               transform: none;
               display: flex;
               gap: 8px;
            }

            .departure-board.minimized .type-filter-toolbar,
            .departure-board.minimized .table-container,
            .departure-board.minimized .header-clock,
            .departure-board.minimized .header-main h1 {
              display: none !important;
            }

            .departure-board.minimized .control-btn {
               background: rgba(255, 255, 255, 0.2);
               border: 1px solid rgba(255, 255, 255, 0.3);
               color: #fff;
               width: 18px;
               height: 18px;
               font-size: 14px;
            }

            .departure-board.minimized .cross-line {
              width: 12px;
            }
        }
      `}</style>
    </Show>
  );
}
