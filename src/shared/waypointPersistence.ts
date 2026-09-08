import type { Waypoint } from './gameLogic';

export function restoreStoredWaypoints(stored: Waypoint[] | { version: 1; waypoints: Waypoint[] }): Waypoint[] {
    if (!Array.isArray(stored)) return stored.waypoints;
    // Legacy saves omitted interstop points. Reproduce the old renderer's continuity
    // between retained stops, while keeping the wait before the first movement.
    return stored.map((waypoint, index) => index < 2 ? waypoint : {
        ...waypoint, startTime: stored[index - 1].arrivalTime,
    });
}
