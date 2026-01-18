export function formatDuration(ms: number) {
    if (ms < 0) return "0s";
    const seconds = Math.floor(ms / 1000);
    const m = Math.floor(seconds / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    const w = Math.floor(d / 7);

    const parts = [];
    if (w > 0) parts.push(`${w}w`);
    if (d % 7 > 0) parts.push(`${d % 7}d`);
    if (h % 24 > 0) parts.push(`${h % 24}h`);
    if (m % 60 > 0) parts.push(`${m % 60}m`);
    parts.push(`${seconds % 60}s`);

    return parts.join(' ');
}

// convert clickhouse string of format "YYYY-MM-DD HH:MM:SS" to milliseconds since epoch in UTC
export function parseDBTime(dbString: string, timeZone: string): number {
    if (!dbString) return 0;

    const iso = dbString.replace(' ', 'T');
    const naive = new Date(iso + "Z");

    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
        hour12: false
    });

    const parts = formatter.formatToParts(naive);
    const p: any = {};
    parts.forEach(({ type, value }) => p[type] = value);

    const wallTimeInTarget = new Date(Date.UTC(
        parseInt(p.year),
        parseInt(p.month) - 1,
        parseInt(p.day),
        parseInt(p.hour),
        parseInt(p.minute),
        parseInt(p.second)
    ));

    const offset = wallTimeInTarget.getTime() - naive.getTime();

    return naive.getTime() - offset;
}

export function getWallSeconds(timestamp: number, timeZone: string): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: 'numeric', minute: 'numeric', second: 'numeric',
        hour12: false
    });
    const parts = formatter.formatToParts(new Date(timestamp));
    const p: any = {};
    parts.forEach(({ type, value }) => p[type] = parseInt(value));
    return (p.hour % 24) * 3600 + p.minute * 60 + p.second;
}

export function parseUserTime(timeString: string, timeZone: string): number | null {
    if (!/^\d{1,2}:\d{2}$/.test(timeString)) return null; // "HH:MM"

    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour12: false
    });

    const datePart = formatter.format(new Date());
    const [h, m] = timeString.split(':');
    const paddedTime = `${h.padStart(2, '0')}:${m}`;
    const dbString = `${datePart} ${paddedTime}:00`;
    return parseDBTime(dbString, timeZone);
}
