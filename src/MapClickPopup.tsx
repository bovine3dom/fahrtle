import { submitWaypoint } from './store';
import { handleMapClickForDepartures } from './map/clickHandlers';
import { getMapInstance } from './Map';

interface MapClickPopupProps {
  lat: number;
  lng: number;
  onClose: () => void;
  onShowDepartures: () => void;
}

export default function MapClickPopup(props: MapClickPopupProps) {
  const handleWalk = () => {
    submitWaypoint(props.lat, props.lng);
    props.onClose();
  };

  const handleDepartures = (precise: boolean = false) => {
    const map = getMapInstance();
    if (map) handleMapClickForDepartures(map, props.lat, props.lng, precise);
    props.onShowDepartures();
    props.onClose();
  };

  return (
    <div class="map-click-popup" onClick={(e) => e.stopPropagation()}>
      <button class="popup-btn walk-btn" onClick={handleWalk}>
        Walk 🚶
      </button>
      <button class="popup-btn departures-btn" onClick={() => handleDepartures(false)}>
        Departures 🚇
      </button>
      <button class="popup-btn departures-precise-btn" onClick={() => handleDepartures(true)}>
        Precise 📍
      </button>
    </div>
  );
}
