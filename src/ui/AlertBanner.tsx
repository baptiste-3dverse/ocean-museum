import { getFloor } from "../building/building";
import { clearFire } from "../state/controller";
import { useTwin } from "../state/twinStore";
import { flyTo } from "../twin3d/cameraRig";
import { formatElapsed } from "./format";
import { useNow } from "./useNow";

export function AlertBanner() {
    const incident = useTwin((s) => s.incident);
    const responders = useTwin((s) => s.snapshot.people.filter((p) => p.role === "firefighter" && p.status === "on scene").length);
    const crew = useTwin((s) => s.snapshot.people.filter((p) => p.role === "firefighter").length);
    const evacuating = useTwin((s) => s.snapshot.people.filter((p) => p.status === "evacuating").length);
    const now = useNow(250);
    if (!incident) return null;
    const floor = getFloor(incident.floorId);
    return (
        <div className="alert" role="alert">
            <div className="alert__pulse" />
            <div className="alert__main" onClick={() => flyTo(incident.position, 16)}>
                <span className="alert__tag">FIRE ALERT</span>
                <span className="alert__field">
                    <em>FLOOR</em>
                    {incident.floorId} · {floor.label}
                </span>
                <span className="alert__field">
                    <em>ROOM</em>
                    {incident.roomName}
                </span>
                <span className="alert__field alert__timer">
                    <em>T+</em>
                    {formatElapsed(now - incident.startedAt)}
                </span>
                <span className="alert__field">
                    <em>ON SCENE</em>
                    {responders}/{crew}
                </span>
                <span className="alert__field">
                    <em>EVACUATING</em>
                    {evacuating}
                </span>
            </div>
            <button className="btn btn--ghost" onClick={clearFire}>
                CLEAR
            </button>
        </div>
    );
}
