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

const CH_BASE_DATE = new Date('2026-01-01');
export const formatRowTime = (timeStr: string, showDays = false, baseDate = CH_BASE_DATE) => {
    if (!timeStr) return '--:--';
    try {
        if (timeStr.length >= 16) {
            const time = timeStr.substring(11, 16);
            if (showDays) {
                const date = new Date(timeStr);
                const dayDiff = Math.floor((date.getTime() - baseDate.getTime()) / (1000 * 60 * 60 * 24));
                if (dayDiff != 0) {
                    return `${time} ${Math.sign(dayDiff) >= 0 ? "+" : "" }${dayDiff}d`;
                }
            }
            return time;
        }
        const d = new Date(timeStr);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (e) {
        return '--:--';
    }
};

export const sensibleNumber = (x: number, precision = 2) => Number.parseFloat(x.toPrecision(precision)).toLocaleString('en-GB')
