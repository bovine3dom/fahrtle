type RouteTypeRange = number | [number, number];
type RouteTypeConfig = { emoji: string; ranges: RouteTypeRange[] };

const routeTypeConfigs: Record<string, RouteTypeConfig> = {
    rail: { emoji: '🚆', ranges: [2, [100, 117]] },
    coach: { emoji: '🚍', ranges: [[200, 209]] },
    subway: { emoji: '🚇', ranges: [1, [400, 404]] },
    bus: { emoji: '🚌', ranges: [3, [700, 716]] },
    trolleybus: { emoji: '🚎', ranges: [11, 800] },
    tram: { emoji: '🚋', ranges: [0, 5, [900, 906]] },
    ferry: { emoji: '🚢', ranges: [4, 1000, 1200] },
    air: { emoji: '🛫', ranges: [1100] },
    aerialLift: { emoji: '🚠', ranges: [6, [1300, 1307], 7, 1400] },
    taxi: { emoji: '🚕', ranges: [[1500, 1507]] },
    misc: { emoji: '🐎', ranges: [[1700, 9999]] },
    monorail: { emoji: '🚝', ranges: [12, 405] }
};

type RouteType = keyof typeof routeTypeConfigs;

export const emojiToRouteType: Record<string, RouteType | 'walking'> = {
    '🚆': 'rail',
    '🚍': 'coach',
    '🚇': 'subway',
    '🚌': 'bus',
    '🚎': 'trolleybus',
    '🚋': 'tram',
    '🚢': 'ferry',
    '🛫': 'air',
    '🚠': 'aerialLift',
    '🚕': 'taxi',
    '🚝': 'monorail',
    '🐎': 'misc',
    '🐾': 'walking',
    '👽': 'misc', // unknown/alien types go to misc
};

// Emissions in gCO2e per passenger-kilometre
export const routeTypeEmissions: Record<RouteType | 'walking', number> = {
    rail: 4.5, // assuming electric
    coach: 27,
    subway: 28, // assuming dirty grid
    bus: 97,
    trolleybus: 30,
    tram: 29,
    ferry: 113,
    air: 280,
    aerialLift: 15,
    taxi: 150,
    monorail: 30,
    misc: 300, // it's probably a norwegian PSO flight
    walking: 80, // assuming meat-eater, 2g/kcal, 40kcal/km
};

export const getRouteEmoji = (type: number) => {
    for (const config of Object.values(routeTypeConfigs)) {
        for (const range of config.ranges) {
            if (typeof range === 'number') {
                if (type === range) return config.emoji;
            } else {
                if (type >= range[0] && type <= range[1]) return config.emoji;
            }
        }
    }
    return '👽';
};

// e.g. getClickHouseRouteTypeBetweens(['tram', 'bus']) => "route_type IN (0, 5, 3) OR (route_type BETWEEN 900 AND 906) OR (route_type BETWEEN 700 AND 716)"
// ... unused but it was annoying to write so let's see if we need it again
//
// const getClickHouseRouteTypeBetweens = (types: RouteType[]) => {
//     const parts: string[] = [];
//     const singles: number[] = [];

//     for (const type of types) {
//         const config = routeTypeConfigs[type];
//         if (!config) continue;

//         for (const range of config.ranges) {
//             if (typeof range === 'number') {
//                 singles.push(range);
//             } else {
//                 parts.push(`(route_type BETWEEN ${range[0]} AND ${range[1]})`);
//             }
//         }
//     }

//     if (singles.length > 0) {
//         parts.unshift(`route_type IN (${singles.join(', ')})`);
//     }

//     if (parts.length === 0) return '1=1';

//     return parts.join(' OR ');
// };
