import { useStore } from '@nanostores/solid';
import { $departureBoardResults, submitWaypointsBatch, $clock, $stopTimeZone, $previewRoute, $boardMinimized, $isFollowing, $myPlayerId, $roomState, type DepartureResult, setViewingStop, $gameBounds, $mapZoom, $boardMode } from './store';
import { Show, For, createEffect, createSignal, createMemo, onMount, onCleanup } from 'solid-js';
import { playerPositions } from './playerPositions';
import { haversineDist, bearingToCardinal, findClosestCity } from './utils/geo';
import { chQuery } from './clickhouse';
import { formatInTimeZone, getTimeZoneColor, getTimeZone, getTimeZoneLanguage, getDepartureLabel, getArrivalLabel } from './timezone';
import { getRouteEmoji } from './getRouteEmoji';
import { parseDBTime, getWallSeconds } from './utils/time';
import { formatRowTime } from './utils/format';

const StatusDot = (props: { isImminent: boolean; class?: string; style?: any }) => (
  <Show when={props.isImminent}>
    <span class={`status-dot imminent ${props.class || ''}`} style={props.style}></span>
  </Show>
);

const RoutePill = (props: { row: DepartureResult; class?: string }) => (
  <span
    class={`route-pill ${props.class || ''}`}
    style={{
      'background-color': props.row.route_color ? `#${props.row.route_color}` : '#333',
      color: props.row.route_text_color ? `#${props.row.route_text_color}` : '#fff',
    }}
  >
    {props.row.route_short_name || '??'}
  </span>
);

const DirectionIcon = (props: { bearing: number; class?: string }) => (
  <svg
    class={`dir-icon ${props.class || ''}`}
    viewBox="0 0 24 24"
    style={{
      transform: `rotate(${props.bearing || 0}deg)`,
    }}
  >
    <path d="M12 2L4.5 20.29C4.24 20.93 4.97 21.5 5.56 21.14L12 17.27L18.44 21.14C19.03 21.5 19.76 20.29 19.5 20.29L12 2Z" />
  </svg>
);

const ActionButton = (props: {
  icon: any;
  title?: string;
  onClick: (e: MouseEvent) => void;
  disabled?: boolean;
  loading?: boolean;
  spinnerStyle?: any;
  buttonStyle?: any;
  class?: string;
}) => (
  <button
    class={`preview-btn ${props.class || ''}`}
    onClick={(e) => {
      e.stopPropagation();
      props.onClick(e);
    }}
    title={props.title}
    disabled={props.disabled}
    style={props.buttonStyle}
  >
    <Show when={props.loading} fallback={props.icon}>
      <span class="spinner-small" style={props.spinnerStyle}></span>
    </Show>
  </button>
);

export default function DepartureBoard() {
  const results = useStore($departureBoardResults);
  const currentTime = useStore($clock);
  const roomState = useStore($roomState);
  const mode = useStore($boardMode);

  const stopZone = useStore($stopTimeZone);
  const isMinimized = useStore($boardMinimized);
  const mapZoom = useStore($mapZoom);
  const preview = useStore($previewRoute);

  const [filterType, setFilterType] = createSignal<string | null>(null);
  const [loadingTripKey, setLoadingTripKey] = createSignal<string | null>(null);
  const [isTooFar, setIsTooFar] = createSignal(false);
  const [flashError, setFlashError] = createSignal(false);

  createEffect(() => {
    const res = results();
    const stopName = res && res.length > 0 ? res[0].stop_name : null;
    setViewingStop(stopName);
  });

  const checkDistance = (force = false) => {
    const res = deduplicatedResults();
    if (res.length === 0) {
      setIsTooFar(false);
      return;
    }

    if ($boardMinimized.get() && !force) return;

    const pid = $myPlayerId.get();
    if (!pid) return;

    const stop = res[0];
    const myPos = playerPositions[pid];
    if (myPos) {
      const dist = haversineDist(myPos, [stop.stop_lon, stop.stop_lat]);
      if (dist !== null) {
        setIsTooFar(dist > 0.2); // 200m
      }
    }
  };

  createEffect(() => {
    if (deduplicatedResults().length > 0) {
      checkDistance(true);
    } else {
      setIsTooFar(false);
    }
  });

  onMount(() => {
    const interval = setInterval(() => checkDistance(false), 100);
    onCleanup(() => clearInterval(interval));
  });

  const blockingReason = createMemo(() => {
    if (roomState() !== 'RUNNING') {
      return "⚠️ The game hasn't started yet!";
    }
    if (isTooFar()) {
      return `⚠️ You are too far from the station to board (${deduplicatedResults()[0]?.stop_name})`;
    }
    return null;
  });

  const isPreviewImminent = createMemo(() => {
    const p = preview();
    if (!p) return false;
    const timeVal = mode() === 'departures' ? p.row.departure_time : p.row.next_arrival;
    const depSeconds = getRowSeconds(timeVal || '');
    const now = currentTime();
    const zone = stopZone();
    const localSeconds = getLocalSeconds(now, zone);
    const diff = depSeconds - localSeconds;
    return diff > 0 && diff <= 120;
  });

  createEffect(() => {
    const p = preview();
    if (!p) return;
    const timeVal = mode() === 'departures' ? p.row.departure_time : p.row.next_arrival;
    const depSeconds = getRowSeconds(timeVal || '');
    const now = currentTime();
    const zone = stopZone();
    const localSeconds = getLocalSeconds(now, zone);
    if (localSeconds > depSeconds + 10) {
      $previewRoute.set(null);
    }
  });

  createEffect(() => {
    if (!results() || results()!.length === 0) {
      $boardMinimized.set(false);
    }
  });

  createEffect(() => {
    if (results() && results()!.length > 0) {
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
    const currentMode = mode();

    const filtered = []
    let seenNonTomorrow = false;
    for (const row of raw) {
      const timeVal = currentMode === 'departures' ? row.departure_time : row.next_arrival;
      const depSeconds = getRowSeconds(timeVal || '');
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
    // $boardMode.set('departures'); // eugh but reactivity causes the board to pop up instantly
    $departureBoardResults.set([]);
    $boardMinimized.set(false);
    setFilterType(null);
    $previewRoute.set(null);
  };

  const handlePreviewClick = (row: DepartureResult, direction: "forwards" | "backwards" = "forwards") => {
    const query = `
          SELECT stop_lat, stop_lon
          FROM transitous_everything_20260117_stop_times_one_day_even_saner
          WHERE "ru.source" = '${row['source']}'
            AND "ru.trip_id" = '${row['trip_id']}'
            AND sane_route_id = '${row.sane_route_id}'
            AND departure_time ${direction === 'forwards' ? '>=' : '<='} '${direction === 'forwards' ? row.departure_time : row.next_arrival}'
          ORDER BY departure_time ${direction === 'forwards' ? 'ASC' : 'DESC'}
          LIMIT 100
        `;

    chQuery(query)
      .then(res => {
        if (res && res.data && res.data.length > 0) {
          const coords = res.data.map((r: any) => [r.stop_lon, r.stop_lat]);
          $previewRoute.set({ coords: coords as [number, number][], row });
        }
      })
      .catch(err => console.error(`[ClickHouse] Preview query failed:`, err));
  };

  const handleTripDoubleClick = (row: DepartureResult) => {
    console.log("clicked");
    if (blockingReason()) {
      console.log("denied");
      setFlashError(false);
      setTimeout(() => setFlashError(true), 0);
      setTimeout(() => setFlashError(false), 500);
      return;
    }
    const key = `${row.source}-${row.trip_id}-${row.departure_time}`;
    setLoadingTripKey(key);
    const query = `
      SELECT stop_name, stop_lat, stop_lon, arrival_time, departure_time
      FROM transitous_everything_20260117_stop_times_one_day_even_saner
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
              stopName: r.stop_name,
              timeZone: thisStopZone
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
            isWalk: idx === 0,
            route_color: row.route_color,
            route_short_name: row.route_short_name,
            display_name: row.trip_headsign || row.route_long_name || row.stop_name,
            emoji: getRouteEmoji(row.route_type),
            route_departure_time: row.departure_time
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
        classList={{ minimized: isMinimized(), 'arrivals-mode': mode() === 'arrivals' }}
        onClick={close}
      >
        <div
          class="departure-board"
          classList={{ minimized: isMinimized() }}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="board-header">
            <Show when={preview()} fallback={
              <div class="header-main">
                <div class="mode-switcher">
                  <div
                    class="mode-option"
                    classList={{ active: mode() === 'departures' }}
                    onClick={() => $boardMode.set('departures')}
                  >
                    {getDepartureLabel(getTimeZoneLanguage(stopZone()))}
                  </div>
                  <div
                    class="mode-option"
                    classList={{ active: mode() === 'arrivals' }}
                    onClick={() => $boardMode.set('arrivals')}
                  >
                    {getArrivalLabel(getTimeZoneLanguage(stopZone()))}
                  </div>
                  <div
                    class="mode-indicator"
                    style={{
                      transform: `translateX(${mode() === 'departures' ? '0' : '100'}%)`,
                      background: mode() === 'arrivals' ? '#3cd578' : '#31a9ff',
                    }}
                  />
                </div>
                <div class="stop-name">
                  {deduplicatedResults()[0]?.stop_name || 'Railway Station'}
                </div>
              </div>
            }>
              {(p) => (
                <div class="header-main preview-header">
                  <div class="preview-details">
                    <div class="preview-time-line">
                      <StatusDot isImminent={isPreviewImminent()} />
                      <span class="preview-time">{formatRowTime((mode() === 'departures' ? p().row.departure_time : p().row.next_arrival) || '')}</span>
                      <RoutePill row={p().row} class="preview-pill" />
                      <span class="preview-type">{getRouteEmoji(p().row.route_type)}</span>
                    </div>
                    <div class="preview-dest">{p().row.trip_headsign || p().row.route_long_name}</div>
                  </div>
                </div>
              )}
            </Show>
            <div class="header-controls">
              <Show when={mode() === 'departures' ? preview() : null}>
                {(p) => (
                  <ActionButton
                    icon="🛂"
                    title={blockingReason() || "Board"}
                    onClick={() => {
                      if (blockingReason()) {
                        setFlashError(false);
                        setTimeout(() => setFlashError(true), 500);
                        setTimeout(() => setFlashError(false), 1000);
                        $boardMinimized.set(false);
                        $previewRoute.set(null);
                        return;
                      }
                      handleTripDoubleClick(p().row);
                      $previewRoute.set(null);
                    }}
                    disabled={loadingTripKey() !== null}
                    loading={loadingTripKey() === `${p().row.source}-${p().row.trip_id}-${p().row.departure_time}`}
                    class="control-btn board-control-btn"
                  />
                )}
              </Show>
              <button
                class="control-btn minimize-btn"
                onClick={() => {
                  const nextMin = !isMinimized();
                  $boardMinimized.set(nextMin);
                  if (!nextMin) $previewRoute.set(null);
                }}
                title={isMinimized() ? "Expand" : "Minimize"}
              >
                <span class="cross-line" style={{ transform: isMinimized() ? 'rotate(90deg)' : 'none' }}></span>
                <span class="cross-line"></span>
              </button>
              <button class="control-btn close-btn" onClick={close} title="Close Board">✕</button>
            </div>
            <div class="header-clock" style={{ "--clock-bg": getTimeZoneColor(stopZone()) }}>
              <div class="clock-time">{formatClockTime(currentTime(), true)}</div>
              <div class="clock-zone">{stopZone()}</div>
            </div>
          </div>

          <Show when={!isMinimized()}>
            <Show when={blockingReason()}>
              <div
                class="banner banner-error"
                classList={{ 'flash-animation': flashError() }}
                style={{ opacity: flashError() ? 1 : 0.9 }}
              >
                {blockingReason()}
              </div>
            </Show>

            <Show when={mapZoom() < 16}>
              <div class="banner banner-warning">
                ⚠️ Some stops are hidden until you zoom in further
              </div>
            </Show>
          </Show>

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
              <div class="col-time">{mode() === 'departures' ? 'Dep.' : 'Arr.'}</div>
              <div class="col-route">Line</div>
              <div class="col-dest">{mode() === 'departures' ? 'Destination' : 'Route name'}</div>
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
                    const timeVal = mode() === 'departures' ? row.departure_time : row.next_arrival;
                    const depSeconds = getRowSeconds(timeVal || '');
                    return depSeconds < localSeconds;
                  });

                  const isImminent = createMemo(() => {
                    const timeVal = mode() === 'departures' ? row.departure_time : row.next_arrival;
                    const depSeconds = getRowSeconds(timeVal || '');
                    const now = currentTime();
                    const zone = stopZone();
                    const localSeconds = getLocalSeconds(now, zone);
                    const diff = depSeconds - localSeconds;
                    return diff > 0 && diff <= 120;
                  });

                  const [copied, setCopied] = createSignal(false);

                  const mainDestText = createMemo(() => {
                    // todo: think about arrivals
                    return row.trip_headsign || (bearingToCardinal(row.bearing) + " via " + findClosestCity({ latitude: row.next_lat, longitude: row.next_lon }));
                  });
                  const finalDestText = createMemo(() => findClosestCity({ latitude: $boardMode.get() === 'departures' ? row.final_lat : row.stop_lat, longitude: $boardMode.get() === 'departures' ? row.final_lon : row.stop_lon }));

                  const handleBoardClick = () => handleTripDoubleClick(row);
                  const handlePreview = () => handlePreviewClick(row, $boardMode.get() === 'departures' ? 'forwards' : 'backwards');
                  const handleCopy = () => {
                    navigator.clipboard.writeText(JSON.stringify(row));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  };

                  const isLoading = createMemo(() => loadingTripKey() === `${row.source}-${row.trip_id}-${row.departure_time}`);

                  return (
                    <div
                      class="table-row"
                      style={{ cursor: 'pointer' }}
                      onDblClick={handleBoardClick}
                    >
                      {/* Desktop Layout (visible on >768px) */}
                      <div class="desktop-row-content">
                        <div class="col-status">
                          <StatusDot isImminent={isImminent()} />
                        </div>
                        <div class="col-time" style={{ "line-height": "1.1" }}>
                          <div>{formatRowTime((mode() === 'departures' ? row.departure_time : row.next_arrival) || '')}</div>
                          <Show when={isTomorrow()}>
                            <div style={{ "font-size": "0.65em", "color": "#ffed02", "opacity": "0.8" }}>
                              (tmrw.)
                            </div>
                          </Show>
                        </div>
                        <div class="col-route">
                          <RoutePill row={row} />
                        </div>
                        <div class="col-dest">
                          <div class="dest-main">{mainDestText()}</div>
                          <div class="route-long">{row.route_long_name}</div>
                          <Show when={$gameBounds.get().difficulty === 'Easy'}>
                            <div style={{ "font-size": "0.5em", "margin-top": "2px", "color": "#ccc", "font-weight": "normal", "text-align": "right" }}>
                              {finalDestText()} ({formatRowTime((mode() === 'departures' ? row.final_arrival : row.departure_time) || '')})
                            </div>
                          </Show>
                        </div>

                        <div class="col-dir">
                          <DirectionIcon bearing={mode() === 'departures' ? row.bearing : (row.bearing + 180) % 360} />
                        </div>

                        <div class="col-type">{getRouteEmoji(row.route_type)}</div>
                        <div class="col-preview">
                          <ActionButton icon="🔍" title="Preview Trip Route" onClick={handlePreview} />
                        </div>
                        <Show when={mode() === 'departures'}>
                          <div class="col-board">
                            <ActionButton
                              icon="🛂"
                              title={blockingReason() || "Board"}
                              onClick={handleBoardClick}
                              disabled={loadingTripKey() !== null}
                              loading={isLoading()}
                            />
                          </div>
                        </Show>
                        <Show when={$gameBounds.get().difficulty === 'Transport nerd'}>
                          <div class="col-board">
                            <ActionButton
                              icon={copied() ? 'Debug data copied to clipboard!' : '💻'}
                              title={copied() ? "Copied!" : "Copy raw data to clipboard"}
                              onClick={handleCopy}
                            />
                          </div>
                        </Show>
                      </div>

                      {/* Mobile Layout (visible on <=768px) */}
                      <div class="mobile-row-content">
                        <div class="mobile-row-top">
                          <div class="mobile-time">
                            <div style={{ display: "flex", "align-items": "center" }}>
                              {formatRowTime((mode() === 'departures' ? row.departure_time : row.next_arrival) || '')}
                            </div>
                            <StatusDot isImminent={isImminent()} style={{ "margin-left": "4px" }} />
                            <Show when={isTomorrow()}>
                              <div class="mobile-tomorrow">tomorrow</div>
                            </Show>
                          </div>
                          <div class="mobile-route-info">
                            <span class="mobile-emoji">{getRouteEmoji(row.route_type)}</span>
                            <RoutePill row={row} />
                          </div>
                          <div class="mobile-dest-arrow">→</div>
                          <div class="mobile-dest-name">
                            {mainDestText()}
                            <Show when={$gameBounds.get().difficulty === 'Easy'}>
                              <div style={{ "font-size": "0.8em", "opacity": "0.8", "font-weight": "normal", "color": "#444" }}>
                                {finalDestText()} ({formatRowTime(row.final_arrival || '')})
                              </div>
                            </Show>
                          </div>
                        </div>
                        <div class="mobile-row-bottom">
                          <div class="mobile-secondary-info">
                            {row.route_long_name}
                          </div>
                          <div class="mobile-actions">
                            <div class="col-dir">
                              <DirectionIcon bearing={mode() === 'departures' ? row.bearing : (row.bearing + 180) % 360} />
                            </div>
                            <ActionButton icon="🔍" title="Preview Trip Route" onClick={handlePreview} />
                            <Show when={mode() === 'departures'}>
                              <ActionButton
                                icon="🛂"
                                title={blockingReason() || "Board"}
                                onClick={handleBoardClick}
                                disabled={loadingTripKey() !== null}
                                loading={isLoading()}
                                spinnerStyle={{ "border-top-color": "#000" }}
                              />
                            </Show>
                            <Show when={$gameBounds.get().difficulty === 'Transport nerd'}>
                              <ActionButton
                                icon={copied() ? 'Debug data copied to clipboard!' : '💻'}
                                title={copied() ? "Copied!" : "Copy raw data to clipboard"}
                                onClick={handleCopy}
                                buttonStyle={{ "color": "#000" }}
                              />
                            </Show>
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
      </div >

      <style>{`
        .departure-board-overlay {
          /* Theme Variables - Desktop (SNCF style) */
          --db-bg: #0064ab;
          --db-bg-dark: #003a79;
          --db-header-bg: #0064ab;
          --db-header-border: #003a79;
          --db-accent-yellow: #ffed02;
          --db-text-main: #ffffff;
          --db-text-muted: rgba(255, 255, 255, 0.6);
          --db-text-dim: rgba(255, 255, 255, 0.7);
          --db-error: #dc2626;
          --db-warning: #ffe96bff;
          --db-imminent: #ff9800;
          --db-imminent-glow: #e0b0ff;
          --db-scrollbar-track: #001a35;
          --db-scrollbar-thumb: #004a99;
          --db-br-outer: 12px;
          --db-br-inner: 8px;
          --db-pad-base: 16px;
          --db-trans-med: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
          --db-shadow: 0 30px 60px rgba(0,0,0,0.5);

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

        /* SNCF green theme for arrivals */
        @media (min-width: 769px) {
          .departure-board-overlay.arrivals-mode {
            --db-bg: #187936;
            --db-bg-dark: #1f5628;
            --db-header-bg: #187936;
            --db-header-border: #1f5628;
            --db-accent-yellow: #ffed02;
            --db-scrollbar-track: #153c1d;
            --db-scrollbar-thumb: #3cd578;
          }
        }

        @media (max-width: 768px) {
          .departure-board-overlay {
            /* Theme Variables - Mobile (OEBB style) */
            --db-header-bg: #c1121c;
            --db-accent-red: #c1121c;
            --db-bg: #ffffff;
            --db-text-main: #333333;
            --db-br-outer: 20px;
            align-items: flex-end;
          }
        }

        .departure-board-overlay.minimized {
          background: transparent;
          backdrop-filter: none;
          pointer-events: none;
        }

        .departure-board {
          background: var(--db-bg);
          width: 90vw;
          max-width: 1000px;
          height: 80vh;
          border-radius: var(--db-br-outer);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          box-shadow: var(--db-shadow);
          border: 4px solid var(--db-bg-dark);
          position: relative;
          transition: var(--db-trans-med);
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
          border-radius: var(--db-br-inner);
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
          border: 2px solid var(--db-bg-dark);
        }

        @keyframes slideIn {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }

        .board-header {
          padding: 24px 32px;
          background: var(--db-header-bg);
          border-bottom: 2px solid var(--db-bg-dark);
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
          color: var(--db-text-muted);
          transition: all 0.3s ease;
        }

        .departure-board.minimized .header-main h1 {
          display: none;
        }

        .departure-board.minimized .header-clock {
          display: none;
        }

        .mode-switcher {
          display: flex;
          position: relative;
          background: rgba(0, 0, 0, 0.2);
          border-radius: 4px;
          padding: 2px;
          margin-bottom: 8px;
          width: fit-content;
        }

        .mode-option {
          padding: 4px 16px;
          cursor: pointer;
          font-weight: 800;
          font-size: 0.8rem;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: #fff;
          opacity: 0.6;
          transition: all 0.3s ease;
          position: relative;
          z-index: 1;
        }

        .mode-option.active {
          opacity: 1;
        }

        .mode-indicator {
          position: absolute;
          left: 2px;
          top: 2px;
          bottom: 2px;
          width: calc(50% - 2px);
          border-radius: 3px;
          transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), background 0.3s ease;
        }

        .stop-name {
          font-size: 32px;
          font-weight: 900;
          margin: 0;
          color: var(--db-accent-yellow);
          transition: color 0.3s ease;
        }

        .arrivals-mode .stop-name {
          color: #fff;
        }

        .departure-board.minimized .stop-name {
          font-size: 1rem;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--db-accent-yellow);
        }

        .col-status { width: 30px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .col-time { width: 80px; flex-shrink: 0; }
        .col-route { width: 150px; flex-shrink: 0; }
        .col-dir { width: 50px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
        .col-type { width: 80px; text-align: center; flex-shrink: 0; }
        .col-preview { width: 60px; text-align: right; flex-shrink: 0; }
        .col-board { width: 60px; text-align: right; flex-shrink: 0; }

        .col-dest { 
          flex: 1; 
          color: #fff; 
          overflow: hidden; 
          white-space: nowrap;
          text-overflow: ellipsis;
          padding-right: 20px;
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

        .preview-header {
          display: flex;
          align-items: center;
          gap: 16px;
          flex: 1;
        }

        .preview-details {
          display: flex;
          flex-direction: column;
          gap: 2px;
          flex: 1;
          min-width: 0;
        }

        .preview-time-line {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .preview-time {
          font-weight: 900;
          font-size: 1.2rem;
          color: #ffed02;
        }

        .preview-dest {
          font-weight: 700;
          font-size: 0.9rem;
          color: #fff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .departure-board.minimized .preview-header {
          margin-right: 120px;
        }

        .departure-board.minimized .board-header {
          padding: 0 32px;
          min-height: 0;
        }

        .board-control-btn {
          color: #000 !important;
          border: none !important;
        }

        .board-control-btn:hover {
          transform: scale(1.1);
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

        .table-row:hover {
          background: rgba(255, 255, 255, 0.1) !important;
          box-shadow: inset 0 0 0 1px #fff;
        }

        .header-clock {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          padding: 8px 20px;
          border-radius: var(--db-br-inner);
          color: #fff;
          text-align: center;
          border: 1px solid rgba(255,255,255,0.2);
          display: flex;
          flex-direction: column;
          align-items: center;
          transition: background 1.5s ease;
          background: var(--clock-bg, transparent);
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
          background: var(--db-bg-dark);
          display: flex;
          gap: 8px;
          overflow-x: auto;
          flex-shrink: 0;
          scrollbar-width: none;
        }

        .type-filter-toolbar::-webkit-scrollbar {
          display: none;
        }

        .departure-board.minimized .type-filter-toolbar {
          display: none;
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
          background: var(--db-accent-yellow);
          color: #000;
        }

        .table-container {
          flex: 1;
          background: var(--db-bg);
          transition: all 0.4s ease;
        }

        .departure-board.minimized .table-container {
          opacity: 0;
          height: 0;
          pointer-events: none;
        }

        .table-head {
          display: flex;
          background: var(--db-bg-dark);
          padding: 12px 20px;
          border-bottom: 2px solid var(--db-bg);
        }

        .table-head > div {
          font-weight: 800;
          text-transform: uppercase;
          font-size: 0.9rem;
          color: var(--db-text-dim);
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
          padding: var(--db-pad-base) 20px;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          transition: background 0.2s;
        }

        .table-row:nth-child(even) {
          background: var(--db-bg-dark) !important;
        }

        .desktop-row-content {
          display: flex;
          align-items: center;
          width: 100%;
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

        .dir-icon {
          width: 24px;
          height: 24px;
          fill: rgba(255, 255, 255, 0.9);
          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));
          transition: transform 0.2s ease;
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

        .route-pill {
          padding: 4px 10px;
          border-radius: 4px;
          font-weight: 800;
          font-size: 0.9rem;
          display: inline-block;
          min-width: 50px;
          max-width: 120px;
          text-overflow: ellipsis;
          overflow: hidden;
          text-align: center;
          box-shadow: inset 0 0 4px rgba(0,0,0,0.3);
        }

        .dest-main {
          font-weight: 700;
          font-size: 1.1rem;
          color: #fff;
        }

        .table-body::-webkit-scrollbar {
          width: 8px;
        }
        .table-body::-webkit-scrollbar-track {
          background: var(--db-scrollbar-track);
        }
        .table-body::-webkit-scrollbar-thumb {
          background: var(--db-scrollbar-thumb);
          border-radius: 4px;
        }

        .table-body .col-time {
          color: var(--db-accent-yellow);
          font-weight: 700;
          font-size: 1.1rem;
          letter-spacing: -0.02em;
          transition: color 0.3s ease;
        }

        .arrivals-mode .table-body .col-time {
          color: #ffed02; /* SNCF Yellow */
        }
        .arrivals-mode .route-long {
          color: #fff;
          opacity: 0.6;
        }

        .table-body .col-type {
          width: 60px;
          height: 32px;
          line-height: 32px;
          text-align: center;
          flex-shrink: 0;
          border: 1px solid #fff;
          border-radius: 44px;
          background: rgba(255,255,255,0.8);
          font-size: 1.4rem;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        /* Status Dot & Imminent */
        .status-dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          margin-right: 8px;
          vertical-align: middle;
        }
        .status-dot.imminent {
          background-color: var(--db-imminent);
          box-shadow: 0 0 8px var(--db-imminent-glow);
          animation: pulse-orange-mauve 1.5s infinite;
        }
        @keyframes pulse-orange-mauve {
          0% { box-shadow: 0 0 0 0 rgba(255, 152, 0, 0.7), 0 0 0 0 rgba(224, 176, 255, 0.4); }
          70% { box-shadow: 0 0 0 10px rgba(255, 152, 0, 0), 0 0 15px 10px rgba(224, 176, 255, 0); }
          100% { box-shadow: 0 0 0 0 rgba(255, 152, 0, 0), 0 0 0 0 rgba(224, 176, 255, 0); }
        }

        /* Warning Banners */
        .banner {
          padding: 8px;
          text-align: center;
          font-weight: bold;
          font-size: 0.9em;
          transition: opacity 0.1s;
        }
        .banner-error {
          background: var(--db-error);
          color: #fff;
          opacity: 0.9;
        }
        .banner-warning {
          background: var(--db-warning);
          color: #000;
        }
        @keyframes flash-warning {
          0%, 100% { background-color: var(--db-error); transform: scale(1); }
          25% { background-color: var(--db-accent-yellow); transform: scale(1.05); color: #000; }
          50% { background-color: var(--db-error); transform: scale(1); color: #fff; }
          75% { background-color: var(--db-accent-yellow); transform: scale(1.05); color: #000; }
        }
        .flash-animation {
          animation: flash-warning 0.5s ease-in-out;
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
        @keyframes spin { to { transform: rotate(360deg); } }


        @media (max-width: 768px) {
            .preview-header {
              flex-direction: column;
              align-items: flex-start;
              gap: 4px;
            }
            .preview-time {
              font-size: 1rem;
            }
            .preview-dest {
              font-size: 0.8rem;
            }
            .status-dot { margin-top: 10px; }
            .type-filter-toolbar { background: #fff; padding-top: 8px; padding-bottom: 12px; }
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
            }
            .filter-btn.active {
              background: var(--db-accent-yellow);
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }
            .dir-icon { fill: #000; filter: none; }
            .departure-board { width: 100%; height: 90vh; border-radius: var(--db-br-outer) var(--db-br-outer) 0 0; border: none; }
            .board-header { flex-direction: column; align-items: flex-start; padding: 20px; height: auto; min-height: auto; gap: 12px; }
            .header-main h1 { font-size: 14px; color: rgba(255,255,255,0.9); font-weight: bold; text-transform: none; letter-spacing: normal; }
            .stop-name { font-size: 1rem; color: #fff !important; white-space: normal; }
            .header-clock { position: relative; width: 100%; background: rgba(0,0,0,0.1); border: none; padding: 8px 12px; flex-direction: row; justify-content: space-between; margin: 0; transform: none; left: auto; top: auto; }
            .clock-time { font-size: 1.6rem; }
            .table-head { display: none; }
            .table-row { padding: 16px; border-bottom: 1px solid #eee; background: #fff !important; color: var(--db-text-main); }
            .table-row:nth-child(even) { background: #f9f9f9 !important; }
            .desktop-row-content { display: none; }
            .mobile-row-content { display: flex; flex-direction: column; gap: 4px; }
            .mobile-row-top { display: flex; align-items: center; gap: 12px; font-size: 0.8rem; }
            .mobile-time { font-weight: 800; width: 55px; color: #000; display: flex; flex-direction: column; line-height: 1; justify-content: center; }
            .mobile-route-info { display: flex; align-items: center; gap: 4px; }
            .mobile-emoji { font-size: 1.2rem; }
            .mobile-dest-arrow { color: #888; font-weight: 300; }
            .mobile-dest-name { font-weight: 600; color: #000; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .mobile-row-bottom { display: flex; justify-content: space-between; align-items: center; margin-left: 67px; margin-top: 2px; }
            .mobile-secondary-info { font-size: 0.8rem; color: #666; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; padding-right: 10px; }
            .mobile-tomorrow { color: var(--db-accent-red); font-weight: bold; font-size: 0.6rem; margin-top: 2px; }
            .mobile-actions { display: flex; gap: 8px; }
            .table-container { background: #fff !important; display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
            .table-body { flex: 1; overflow-y: auto !important; -webkit-overflow-scrolling: touch; min-height: 0; max-height: none !important; }
            .table-body::-webkit-scrollbar-thumb { background: var(--db-accent-red); border-radius: 10px; }
            .route-pill { font-size: 0.6rem; padding: 2px 8px; border-radius: 4px; min-width: 25px; box-shadow: none; }
            .departure-board.minimized {
              height: 60px;
              width: calc(100% - 24px);
              max-width: 450px;
              bottom: 24px;
              left: 50%;
              transform: translateX(-50%);
              background: var(--db-accent-red);
              padding: 0 16px;
              border: 1px solid rgba(255,255,255,0.2);
              justify-content: center;
            }
            .departure-board.minimized .board-header { 
              background: transparent !important; 
              flex-direction: row;
              align-items: center;
              padding: 0 12px;
              height: 100%;
              width: 100%;
              gap: 8px;
            }
            .departure-board.minimized .preview-header {
              flex-direction: column;
              align-items: flex-start;
              gap: 0;
              margin-right: 80px;
            }
            .departure-board.minimized .stop-name { font-size: 1.1rem; max-width: 130px; }
            .departure-board.minimized .control-btn { background: rgba(255, 255, 255, 0.2); width: 24px; height: 24px; font-size: 14px; }
            .departure-board.minimized .cross-line { width: 12px; }
            .departure-board.minimized .header-controls {
              top: 50%;
              transform: translateY(-50%);
              right: 12px;
              flex-shrink: 0;
            }
        }
      `}</style>
    </Show >
  );
}
