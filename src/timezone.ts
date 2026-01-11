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
