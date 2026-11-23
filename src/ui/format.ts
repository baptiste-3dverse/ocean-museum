export const formatDistance = (m: number) => (m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`);

export function formatDuration(s: number): string {
    const t = Math.max(0, Math.round(s));
    if (t < 60) return `${t} s`;
    return `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, "0")} s`;
}

/** T+mm:ss */
export function formatElapsed(ms: number): string {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    return `${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const formatClock = (d: Date) => d.toLocaleTimeString("en-GB", { hour12: false });

/** Compass heading in degrees from a heading in radians (0 = facing -Z). */
export const formatHeading = (h: number) => `${String(Math.round(((((-h * 180) / Math.PI) % 360) + 360) % 360)).padStart(3, "0")}°`;
