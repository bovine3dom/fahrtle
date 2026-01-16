import tzlookup from 'tz-lookup';

/**
 * Resolves the IANA timezone name for a given coordinate.
 */
export function getTimeZone(lat: number, lng: number): string {
    try {
        return tzlookup(lat, lng);
    } catch (e) {
        console.error('[Timezone] Lookup failed:', e);
        return 'Europe/Paris'; // Fallback
    }
}

/**
 * Formats a timestamp into a specific timezone.
 */
export function formatInTimeZone(timestamp: number, timeZone: string, showSeconds = false): string {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        second: showSeconds ? '2-digit' : undefined,
        hour12: false
    }).format(new Date(timestamp));
}

/**
 * Gets the numeric offset (in milliseconds) for a timezone relative to Europe/Paris
 * at a specific point in simulation time.
 * 
 * Logic: (LocalTime - ParisTime)
 */
export function getTimeZoneOffset(timestamp: number, targetZone: string): number {
    const parisTime = new Date(new Date(timestamp).toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const localTime = new Date(new Date(timestamp).toLocaleString('en-US', { timeZone: targetZone }));
    return localTime.getTime() - parisTime.getTime();
}

/**
 * Returns a stereotypical color for a given city/timezone.
 */
export function getTimeZoneColor(timeZone: string): string {
    const mapping: Record<string, string> = {
        'Europe/Paris': '#002654',     // Deep French Blue
        'Europe/London': '#E6272E',    // Post Box Red
        'Europe/Berlin': '#2d3436',    // Prussian Gray/Black
        'Europe/Rome': '#9e1b32',      // Deep Maroon/Terracotta
        'Europe/Madrid': '#fab1a0',    // Spanish Orange/Peach
        'Europe/Athens': '#0984e3',    // Aegean Blue
        'Europe/Dublin': '#009432',    // Shamrock Green
        'Europe/Amsterdam': '#f39c12', // Dutch Orange
        'Europe/Brussels': '#2f3640',  // Belgian Dark
        'Europe/Vienna': '#c0392b',    // Austrian Red
        'Europe/Prague': '#8e44ad',    // Royal Purple (Velvet Revolution)
        'Europe/Warsaw': '#ea2027',    // Polish Red
        'Europe/Budapest': '#20bf6b',  // Hungarian Green
        'Europe/Copenhagen': '#ff4757', // Danish Red
        'Europe/Stockholm': '#1e90ff', // Swedish Blue
        'Europe/Oslo': '#ee5253',      // Norwegian Red
        'Europe/Helsinki': '#341f97',  // Finnish Blue

        'America/New_York': '#f7b731', // Taxi Yellow
        'America/Chicago': '#4b4b4b',  // Industrial Gray
        'America/Los_Angeles': '#ff9f43', // Sunset Orange
        'America/Toronto': '#eb4d4b',  // Maple Red
        'America/Mexico_City': '#10ac84', // Mexican Green
        'America/Argentina/Buenos_Aires': '#74b9ff', // Celeste
        'America/Sao_Paulo': '#26de81', // Brazilian Green

        'Asia/Tokyo': '#ffafbd',       // Cherry Blossom Pink
        'Asia/Seoul': '#ff5252',       // South Korean Red
        'Asia/Shanghai': '#ee5253',    // Crimson Red
        'Asia/Hong_Kong': '#ff9ff3',   // Neon Pink/Purple
        'Asia/Singapore': '#10ac84',   // Garden City Green
        'Asia/Dubai': '#d4af37',       // Desert Gold
        'Asia/Riyadh': '#27ae60',      // Saudi Green
        'Asia/Kolkata': '#e67e22',     // Saffron

        'Australia/Sydney': '#0984e3', // Harbour Blue
        'Australia/Melbourne': '#2d3436', // Melbourne Black
        'Pacific/Auckland': '#222f3e', // All Blacks Navy
        'Atlantic/Reykjavik': '#a5f2f3', // Ice Blue
    };

    // Match exact or prefix (e.g., America/Argentina/...)
    if (mapping[timeZone]) return mapping[timeZone];

    // Check for region-wide fallbacks if specific city isn't found
    const region = timeZone.split('/')[0];
    const regionMapping: Record<string, string> = {
        'Africa': '#576574',
        'America': '#54a0ff',
        'Asia': '#ff6b6b',
        'Australia': '#48dbfb',
        'Europe': '#1dd1a1',
        'Pacific': '#48dbfb',
        'Antarctica': '#c8d6e5'
    };

    return regionMapping[region] || '#1e293b'; // Default dark
}

/**
 * Returns a standard ISO 639-1 language code (e.g., 'fr', 'en', 'ja') 
 * for a given timezone.
 */
export function getTimeZoneLanguage(timeZone: string): string {
    const mapping: Record<string, string> = {
        // --- EUROPE ---
        'Europe/Paris': 'fr',
        'Europe/London': 'en',
        'Europe/Berlin': 'de',
        'Europe/Vienna': 'de',
        'Europe/Zurich': 'de',
        'Europe/Rome': 'it',
        'Europe/Madrid': 'es',
        'Europe/Lisbon': 'pt',
        'Europe/Athens': 'el',
        'Europe/Dublin': 'en',
        'Europe/Amsterdam': 'nl',
        'Europe/Brussels': 'fr', 
        'Europe/Prague': 'cs',
        'Europe/Warsaw': 'pl',
        'Europe/Budapest': 'hu',
        'Europe/Copenhagen': 'da',
        'Europe/Stockholm': 'sv',
        'Europe/Oslo': 'no',
        'Europe/Helsinki': 'fi',
        'Europe/Moscow': 'ru',
        'Europe/Volgograd': 'ru',
        'Europe/Samara': 'ru',
        'Europe/Kiev': 'uk',
        'Europe/Kyiv': 'uk', // Modern spelling
        'Europe/Bucharest': 'ro',
        'Europe/Istanbul': 'tr',
        'Europe/Minsk': 'ru', // or 'be'

        // --- AMERICAS ---
        'America/New_York': 'en',
        'America/Chicago': 'en',
        'America/Los_Angeles': 'en',
        'America/Toronto': 'en',
        'America/Vancouver': 'en',
        'America/Mexico_City': 'es',
        'America/Bogota': 'es',
        'America/Lima': 'es',
        'America/Santiago': 'es',
        'America/Caracas': 'es',
        'America/La_Paz': 'es',
        'America/Montevideo': 'es',
        'America/Argentina/Buenos_Aires': 'es',
        'America/Sao_Paulo': 'pt',
        'America/Rio_De_Janeiro': 'pt',
        'America/Montreal': 'fr',

        // --- ASIA ---
        'Asia/Tokyo': 'ja',
        'Asia/Seoul': 'ko',
        'Asia/Shanghai': 'zh',
        'Asia/Hong_Kong': 'zh',
        'Asia/Taipei': 'zh',
        'Asia/Singapore': 'en', 
        'Asia/Kuala_Lumpur': 'ms',
        'Asia/Manila': 'en', // English is official for transport, or 'tl'
        'Asia/Bangkok': 'th',
        'Asia/Ho_Chi_Minh': 'vi',
        'Asia/Jakarta': 'id',
        'Asia/Dubai': 'ar',
        'Asia/Riyadh': 'ar',
        'Asia/Kolkata': 'hi',
        'Asia/Jerusalem': 'he',

        // --- OCEANIA ---
        'Australia/Sydney': 'en',
        'Australia/Melbourne': 'en',
        'Australia/Brisbane': 'en',
        'Australia/Perth': 'en',
        'Pacific/Auckland': 'en',

        // --- AFRICA ---
        'Africa/Cairo': 'ar',
        'Africa/Johannesburg': 'en',
        'Africa/Lagos': 'en',
        'Africa/Nairobi': 'en',
        'Africa/Casablanca': 'ar', // or fr

        // --- ATLANTIC ---
        'Atlantic/Reykjavik': 'is',
        'Atlantic/Azores': 'pt',
    };

    if (mapping[timeZone]) return mapping[timeZone];
    return 'en';
}

export const departuresLabels: Record<string, string> = {
    // Western/Central Europe
    'en': 'Departures',      // English
    'fr': 'Départs',         // French
    'de': 'Abfahrt',         // German
    'it': 'Partenze',        // Italian
    'es': 'Salidas',         // Spanish
    'pt': 'Partidas',        // Portuguese
    'nl': 'Vertrek',         // Dutch
    
    // Nordic
    'da': 'Afgang',          // Danish
    'sv': 'Avgång',          // Swedish
    'no': 'Avganger',        // Norwegian
    'fi': 'Lähtevät',        // Finnish
    'is': 'Brottfarir',      // Icelandic

    // Eastern Europe / Russia
    'el': 'Αναχωρήσεις',     // Greek
    'cs': 'Odjezdy',         // Czech
    'pl': 'Odjazdy',         // Polish
    'hu': 'Indulás',         // Hungarian
    'ru': 'Отправление',     // Russian (Otpravlenie)
    'uk': 'Відправлення',    // Ukrainian (Vidpravlennya)
    'ro': 'Plecări',         // Romanian
    'tr': 'Kalkış',          // Turkish

    // Middle East / Africa
    'ar': 'المغادرة',        // Arabic
    'he': 'יציאות',          // Hebrew (Yetsiot)

    // Asia
    'ja': '出発',            // Japanese
    'ko': '출발',            // Korean
    'zh': '出发',            // Chinese (Simplified)
    'hi': 'प्रस्थान',        // Hindi
    'th': 'ขาออก',           // Thai (Kha Ok)
    'vi': 'Khởi hành',       // Vietnamese (Khoi hanh)
    'id': 'Keberangkatan',   // Indonesian
    'ms': 'Pelepasan',       // Malay
};

export function getDepartureLabel(langCode: string): string {
    const normalizedLang = langCode.split('-')[0].toLowerCase();
    return departuresLabels[normalizedLang] || 'Departures';
}
