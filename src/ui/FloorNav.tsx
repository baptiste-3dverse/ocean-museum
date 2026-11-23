import type { CSSProperties } from "react";
import { building } from "../building/building";
import { COLORS } from "../config";
import { setFocusFloor, setMarkerStyle } from "../state/controller";
import { useTwin } from "../state/twinStore";
import { focusFloor as cameraToFloor, overview } from "../twin3d/cameraRig";
import { ROLE_COLOR } from "../twin3d/TwinRenderer";
import { FaIcon } from "./icons/FaIcon";
import { ICONS, ROLE_ICON } from "./icons/icons";

export function FloorNav() {
    const people = useTwin((s) => s.snapshot.people);
    const incident = useTwin((s) => s.incident);
    const focus = useTwin((s) => s.focusFloor);
    const style = useTwin((s) => s.markerStyle);

    const showAll = () => {
        setFocusFloor(null);
        overview();
    };
    const isolate = (id: string) => {
        if (focus === id) return showAll();
        setFocusFloor(id);
        cameraToFloor(id);
    };

    return (
        <nav className="floors panel">
            <div className="panel__title">LEVELS</div>
            <button className={`floor floor--all ${!focus ? "is-active" : ""}`} onClick={showAll}>
                <span className="floor__id">ALL</span>
                <span className="floor__label">Section overview</span>
            </button>
            {building.floors.map((f) => {
                const count = people.filter((p) => p.inside && p.floorId === f.id).length;
                const fire = incident?.floorId === f.id;
                return (
                    <button key={f.id} className={`floor ${fire ? "is-fire" : ""} ${focus === f.id ? "is-active" : ""}`} onClick={() => isolate(f.id)} title={focus === f.id ? "Show all floors" : `Isolate ${f.label}`}>
                        <span className="floor__id">{f.id}</span>
                        <span className="floor__label">{f.label}</span>
                        <span className="floor__y">
                            {f.y >= 0 ? "+" : ""}
                            {f.y.toFixed(2)} m
                        </span>
                        <span className="floor__count">{count}</span>
                    </button>
                );
            })}

            <div className="panel__title panel__title--sub">MARKERS</div>
            <div className="segmented" role="radiogroup" aria-label="Marker style">
                <button role="radio" aria-checked={style === "pin"} className={style === "pin" ? "is-on" : ""} onClick={() => setMarkerStyle("pin")}>
                    <FaIcon icon={ICONS.pin} size={11} /> PIN
                </button>
                <button role="radio" aria-checked={style === "frame"} className={style === "frame" ? "is-on" : ""} onClick={() => setMarkerStyle("frame")}>
                    <FaIcon icon={ICONS.frame} size={11} /> FRAME
                </button>
            </div>

            <div className="legend">
                {(["firefighter", "visitor", "staff", "security", "medic"] as const).map((r) => (
                    <span key={r} className="legend__item" style={{ "--c": ROLE_COLOR[r] } as CSSProperties}>
                        <FaIcon icon={ROLE_ICON[r]} size={10} className="legend__icon" />
                        {r[0].toUpperCase() + r.slice(1)}
                    </span>
                ))}
                <span className="legend__item" style={{ "--c": COLORS.fire } as CSSProperties}>
                    <FaIcon icon={ICONS.fire} size={10} className="legend__icon" />
                    Fire
                </span>
                <span className="legend__item legend__item--wide" style={{ "--c": COLORS.extinguisher } as CSSProperties}>
                    <FaIcon icon={ICONS.extinguisher} size={10} className="legend__icon" />
                    Extinguisher / route
                </span>
                <span className="legend__item">
                    <span className="legend__solid" /> In view
                </span>
                <span className="legend__item" title="Hidden behind walls or floors">
                    <span className="legend__dashed" /> Behind walls
                </span>
            </div>
        </nav>
    );
}
