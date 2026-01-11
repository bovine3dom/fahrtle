export type Position = [number, number];

/**
 * Global object storing current interpolated player positions.
 * This is a vanilla JS object for maximum performance during the animation loop.
 * Key: Player ID
 * Value: [longitude, latitude]
 */
export const playerPositions: Record<string, Position> = {};
