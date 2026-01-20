# fahrtle

<p align="center">
  <img src="public/favicon.svg" width="128" height="128" alt="fahrtle logo">
</p>

fahrtle is a real-time multiplayer racing game built on global public transport data. Compete against friends to see who can navigate the world's transit networks most efficiently using real-world schedules and routes.

## Features

- **Real-time multiplayer**: Join rooms and race against other players in real-time.
- **Dynamic routing**: Use actual public transport departures.
- **Wide coverage**: Play anywhere we have pre-processed data for (which, last time, was, like, mid 2025)

## User guide

1. **Join a room**: Pick a room ID and a callsign. Once you're in the room, you can share the URL with your friends.
2. **Get ready**: Click the "Ready" button. Once everyone is ready, a 5-second countdown will start.
3. **Race**: 
    - Zoom in to see public transport stops. Click a stop to see upcoming departures. If you can't see a departure you're expecting, zoom in more - some stops are hidden.
    - Double-click a departure to board it.
    - If you want to get off early, click the "Get Off At" button in the bottom-left. This will stop you at the next scheduled stop.
    - You can "walk" to any point by double-clicking it.
    - Time advances for the benefit of the slowest player. If someone is lagging behind, encourage them to "Snooze".
4. **Win**: The first person to reach the target area wins!

## Tech stack

- **Mapping**: [MapLibre GL JS](https://maplibre.org/) with [H3](https://h3geo.org/) for proximity / containment calculations.
- **Data**: ClickHouse for querying large transport datasets, very badly documented on [gtfs_ffs](https://github.com/bovine3dom/gtfs_ffs)

## Development

### Prerequisites

You will need [Bun](https://bun.sh/) installed on your system. I suggest you use [entr](https://github.com/eradman/entr) too.

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   bun install
   ```

### Running locally

To start the development environment:

**Frontend (Vite):**
```bash
bun run dev
```

**Backend (Server):**
```bash
ls srv/* | entr -r bun run srv/server.ts
```

Then open `http://localhost:5173` in your browser. Vite will hot-reload changes _most_ of the time but you'll probably need to do a hard-reload from time to time with ctrl+shift+r in your browser.

## bovine3dom's todo-list

yeah this shouldn't be here. fight me

- walk /isocalc/ from e.g. st pancras to find every accessible h3 in europe and then paint that on the map somehow
    - done, but now need to work out some quick way of using that

- pick random h3s within that area as start/stops

- think about different game modes other than just race: tag? relay? 

- trophies? most modes of transport? highest max speed? most departures? opposites of that?
