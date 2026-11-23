import { building } from "../building/building";
import { useTwin } from "../state/twinStore";
import { formatClock } from "./format";
import { useNow } from "./useNow";

export function TopBar() {
    const now = useNow();
    const status = useTwin((s) => s.feedStatus);
    const label = useTwin((s) => s.feedLabel);
    const rate = useTwin((s) => s.feedRate);
    const inside = useTwin((s) => s.snapshot.people.filter((p) => p.inside).length);
    const incident = useTwin((s) => s.incident);
    const live = status === "live";

    return (
        <header className="topbar panel">
            <div className="topbar__brand">
                <span className="brand-mark" />
                <div>
                    <div className="topbar__title">OCEAN MUSEUM · FIRE RESPONSE TWIN</div>
                    <div className="topbar__sub">
                        IFC {building.source.entities.toLocaleString("en")} entities · {building.floors.length} levels simulated · section cut N
                    </div>
                </div>
            </div>
            <div className="topbar__stats">
                <Stat label="INSIDE" value={String(inside)} />
                <Stat label="STATUS" value={incident ? "ALERT" : "NOMINAL"} tone={incident ? "fire" : "ok"} />
                <Stat label="FEED" value={`${rate.toFixed(1)} Hz`} className="w-[8ch]" />
            </div>
            <div className="topbar__right">
                <span className={`live ${live ? "is-live" : ""}`}>
                    <span className="live__dot" />
                    {live ? "LIVE" : status.toUpperCase()}
                </span>
                <span className="topbar__feed">{label}</span>
                <span className="clock">{formatClock(new Date(now))}</span>
            </div>
        </header>
    );
}

function Stat({ label, value, tone, className }: { label: string; value: string; tone?: "fire" | "ok"; className?: string }) {
    return (
        <div className={`stat ${tone ? `stat--${tone}` : ""} ${className}`}>
            <span className="stat__label">{label}</span>
            <span className="stat__value">{value}</span>
        </div>
    );
}
