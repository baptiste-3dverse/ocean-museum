import { useMemo, useState, type CSSProperties } from "react";
import { building, getFloor } from "../building/building";
import { navGraph } from "../pathfinding/NavGraph";
import { select, setFollow, setRoleFilter } from "../state/controller";
import { useTwin } from "../state/twinStore";
import { ROLES, type Person, type Role } from "../simulation/types";
import { flyTo } from "../twin3d/cameraRig";
import { FaIcon } from "./icons/FaIcon";
import { ICONS, ROLE_ICON } from "./icons/icons";
import { ROLE_COLOR } from "../twin3d/TwinRenderer";
import { formatDistance, formatDuration } from "./format";

const ROLE_LABEL: Record<Role, string> = { visitor: "Visitor", staff: "Staff", security: "Security", medic: "Medic", firefighter: "Firefighter" };
const FLOOR_ORDER = new Map(building.floors.map((f, i) => [f.id, i]));

export function SidePanel() {
    const [tab, setTab] = useState<"people" | "extinguishers">("people");
    const inside = useTwin((s) => s.snapshot.people.filter((p) => p.inside).length);
    return (
        <aside className="side panel">
            <div className="tabs">
                <button className={`tab ${tab === "people" ? "is-active" : ""}`} onClick={() => setTab("people")}>
                    OCCUPANTS <span className="tab__count">{inside}</span>
                </button>
                <button className={`tab ${tab === "extinguishers" ? "is-active" : ""}`} onClick={() => setTab("extinguishers")}>
                    EXTINGUISHERS <span className="tab__count">{building.extinguishers.length}</span>
                </button>
            </div>
            {tab === "people" ? <PeopleList /> : <ExtinguisherList />}
        </aside>
    );
}

function PeopleList() {
    const people = useTwin((s) => s.snapshot.people);
    const filter = useTwin((s) => s.roleFilter);
    const selectedId = useTwin((s) => s.selectedId);
    const following = useTwin((s) => s.follow);
    const routes = useTwin((s) => s.routes);

    const inside = useMemo(() => people.filter((p) => p.inside), [people]);
    const counts = useMemo(() => {
        const c = Object.fromEntries(ROLES.map((r) => [r, 0])) as Record<Role, number>;
        for (const p of inside) c[p.role]++;
        return c;
    }, [inside]);
    const evacuated = people.length - inside.length;
    const rows = useMemo(
        () => inside.filter((p) => !filter || p.role === filter).sort((a, b) => ROLES.indexOf(b.role) - ROLES.indexOf(a.role) || FLOOR_ORDER.get(a.floorId)! - FLOOR_ORDER.get(b.floorId)! || a.name.localeCompare(b.name)),
        [inside, filter],
    );

    return (
        <>
            <div className="roles">
                {ROLES.map((r) => (
                    <button key={r} className={`role-chip ${filter === r ? "is-active" : ""} ${filter && filter !== r ? "is-dim" : ""}`} style={{ "--c": ROLE_COLOR[r] } as CSSProperties} onClick={() => setRoleFilter(r)} title={`Show only: ${ROLE_LABEL[r]}`}>
                        <FaIcon icon={ROLE_ICON[r]} size={13} className="role-chip__icon" />
                        <span className="role-chip__label">{ROLE_LABEL[r]}</span>
                        <span className="role-chip__count">{counts[r]}</span>
                    </button>
                ))}
            </div>
            {evacuated > 0 && <div className="note">{evacuated} evacuated — outside the building</div>}
            <div className="table-head">
                <span>NAME</span>
                <span>ROLE</span>
                <span>FLR</span>
                <span>STATUS</span>
            </div>
            <ul className="rows">
                {rows.map((p) => (
                    <PersonRow key={p.id} p={p} selected={p.id === selectedId} following={following} route={routes[p.id]} />
                ))}
                {!rows.length && <li className="empty">Nobody inside for this role.</li>}
            </ul>
        </>
    );
}

function PersonRow({ p, selected, following, route }: { p: Person; selected: boolean; following: boolean; route?: { extinguisherId: string; distance: number; eta: number; inRange: boolean } }) {
    const alert = p.status === "evacuating" || p.status === "en route" || p.status === "responding" || p.status === "on scene";
    return (
        <li className={`row ${selected ? "is-selected" : ""}`} style={{ "--c": ROLE_COLOR[p.role] } as CSSProperties}>
            <button className="row__main" onClick={() => select(p.id)}>
                <span className="row__name">
                    <FaIcon icon={ROLE_ICON[p.role]} size={11} className="row__icon" />
                    {p.callsign ? <b>{p.callsign} </b> : null}
                    {p.name}
                </span>
                <span className="row__role">{ROLE_LABEL[p.role]}</span>
                <span className="row__floor">{p.floorId}</span>
                <span className={`row__status ${alert ? "is-alert" : ""}`}>{p.status}</span>
            </button>
            {selected && (
                <div className="row__detail">
                    <span>
                        {getFloor(p.floorId).label} · y {p.position[1].toFixed(2)} m · {p.speed.toFixed(1)} m/s
                    </span>
                    {route && (
                        <span className={route.inRange ? "is-route" : "is-far"}>
                            <FaIcon icon={ICONS.extinguisher} size={10} /> {route.extinguisherId} · {formatDistance(route.distance)} walk · ETA {formatDuration(route.eta)}
                            {!route.inRange && " (beyond 20 m)"}
                        </span>
                    )}
                    <span className="row__actions">
                        <button className={`btn btn--tiny ${following ? "is-on" : ""}`} onClick={() => setFollow(!following)}>
                            {following ? "FOLLOWING" : "FOLLOW"}
                        </button>
                        {p.role === "firefighter" && <span className="hint">Body cam open ↙</span>}
                    </span>
                </div>
            )}
        </li>
    );
}

function ExtinguisherList() {
    const routes = useTwin((s) => s.routes);
    const people = useTwin((s) => s.snapshot.people);
    const claimed = useMemo(() => {
        const m = new Map<string, string[]>();
        for (const r of Object.values(routes)) {
            if (!r.inRange) continue;
            const cs = people.find((p) => p.id === r.personId)?.callsign ?? r.personId;
            m.set(r.extinguisherId, [...(m.get(r.extinguisherId) ?? []), cs]);
        }
        return m;
    }, [routes, people]);
    return (
        <ul className="rows rows--ext">
            {building.floors.map((f) => (
                <li key={f.id} className="group">
                    <div className="group__title">
                        {f.id} · {f.label} <span>y {f.y.toFixed(2)} m</span>
                    </div>
                    {building.extinguishers
                        .filter((e) => e.floorId === f.id)
                        .map((e) => (
                            <button key={e.id} className="ext" onClick={() => flyTo(e.position, 9)}>
                                <span className="ext__icon">
                                    <FaIcon icon={ICONS.extinguisher} size={13} />
                                </span>
                                <span className="ext__id">{e.id}</span>
                                <span className="ext__where">
                                    {e.spot === "stairs" ? "Stairs" : e.spot === "exit" ? "Exit" : "Corridor end"} · {e.near.replace(":", " ")}
                                </span>
                                <span className="ext__agent">{e.agent}</span>
                                {claimed.get(e.id) && <span className="ext__claimed">{claimed.get(e.id)!.join(", ")} →</span>}
                            </button>
                        ))}
                </li>
            ))}
            <li className="note">Positions computed from the IFC geometry: next to stair exits, corridor ends and exterior doors, on the nearest wall. Graph: {navGraph.nodes.length} nodes.</li>
        </ul>
    );
}

