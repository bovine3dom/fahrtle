export const parseCoords = (s: string): [number, number] | null => {
    const parts = s.split(',');
    if (parts.length !== 2) return null;

    const latStr = parts[0].trim();
    const lngStr = parts[1].trim();

    // Prevent empty strings from becoming 0
    if (latStr === '' || lngStr === '') return null;

    const lat = Number(latStr);
    const lng = Number(lngStr);

    if (!isNaN(lat) && !isNaN(lng)) {
        return [lat, lng];
    }
    return null;
};

export const formatRowTime = (timeStr: string) => {
    if (!timeStr) return '--:--';
    try {
        if (timeStr.length >= 16) {
            return timeStr.substring(11, 16);
        }
        const d = new Date(timeStr);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (e) {
        return '--:--';
    }
};