import { useMemo, useState } from "react";
import { building } from "../building/building";
import { clearFire, fireLocations, setPlacingFire, triggerFire, triggerRandomFire } from "../state/controller";
import { useTwin } from "../state/twinStore";
import { flyTo } from "../twin3d/cameraRig";

export function IncidentControls() {
    const incident = useTwin((s) => s.incident);
    const placing = useTwin((s) => s.placingFire);
    const locations = useMemo(() => fireLocations(), []);
    const [choice, setChoice] = useState(locations[0]?.key ?? "");

    const fireAt = () => {
        const l = locations.find((x) => x.key === choice);
        if (!l) return;
        const f = triggerFire(l.floorId, l.p);
        flyTo(f.position, 18);
    };
    const random = () => flyTo(triggerRandomFire().position, 18);

    return (
        <section className="incident panel">
            <div className="panel__title">
                INCIDENT CONTROL <span className={incident ? "chip chip--fire" : "chip"}>{incident ? "ACTIVE" : "STANDBY"}</span>
            </div>
            <div className="incident__row">
                <button className="btn btn--fire" onClick={random}>
                    RANDOM FIRE
                </button>
                <button className={`btn ${placing ? "is-on" : ""}`} onClick={() => setPlacingFire(!placing)}>
                    {placing ? "CLICK IN 3D…" : "PLACE ON MAP"}
                </button>
            </div>
            <div className="incident__row">
                <select className="select" value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Fire location">
                    {building.floors.map((f) => (
                        <optgroup key={f.id} label={`${f.id} · ${f.label}`}>
                            {locations
                                .filter((l) => l.floorId === f.id)
                                .map((l) => (
                                    <option key={l.key} value={l.key}>
                                        {l.label}
                                    </option>
                                ))}
                        </optgroup>
                    ))}
                </select>
                <button className="btn" onClick={fireAt}>
                    TRIGGER
                </button>
            </div>
            {incident && (
                <button className="btn btn--ghost btn--wide" onClick={clearFire}>
                    CLEAR ALERT · ALL RETURN
                </button>
            )}
        </section>
    );
}
