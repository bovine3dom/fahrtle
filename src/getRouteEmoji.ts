export const getRouteEmoji = (type: number) => {
    // Extended GTFS
    if (type >= 100 && type <= 117) return '🚆'; // Rail
    if (type >= 200 && type <= 209) return '🚍'; // Coach
    if (type >= 400 && type <= 405) return '🚇'; // Subway/Metro
    if (type >= 700 && type <= 716) return '🚌'; // Bus
    if (type === 800) return '🚎';               // Trolleybus
    if (type >= 900 && type <= 906) return '🚋'; // Tram
    if (type === 1000 || type === 1200) return '⛴️'; // Ferry
    if (type === 1100) return '✈️';               // Air
    if (type >= 1300 && type <= 1307) return '🚠'; // Aerial Lift
    if (type === 1400) return '🚠';               // Funicular
    if (type >= 1500 && type <= 1507) return '🚕'; // Taxi
    if (type >= 1700) return '🐎';                // Misc

    // Standard GTFS
    switch (type) {
        case 0: return '🚋'; // Tram
        case 1: return '🚇'; // Subway
        case 2: return '🚆'; // Rail
        case 3: return '🚌'; // Bus
        case 4: return '⛴️'; // Ferry
        case 5: return '🚋'; // Cable Tram
        case 6: return '🚠'; // Aerial Lift
        case 7: return '🚠'; // Funicular
        case 11: return '🚎'; // Trolleybus
        case 12: return '🚝'; // Monorail
        default: return '🔘';
    }
};