import { length, lineString } from '@turf/turf';
import { atom, map } from 'nanostores';
import { syncClock } from './time-sync';
// import { $timeOffset } from './time-sync';

// Store for the VISUAL routes (The static lines on the map)
// MapLibre can consume this directly.
export const $routeLines = atom<GeoJSON.FeatureCollection>({
  type: 'FeatureCollection',
  features: []
});

// Store for the MATH (The animation logic)
export type ProcessedTrip = {
  id: string;
  team: string;
  segments: {
    start: [number, number];
    end: [number, number];
    startTime: number;
    endTime: number;
  }[];
  finalPosition: [number, number];
};

export const $activeTrips = map<Record<string, ProcessedTrip>>({});

export function connectWebSocket(url: string) {
  const ws = new WebSocket(url);

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    // 1. Initial Handshake / Ping-Pong Sync
    if (msg.type === 'SYNC_RESPONSE') {
      const now = Date.now();
      const latency = (now - msg.clientSendTime) / 2;
      // Assume rate is 1.0 initially or server sends it
      syncClock(msg.serverTime, msg.rate || 1.0, latency); 
    }

    // 2. Periodic Broadcast or Rate Change
    // The server pushes this whenever it wants to change speed or fix drift
    if (msg.type === 'CLOCK_UPDATE') {
      // We assume one-way latency is roughly half of previous RTT, 
      // or we just ignore latency for simple broadcasts if <100ms doesn't matter.
      // For precision, we'd want to ping/pong, but let's assume 50ms latency for broadcast.
      const estimatedLatency = 50; 
      syncClock(msg.serverTime, msg.rate, estimatedLatency);
    }
    

    // SERVER SENDS GEOJSON LINESTRINGS NOW
    if (msg.type === 'TRIP_UPDATE') {
      const geoJson = msg.data as GeoJSON.FeatureCollection;
      console.log(msg);
      
      // 1. Update the Route Lines immediately (Visuals)
      $routeLines.set(geoJson);

      // 2. Process for Animation (Logic)
      const updates: Record<string, ProcessedTrip> = {};

      geoJson.features.forEach((f) => {
        const coords = (f.geometry as GeoJSON.LineString).coordinates;
        const props = f.properties || {};
        const startTime = props.startTime; // Absolute Server Time
        const endTime = props.endTime;     // Absolute Server Time
        const totalDuration = endTime - startTime;
        
        // --- TURF.JS MAGIC HERE ---
        // We use Turf to get the precise geodesic length of the route
        const routeFeature = lineString(coords);
        const totalDistance = length(routeFeature, { units: 'kilometers' });

        const segments = [];
        let accumulatedTime = 0;

        // Break path into segments
        for (let i = 0; i < coords.length - 1; i++) {
          const segStart = coords[i];
          const segEnd = coords[i+1];
          
          // Measure just this segment with Turf
          const segFeat = lineString([segStart, segEnd]);
          const segDist = length(segFeat, { units: 'kilometers' });
          
          // Calculate time window for this segment based on constant speed
          // (segDist / totalDistance) * totalDuration
          const segDuration = totalDistance > 0 
            ? (segDist / totalDistance) * totalDuration 
            : 0;

          segments.push({
            start: segStart as [number, number],
            end: segEnd as [number, number],
            startTime: startTime + accumulatedTime,
            endTime: startTime + accumulatedTime + segDuration
          });

          accumulatedTime += segDuration;
        }

        updates[props.id] = {
          id: props.id,
          team: props.team,
          segments: segments,
          finalPosition: coords[coords.length - 1] as [number, number]
        };
      });

      $activeTrips.set({ ...$activeTrips.get(), ...updates });
    }
  };
  
  ws.onopen = () => {
    // Initiate Sync immediately
    ws.send(JSON.stringify({ 
      type: 'SYNC_REQUEST', 
      clientSendTime: Date.now() 
    }));
  };
}
