//------------------------------------------------------------------------------
// Wires a people feed to the store, keeps the extinguisher routes up to date and
// exposes the user actions (fire alert, selection, filters).
//------------------------------------------------------------------------------
import { building, getFloor, isInsideSection, roomAt, roomLabel, type FloorId, type Vec3 } from "../building/building";
import { SIMULATION } from "../config";
import { navGraph } from "../pathfinding/NavGraph";
import { RouteTracker } from "../pathfinding/routes";
import type { FireIncident, PeopleFeed, Role } from "../simulation/types";
import { saveStyle, twinStore, type MarkerStyle } from "./twinStore";

let activeFeed: PeopleFeed | null = null;

export function startTwin(feed: PeopleFeed): () => void {
    activeFeed = feed;
    const tracker = new RouteTracker();
    const arrivals: number[] = [];
    twinStore.setState({ feedLabel: feed.label });
    const offStatus = feed.onStatus((feedStatus) => twinStore.setState({ feedStatus }));
    const offSnapshot = feed.subscribe((snapshot) => {
        const now = performance.now();
        arrivals.push(now);
        while (arrivals.length && now - arrivals[0] > 2000) arrivals.shift();
        const state = twinStore.getState();
        const routes = tracker.update(snapshot.people, state.routes);
        twinStore.setState({
            snapshot,
            receivedAt: now,
            feedRate: arrivals.length / 2,
            ...(routes ? { routes } : {}),
        });
    });
    feed.connect();
    return () => {
        offSnapshot();
        offStatus();
        feed.disconnect();
        activeFeed = null;
    };
}

//------------------------------------------------------------------------------
// Fire alert
//------------------------------------------------------------------------------
export function triggerFire(floorId: FloorId, position: Vec3): FireIncident {
    const floor = getFloor(floorId);
    const snapped = floor.grid.nearest(position[0], position[2], 4) ?? [position[0], position[2]];
    const p: Vec3 = [snapped[0], floor.y, snapped[1]];
    const incident: FireIncident = {
        id: `FIRE-${Date.now().toString(36).toUpperCase()}`,
        floorId,
        position: p,
        roomName: roomLabel(roomAt(floorId, p[0], p[2])),
        startedAt: Date.now(),
        radius: SIMULATION.dangerRadius,
    };
    twinStore.setState({ incident, placingFire: false });
    activeFeed?.setIncident?.(incident);
    return incident;
}

/** A fire in a random room inside the visible section. */
export function triggerRandomFire(): FireIncident {
    const candidates = navGraph.nodes.filter((n) => (n.kind === "room" || n.kind === "corridor") && isInsideSection(n.p));
    const n = candidates[Math.floor(Math.random() * candidates.length)];
    return triggerFire(n.floorId, n.p);
}

export function clearFire(): void {
    twinStore.setState({ incident: null, placingFire: false });
    activeFeed?.setIncident?.(null);
}

/** Rooms where a fire can be placed from the panel, one entry per named room. */
export function fireLocations(): Array<{ key: string; floorId: FloorId; label: string; p: Vec3 }> {
    const seen = new Set<string>();
    const out: Array<{ key: string; floorId: FloorId; label: string; p: Vec3 }> = [];
    for (const n of navGraph.nodes) {
        if ((n.kind !== "room" && n.kind !== "corridor") || !isInsideSection(n.p)) continue;
        const key = `${n.floorId}:${n.ref}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, floorId: n.floorId, label: n.ref.replace(":", " "), p: n.p });
    }
    const order = new Map(building.floors.map((f, i) => [f.id, i]));
    return out.sort((a, b) => order.get(a.floorId)! - order.get(b.floorId)! || a.label.localeCompare(b.label));
}

//------------------------------------------------------------------------------
// Selection & filters
//------------------------------------------------------------------------------
export function select(id: string | null): void {
    const { selectedId } = twinStore.getState();
    twinStore.setState({ selectedId: id === selectedId ? null : id, follow: false });
}

export function setRoleFilter(role: Role | null): void {
    twinStore.setState({ roleFilter: twinStore.getState().roleFilter === role ? null : role });
}

export function setPlacingFire(placingFire: boolean): void {
    twinStore.setState({ placingFire });
}

export function setFollow(follow: boolean): void {
    twinStore.setState({ follow });
}

export function setMarkerStyle(markerStyle: MarkerStyle): void {
    saveStyle(markerStyle);
    twinStore.setState({ markerStyle });
}

/** Isolates a floor (null: all floors). */
export function setFocusFloor(focusFloor: FloorId | null): void {
    twinStore.setState({ focusFloor });
}
