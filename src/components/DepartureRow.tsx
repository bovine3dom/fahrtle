import { Show, createMemo } from 'solid-js';
import { $gameBounds, $boardMode, $playerSettings, type DepartureResult } from '../store';
import { formatRowTime, sensibleNumber } from '../utils/format';
import { getRouteEmoji } from '../getRouteEmoji';
import { bearingToCardinal } from '../utils/geo';
import { createClosestCity } from '../utils/tiny-cities';

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
  dimmed?: boolean;
  loading?: boolean;
  spinnerStyle?: any;
  buttonStyle?: any;
  class?: string;
}) => (
  <button
    class={`preview-btn ${props.class || ''}`}
    classList={{ 'btn-dimmed': props.dimmed }}
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

export function DepartureRow(props: {
  row: DepartureResult;
  mode: () => 'departures' | 'arrivals';
  currentLocalSeconds: () => number;
  getRowSeconds: (departureTime: string) => number;
  globalBlock: () => string | false;
  blockReason: () => string | null | false;
  loadingTripKey: () => string | null;
  onBoard: () => void;
  onPreview: () => void;
  onCopy: () => void;
  copied: () => boolean;
}) {
  const isTomorrow = createMemo(() => {
    const localSeconds = props.currentLocalSeconds();
    const timeVal = props.mode() === 'departures' ? props.row.departure_time : props.row.next_arrival;
    const depSeconds = props.getRowSeconds(timeVal || '');
    return depSeconds < localSeconds;
  });

  const isImminent = createMemo(() => {
    const timeVal = props.mode() === 'departures' ? props.row.departure_time : props.row.next_arrival;
    const depSeconds = props.getRowSeconds(timeVal || '');
    const localSeconds = props.currentLocalSeconds();
    const diff = depSeconds - localSeconds;
    return diff > 0 && diff <= 120;
  });

  const mainDestText = createMemo(() => {
    return props.row.trip_headsign || (bearingToCardinal(props.row.bearing) + " via " + createClosestCity(() => ({ lat: props.row.next_lat, lon: props.row.next_lon }))());
  });
  const finalDestText = createMemo(() => ($boardMode.get() === 'departures' ? props.row.final_name : props.row.initial_name) + ", " + createClosestCity(() => ({ lat: $boardMode.get() === 'departures' ? props.row.final_lat : props.row.initial_lat, lon: $boardMode.get() === 'departures' ? props.row.final_lon : props.row.initial_lon }))());

  const isLoading = createMemo(() => props.loadingTripKey() === `${props.row.source}-${props.row.trip_id}-${props.row.departure_time}`);

  return (
    <div
      class="table-row"
      style={{ cursor: 'pointer' }}
      onDblClick={props.onBoard}
    >
      <div class="desktop-row-content">
        <div class="col-status">
          <StatusDot isImminent={isImminent()} />
        </div>
        <div class="col-time" style={{ "line-height": "1.1" }}>
          <div>{formatRowTime((props.mode() === 'departures' ? props.row.departure_time : props.row.next_arrival) || '')}</div>
          <Show when={isTomorrow()}>
            <div style={{ "font-size": "0.65em", "color": "#ffed02", "opacity": "0.8" }}>
              (tmrw.)
            </div>
          </Show>
        </div>
        <div class="col-route">
          <RoutePill row={props.row} />
        </div>
        <div class="col-dest">
          <div class="dest-main">{mainDestText()}</div>
          <div class="route-long">{props.row.route_long_name}</div>
          <Show when={$gameBounds.get().difficulty === 'Easy'}>
            <div style={{ "font-size": "0.5em", "margin-top": "2px", "color": "#ccc", "font-weight": "normal", "text-align": "right" }}>
              {finalDestText()} ({formatRowTime((props.mode() === 'departures' ? props.row.final_arrival : props.row.departure_time) || '')}) {props.row.dist ? `(${sensibleNumber(props.row.dist)} km)` : ''}
            </div>
          </Show>
        </div>

        <div class="col-dir">
          <DirectionIcon bearing={props.mode() === 'departures' ? props.row.bearing : props.row.bearing_origin} />
        </div>

        <div class="col-type">{getRouteEmoji(props.row.route_type)}</div>
        <div class="col-preview">
          <ActionButton icon="🔍" title="Preview Trip Route" onClick={props.onPreview} />
        </div>
        <Show when={props.mode() === 'departures'}>
          <div class="col-board">
            <ActionButton
              icon="🛂"
              title={props.blockReason() || "Board"}
              onClick={props.onBoard}
              disabled={(props.loadingTripKey() !== null) || !!props.blockReason()}
              loading={isLoading()}
              dimmed={!!props.blockReason()}
            />
          </div>
        </Show>
        <Show when={($gameBounds.get().difficulty === 'Transport nerd') || $playerSettings.get().debug}>
          <div class="col-board">
            <ActionButton
              icon={props.copied() ? 'Debug data copied to clipboard!' : '💻'}
              title={props.copied() ? "Copied!" : "Copy raw data to clipboard"}
              onClick={props.onCopy}
            />
          </div>
        </Show>
      </div>

      <div class="mobile-row-content">
        <div class="mobile-row-top">
          <div class="mobile-time">
            <div style={{ display: "flex", "align-items": "center" }}>
              {formatRowTime((props.mode() === 'departures' ? props.row.departure_time : props.row.next_arrival) || '')}
            </div>
            <StatusDot isImminent={isImminent()} style={{ "margin-left": "4px" }} />
            <Show when={isTomorrow()}>
              <div class="mobile-tomorrow">tomorrow</div>
            </Show>
          </div>
          <div class="mobile-route-info">
            <span class="mobile-emoji">{getRouteEmoji(props.row.route_type)}</span>
            <RoutePill row={props.row} />
          </div>
          <div class="mobile-dest-arrow">→</div>
          <div class="mobile-dest-name">
            {mainDestText()}
            <Show when={$gameBounds.get().difficulty === 'Easy'}>
              <div style={{ "font-size": "0.8em", "opacity": "0.8", "font-weight": "normal", "color": "#444" }}>
                {finalDestText()} ({formatRowTime((props.mode() === 'departures' ? props.row.final_arrival : props.row.departure_time) || '')}) {props.row.dist ? `(${sensibleNumber(props.row.dist)} km)` : ''}
              </div>
            </Show>
          </div>
        </div>
        <div class="mobile-row-bottom">
          <div class="mobile-secondary-info">
            {props.row.route_long_name}
          </div>
          <div class="mobile-actions">
            <div class="col-dir">
              <DirectionIcon bearing={props.mode() === 'departures' ? props.row.bearing : props.row.bearing_origin} />
            </div>
            <ActionButton icon="🔍" title="Preview Trip Route" onClick={props.onPreview} />
            <Show when={props.mode() === 'departures'}>
              <ActionButton
                icon="🛂"
                title={props.blockReason() || "Board"}
                onClick={props.onBoard}
                disabled={(props.loadingTripKey() !== null) || !!props.blockReason()}
                loading={isLoading()}
                dimmed={!!props.blockReason()}
                spinnerStyle={{ "border-top-color": "#000" }}
              />
            </Show>
            <Show when={($gameBounds.get().difficulty === 'Transport nerd') || $playerSettings.get().debug}>
              <ActionButton
                icon={props.copied() ? 'Debug data copied to clipboard!' : '💻'}
                title={props.copied() ? "Copied!" : "Copy raw data to clipboard"}
                onClick={props.onCopy}
                buttonStyle={{ "color": "#000" }}
              />
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
