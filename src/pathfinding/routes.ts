//------------------------------------------------------------------------------
// Nearest extinguisher for every firefighter, by walking distance (Dijkstra on
// the waypoint graph, stairs included), recomputed as they move.
//------------------------------------------------------------------------------
import { building, type ExtinguisherInfo } from "../building/building";
import { SIMULATION } from "../config";
import type { Person } from "../simulation/types";
import type { ExtinguisherRoute } from "../state/twinStore";
import { navGraph } from "./NavGraph";

const targets = new Map<number, ExtinguisherInfo>(building.extinguishers.map((e) => [e.nodeId, e]));
/** Walking speed used for the ETA when the firefighter is standing still (m/s). */
const NOMINAL_SPEED = 1.4;

export function nearestExtinguisherRoute(person: Person): ExtinguisherRoute | null {
    const r = navGraph.nearest({ floorId: person.floorId, p: person.position }, targets);
    if (!r) return null;
    const speed = person.speed > 0.3 ? person.speed : NOMINAL_SPEED;
    return {
        personId: person.id,
        extinguisherId: r.target.id,
        distance: r.path.length,
        eta: r.path.length / speed,
        points: r.path.points,
        inRange: r.path.length <= SIMULATION.routeMaxDistance,
    };
}

/** Recomputes a firefighter's route when they moved enough or after a delay. */
export class RouteTracker {
    #last = new Map<string, { at: number; p: [number, number, number] }>();

    update(people: Person[], current: Record<string, ExtinguisherRoute>): Record<string, ExtinguisherRoute> | null {
        const now = performance.now();
        let changed = false;
        const next = { ...current };
        for (const p of people) {
            if (p.role !== "firefighter") continue;
            if (!p.inside) {
                if (next[p.id]) {
                    delete next[p.id];
                    changed = true;
                }
                continue;
            }
            const last = this.#last.get(p.id);
            const moved = last ? Math.hypot(p.position[0] - last.p[0], p.position[1] - last.p[1], p.position[2] - last.p[2]) : Infinity;
            if (last && moved < SIMULATION.routeRecomputeDistance && now - last.at < SIMULATION.routeRecomputeMs) continue;
            this.#last.set(p.id, { at: now, p: [...p.position] });
            const route = nearestExtinguisherRoute(p);
            if (route) next[p.id] = route;
            else delete next[p.id];
            changed = true;
        }
        return changed ? next : null;
    }
}
