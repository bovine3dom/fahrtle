import { serve } from "bun";

// --- Configuration ---
const TRIP_INTERVAL_MS = 10000; 
const SYNC_INTERVAL_MS = 5000;  
const RATE_CHANGE_MS = 15000;   

const server = serve({
  port: 8080,
  
  // FIXED: The fetch handler is required to upgrade HTTP -> WebSocket
  fetch(req, server) {
    const url = new URL(req.url);
    if (server.upgrade(req, { 
      // You can pass initial data here if needed, 
      // but we initialize inside 'open' below
      data: undefined 
    })) {
      return; // Bun handled the upgrade
    }
    return new Response("WebSocket server running. Connect via WS client.", { status: 200 });
  },

  websocket: {
    open(ws) {
      console.log("Client connected");

      // --- 1. The Virtual Clock State ---
      let virtualTime = Date.now(); 
      let lastRealTime = Date.now();
      let playbackRate = 1.0; 

      const updateClock = () => {
        const now = Date.now();
        const elapsedReal = now - lastRealTime;
        virtualTime += elapsedReal * playbackRate;
        lastRealTime = now;
      };

      const sendClockSync = () => {
        updateClock();
        ws.send(JSON.stringify({
          type: 'CLOCK_UPDATE',
          serverTime: virtualTime,
          rate: playbackRate
        }));
      };

      // --- 3. Trip Generation ---
      const sendTrips = () => {
        updateClock(); 

        const featureCollection = {
          type: 'FeatureCollection',
          features: [] as any[]
        };

        for (let i = 0; i < 20; i++) {
          const startTime = virtualTime; 
          const duration = 10000 + Math.random() * 20000; 
          const endTime = startTime + duration;

          const startLng = (Math.random() * 0.2) - 0.1; 
          const startLat = (Math.random() * 0.2) - 0.1;
          
          const waypoints = [[startLng, startLat]];
          for(let k=0; k<3; k++) {
             const last = waypoints[waypoints.length-1];
             waypoints.push([
               last[0] + (Math.random() * 0.02 - 0.01),
               last[1] + (Math.random() * 0.02 - 0.01)
             ]);
          }

          featureCollection.features.push({
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: waypoints
            },
            properties: {
              id: `player-${i}`,
              team: i % 2 === 0 ? 'red' : 'blue',
              startTime: startTime, 
              endTime: endTime      
            }
          });
        }

        ws.send(JSON.stringify({ 
          type: 'TRIP_UPDATE', 
          data: featureCollection 
        }));
      };

      // --- 4. Simulation Loops ---
      const syncInterval = setInterval(sendClockSync, SYNC_INTERVAL_MS);
      
      sendTrips(); 
      const tripInterval = setInterval(sendTrips, TRIP_INTERVAL_MS);

      const rateInterval = setInterval(() => {
        updateClock(); 
        
        if (playbackRate === 1.0) playbackRate = 20.0;      
        else if (playbackRate === 20.0) playbackRate = 0.5; 
        else playbackRate = 1.0;                           

        console.log(`[Server] Rate changed to ${playbackRate}x`);
        sendClockSync(); 
      }, RATE_CHANGE_MS);

      ws.data = { syncInterval, tripInterval, rateInterval };
    },

    message(ws, msg) {
      const message = JSON.parse(String(msg));
      if (message.type === 'SYNC_REQUEST') {
        ws.send(JSON.stringify({
          type: 'SYNC_RESPONSE',
          clientSendTime: message.clientSendTime,
          serverTime: Date.now(),
          rate: 1.0
        }));
      }
    },

    close(ws) {
      const d = ws.data as any;
      if (d) {
        clearInterval(d.syncInterval);
        clearInterval(d.tripInterval);
        clearInterval(d.rateInterval);
      }
    }
  },
});

console.log(`Time Server listening on ${server.hostname}:${server.port}`);
