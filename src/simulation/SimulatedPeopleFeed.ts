//------------------------------------------------------------------------------
// Simulated people feed.
//
// Every person is an agent that walks along paths of the waypoint graph (so along
// corridors, through doors and up and down stairs, never through walls or
// floors), at a realistic walking speed, and publishes its position 10 times per
// second. It implements the same PeopleFeed interface as a real feed would.
//------------------------------------------------------------------------------
import { building, isInsideSection, type FloorId, type NavNode, type Vec3 } from "../building/building";
import { navGraph, type Location, type PathPoint } from "../pathfinding/NavGraph";
import { SIMULATION } from "../config";
import { ROSTER } from "./roster";
import type { FeedStatus, FireIncident, PeopleFeed, PeopleSnapshot, Person, PersonStatus, Role } from "./types";

type Mode = "wander" | "idle" | "evacuate" | "outside" | "respond" | "hold" | "return";

interface Agent {
    person: Person;
    mode: Mode;
    path: PathPoint[];
    next: number;
    wait: number;
    baseSpeed: number;
    home: NavNode;
    /** Status to show when the current path is done. */
    arrivedStatus?: PersonStatus;
    /** Speed for the current path when it is not the walking speed (jogging to a fire). */
    speedOverride?: number;
}

/** Deterministic random numbers (mulberry32), so a demo can be replayed with ?seed=… */
function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const WALK_SPEED: Record<Role, [number, number]> = {
    visitor: [0.85, 1.25],
    staff: [1.2, 1.4],
    security: [1.3, 1.45],
    medic: [1.3, 1.45],
    firefighter: [1.25, 1.4],
};
/** Firefighters and responders jog when called (m/s). */
const RESPONSE_SPEED = 2.4;
/** Stairs are walked more slowly (fraction of the walking speed along the flight). */
const STAIR_FACTOR = 0.6;

const nearestFloor = (y: number): FloorId => building.floors.reduce((a, b) => (Math.abs(b.y - y) < Math.abs(a.y - y) ? b : a)).id;

export class SimulatedPeopleFeed implements PeopleFeed {
    readonly kind = "simulation";
    readonly label = `Simulation · ${SIMULATION.tickHz} Hz`;

    readonly #rand: () => number;
    readonly #agents: Agent[] = [];
    readonly #listeners = new Set<(s: PeopleSnapshot) => void>();
    readonly #statusListeners = new Set<(s: FeedStatus) => void>();
    readonly #walkNodes: NavNode[];
    #timer: ReturnType<typeof setInterval> | null = null;
    #last = 0;
    #incident: FireIncident | null = null;

    constructor(seed = 7) {
        this.#rand = rng(seed);
        this.#walkNodes = navGraph.nodes.filter((n) => n.kind === "room" || n.kind === "corridor");
        for (const r of ROSTER) {
            const home = r.role === "firefighter" ? this.#firefighterHome(r.id) : r.role === "medic" ? this.#pick({ floorId: "R0" }) : this.#pick({});
            const [lo, hi] = WALK_SPEED[r.role];
            const agent: Agent = {
                person: {
                    ...r,
                    floorId: home.floorId,
                    position: [...home.p],
                    heading: this.#rand() * Math.PI * 2,
                    speed: 0,
                    status: this.#idleStatus(r.role),
                    inside: true,
                },
                mode: "idle",
                path: [],
                next: 0,
                wait: this.#rand() * 3,
                baseSpeed: lo + this.#rand() * (hi - lo),
                home,
            };
            this.#agents.push(agent);
        }
    }

    connect(): void {
        if (this.#timer) return;
        this.#last = performance.now();
        this.#timer = setInterval(() => this.#tick(), 1000 / SIMULATION.tickHz);
        this.#statusListeners.forEach((l) => l("live"));
        this.#emit();
    }

    disconnect(): void {
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = null;
        this.#statusListeners.forEach((l) => l("offline"));
    }

    subscribe(listener: (s: PeopleSnapshot) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    onStatus(listener: (s: FeedStatus) => void): () => void {
        this.#statusListeners.add(listener);
        listener(this.#timer ? "live" : "connecting");
        return () => this.#statusListeners.delete(listener);
    }

    //--------------------------------------------------------------------------
    // Incident reactions
    //--------------------------------------------------------------------------
    setIncident(incident: FireIncident | null): void {
        const previous = this.#incident;
        this.#incident = incident;
        if (incident) {
            for (const a of this.#agents) this.#respond(a, incident);
        } else if (previous) {
            for (const a of this.#agents) this.#standDown(a);
        }
    }

    #respond(a: Agent, fire: FireIncident): void {
        const loc = this.#loc(a);
        const fireLoc: Location = { floorId: fire.floorId, p: fire.position };
        switch (a.person.role) {
            case "visitor":
            case "staff": {
                if (!a.person.inside) return;
                const exits = new Map(building.exits.map((e) => [e.nodeId, e]));
                const r = navGraph.nearest(loc, exits);
                if (r) this.#go(a, r.path.points, "evacuate", "evacuating", "evacuated", RESPONSE_SPEED * 0.6);
                return;
            }
            case "firefighter": {
                const p = navGraph.findPath(loc, fireLoc);
                if (p) this.#go(a, this.#stopShort(p.points, 2.2), "respond", "en route", "on scene", RESPONSE_SPEED);
                return;
            }
            case "security": {
                // hold a cordon at the edge of the danger area, on the fire's floor
                const ring = navGraph
                    .nodesOf(fire.floorId)
                    .filter((n) => n.kind !== "stair")
                    .map((n) => ({ n, d: Math.hypot(n.p[0] - fire.position[0], n.p[2] - fire.position[2]) }))
                    .filter((c) => c.d > fire.radius + 1.5 && c.d < fire.radius + 9)
                    .sort((x, y) => x.d - y.d);
                const target = ring[Math.floor(this.#rand() * Math.min(4, ring.length))]?.n;
                const p = target ? navGraph.findPath(loc, { floorId: target.floorId, p: target.p }) : null;
                if (p) this.#go(a, p.points, "respond", "responding", "cordon", RESPONSE_SPEED * 0.8);
                return;
            }
            case "medic": {
                // casualty collection point: the exit closest to the fire
                const exits = new Map(building.exits.map((e) => [e.nodeId, e]));
                const r = navGraph.nearest(fireLoc, exits);
                const node = r ? navGraph.nodes[r.nodeId] : a.home;
                const p = navGraph.findPath(loc, { floorId: node.floorId, p: node.p });
                if (p) this.#go(a, p.points, "respond", "responding", "staging", RESPONSE_SPEED * 0.8);
                return;
            }
        }
    }

    #standDown(a: Agent): void {
        if (!a.person.inside) {
            // back inside through an exit after a while
            const exit = building.exits[Math.floor(this.#rand() * building.exits.length)];
            const node = navGraph.nodes[exit.nodeId];
            a.person.position = [...node.p];
            a.person.floorId = node.floorId;
            a.mode = "outside";
            a.wait = 3 + this.#rand() * 15;
            return;
        }
        if (a.person.role === "firefighter") {
            const p = navGraph.findPath(this.#loc(a), { floorId: a.home.floorId, p: a.home.p });
            if (p) return this.#go(a, p.points, "return", "returning", "patrolling", a.baseSpeed * 1.2);
        }
        a.mode = "idle";
        a.path = [];
        a.wait = 1 + this.#rand() * 4;
        a.person.status = this.#idleStatus(a.person.role);
    }

    //--------------------------------------------------------------------------
    // Simulation step
    //--------------------------------------------------------------------------
    #tick(): void {
        const now = performance.now();
        const dt = Math.min(0.25, (now - this.#last) / 1000);
        this.#last = now;
        for (const a of this.#agents) this.#step(a, dt);
        this.#emit();
    }

    #step(a: Agent, dt: number): void {
        const p = a.person;
        if (a.mode === "outside") {
            if (this.#incident) return;
            a.wait -= dt;
            if (a.wait <= 0) {
                p.inside = true;
                a.mode = "idle";
                a.wait = 0;
                p.status = this.#idleStatus(p.role);
            }
            return;
        }
        if (a.next >= a.path.length) {
            p.speed = 0;
            if (a.mode === "hold" || a.mode === "evacuate") return;
            a.wait -= dt;
            if (a.wait > 0) return;
            if (this.#incident && (p.role === "firefighter" || p.role === "security" || p.role === "medic")) return;
            this.#wander(a);
            return;
        }
        // walk along the path
        let budget = this.#speed(a) * dt;
        const start: Vec3 = [...p.position];
        while (budget > 1e-6 && a.next < a.path.length) {
            const target = a.path[a.next];
            const d = Math.hypot(target.p[0] - p.position[0], target.p[1] - p.position[1], target.p[2] - p.position[2]);
            const slow = target.stair ? STAIR_FACTOR : 1;
            const reach = budget * slow;
            if (d <= reach) {
                p.position = [...target.p];
                budget -= d / slow;
                a.next++;
            } else {
                const k = reach / d;
                p.position = [p.position[0] + (target.p[0] - p.position[0]) * k, p.position[1] + (target.p[1] - p.position[1]) * k, p.position[2] + (target.p[2] - p.position[2]) * k];
                budget = 0;
            }
        }
        const dx = p.position[0] - start[0];
        const dz = p.position[2] - start[2];
        const moved = Math.hypot(dx, p.position[1] - start[1], dz);
        p.speed = moved / dt;
        if (Math.hypot(dx, dz) > 1e-4) {
            const target = Math.atan2(-dx, -dz);
            let delta = target - p.heading;
            delta = Math.atan2(Math.sin(delta), Math.cos(delta));
            p.heading += delta * Math.min(1, dt * 8);
        }
        p.floorId = nearestFloor(p.position[1]);
        if (a.next >= a.path.length) this.#arrive(a);
    }

    #arrive(a: Agent): void {
        const p = a.person;
        p.speed = 0;
        switch (a.mode) {
            case "evacuate":
                p.inside = false;
                p.status = "evacuated";
                a.mode = "outside";
                return;
            case "respond":
                a.mode = "hold";
                p.status = a.arrivedStatus ?? p.status;
                return;
            case "return":
                a.mode = "idle";
                p.status = "patrolling";
                a.wait = 2 + this.#rand() * 4;
                return;
            default:
                a.mode = "idle";
                a.wait = p.role === "visitor" ? 4 + this.#rand() * 10 : 2 + this.#rand() * 6;
                p.status = this.#idleStatus(p.role, true);
        }
    }

    #wander(a: Agent): void {
        const role = a.person.role;
        const sameFloor = this.#rand() < (role === "visitor" ? 0.75 : 0.55);
        const target =
            role === "medic"
                ? this.#pick({ floorId: "R0" })
                : role === "firefighter" || role === "security"
                  ? this.#pick({ kinds: ["corridor", "door", "room"], floorId: sameFloor ? a.person.floorId : undefined })
                  : this.#pick({ floorId: sameFloor ? a.person.floorId : undefined });
        const path = navGraph.findPath(this.#loc(a), { floorId: target.floorId, p: target.p });
        if (!path || path.points.length < 2) {
            a.wait = 1;
            return;
        }
        this.#go(a, path.points, "wander", this.#movingStatus(role));
    }

    #go(a: Agent, points: PathPoint[], mode: Mode, status: PersonStatus, arrivedStatus?: PersonStatus, speed?: number): void {
        a.path = points;
        a.next = 1;
        a.mode = mode;
        a.wait = 0;
        a.person.status = status;
        a.arrivedStatus = arrivedStatus;
        a.speedOverride = speed;
    }

    #speed(a: Agent): number {
        return a.speedOverride ?? a.baseSpeed;
    }

    /** Cuts a path so that it stops `dist` metres before its end. */
    #stopShort(points: PathPoint[], dist: number): PathPoint[] {
        let remaining = dist;
        const out = points.slice();
        while (out.length >= 2 && remaining > 0) {
            const a = out[out.length - 2].p;
            const b = out[out.length - 1].p;
            const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
            if (d > remaining) {
                const k = (d - remaining) / d;
                out[out.length - 1] = { ...out[out.length - 1], p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k] };
                break;
            }
            remaining -= d;
            if (out.length === 2) {
                out[1] = { ...out[1], p: [...a] }; // already within `dist`: stay where we are
                break;
            }
            out.pop();
        }
        return out;
    }

    //--------------------------------------------------------------------------
    // Helpers
    //--------------------------------------------------------------------------
    #loc(a: Agent): Location {
        return { floorId: a.person.floorId, p: a.person.position };
    }

    /** A random destination; 80% of them inside the visible section slab. */
    #pick({ floorId, kinds = ["room", "corridor"] }: { floorId?: FloorId; kinds?: string[] }): NavNode {
        const pool = this.#walkNodes.concat(kinds.includes("door") ? navGraph.nodes.filter((n) => n.kind === "door") : []).filter((n) => kinds.includes(n.kind) && (!floorId || n.floorId === floorId));
        const visible = pool.filter((n) => isInsideSection(n.p));
        const from = visible.length && this.#rand() < 0.8 ? visible : pool;
        return from[Math.floor(this.#rand() * from.length)] ?? this.#walkNodes[0];
    }

    #firefighterHome(id: string): NavNode {
        // the on-site fire team waits near the stairs, one per floor
        const index = ROSTER.filter((r) => r.role === "firefighter").findIndex((r) => r.id === id);
        const floor = building.floors[index % building.floors.length];
        const exits = navGraph.nodesOf(floor.id).filter((n) => n.kind === "stair-exit");
        return exits[0] ?? this.#pick({ floorId: floor.id });
    }

    #idleStatus(role: Role, arrived = false): PersonStatus {
        switch (role) {
            case "visitor":
                return arrived ? "viewing" : "visiting";
            case "staff":
                return "on duty";
            case "medic":
                return "standby";
            default:
                return "patrolling";
        }
    }

    #movingStatus(role: Role): PersonStatus {
        return role === "visitor" ? "visiting" : role === "staff" ? "on duty" : role === "medic" ? "standby" : "patrolling";
    }

    #emit(): void {
        const snapshot: PeopleSnapshot = {
            timestamp: Date.now(),
            people: this.#agents.map((a) => ({ ...a.person, position: [...a.person.position] as Vec3 })),
        };
        this.#listeners.forEach((l) => l(snapshot));
    }
}
