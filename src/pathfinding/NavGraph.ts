//------------------------------------------------------------------------------
// Waypoint graph built from the scene geometry (rooms, corridors, doors, stairs,
// extinguishers) with A* and Dijkstra.
//
// Graph edges are straight segments that only cross walkable cells, so a path
// never goes through a wall; floors are only linked by stair edges, so a path
// never goes through a slab. Free positions (a person, a fire) are attached to
// the graph through the nodes they can see in a straight line.
//------------------------------------------------------------------------------
import { building, getFloor, type FloorId, type NavNode, type Vec3 } from "../building/building";
import { MinHeap } from "./MinHeap";

export interface Location {
    floorId: FloorId;
    p: Vec3;
}

export interface PathPoint {
    p: Vec3;
    floorId: FloorId;
    /** The segment that leads to this point is a stair flight. */
    stair: boolean;
}

export interface Path {
    points: PathPoint[];
    /** Walking distance (m). */
    length: number;
}

interface Edge {
    to: number;
    cost: number;
    stair: boolean;
}

const START = -1;
const GOAL = -2;

const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dist2 = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

export class NavGraph {
    readonly nodes: NavNode[];
    readonly #adj: Edge[][];
    readonly #byFloor = new Map<FloorId, NavNode[]>();

    constructor() {
        this.nodes = building.nodes;
        this.#adj = this.nodes.map(() => []);
        for (const [a, b, cost, stair] of building.edges) {
            this.#adj[a].push({ to: b, cost, stair: stair === 1 });
            this.#adj[b].push({ to: a, cost, stair: stair === 1 });
        }
        for (const n of this.nodes) {
            if (!this.#byFloor.has(n.floorId)) this.#byFloor.set(n.floorId, []);
            this.#byFloor.get(n.floorId)!.push(n);
        }
    }

    get edgeCount(): number {
        return building.edges.length;
    }

    nodesOf(floorId: FloorId): NavNode[] {
        return this.#byFloor.get(floorId) ?? [];
    }

    /** Puts a free position back on the walkable grid of its floor (positions from a real feed can be noisy). */
    snap(loc: Location): Location {
        const grid = getFloor(loc.floorId).grid;
        if (grid.walkable(loc.p[0], loc.p[2])) return loc;
        const n = grid.nearest(loc.p[0], loc.p[2], 2);
        return n ? { floorId: loc.floorId, p: [n[0], loc.p[1], n[1]] } : loc;
    }

    /** Graph nodes reachable in a straight line from a free position, with their distance. */
    anchors(loc: Location, maxDist = 16, max = 10): Array<{ id: number; cost: number }> {
        const out: Array<{ id: number; cost: number }> = [];
        // someone standing on a stair (or exactly on a node)
        for (const n of this.nodes) {
            const d = dist3(n.p, loc.p);
            if (d < 0.6) out.push({ id: n.id, cost: d });
        }
        const s = this.snap(loc);
        const grid = getFloor(loc.floorId).grid;
        const near = this.nodesOf(loc.floorId)
            .filter((n) => n.kind !== "stair")
            .map((n) => ({ n, d: dist2(n.p, s.p) }))
            .filter((c) => c.d <= maxDist)
            .sort((a, b) => a.d - b.d);
        for (const { n, d } of near) {
            if (out.length >= max) break;
            if (out.some((o) => o.id === n.id)) continue;
            if (grid.lineOfSight(s.p[0], s.p[2], n.p[0], n.p[2])) out.push({ id: n.id, cost: d + dist3(s.p, loc.p) });
        }
        if (!out.length && near.length) out.push({ id: near[0].n.id, cost: near[0].d }); // last resort
        return out;
    }

    /** Shortest walking path between two free positions (A*). */
    findPath(from: Location, to: Location): Path | null {
        if (from.floorId === to.floorId) {
            const grid = getFloor(from.floorId).grid;
            const a = this.snap(from).p;
            const b = this.snap(to).p;
            if (grid.lineOfSight(a[0], a[2], b[0], b[2])) {
                return { points: [this.#pt(from), { p: to.p, floorId: to.floorId, stair: false }], length: dist3(from.p, to.p) };
            }
        }
        const goalAnchors = new Map(this.anchors(to).map((a) => [a.id, a.cost]));
        if (!goalAnchors.size) return null;
        const h = (id: number) => (id === GOAL ? 0 : dist3(this.nodes[id].p, to.p));
        return this.#search(from, (id) => goalAnchors.get(id), h, to);
    }

    /**
     * Nearest target by walking distance (Dijkstra). `targets` maps a node id to
     * anything the caller wants back.
     */
    nearest<T>(from: Location, targets: Map<number, T>): { target: T; nodeId: number; path: Path } | null {
        let reached = -1;
        const path = this.#search(
            from,
            (id) => (targets.has(id) ? 0 : undefined),
            () => 0,
            null,
            (id) => (reached = id),
        );
        if (!path || reached < 0) return null;
        return { target: targets.get(reached)!, nodeId: reached, path };
    }

    /** Graph search from a free position to a virtual goal linked to some nodes. */
    #search(
        from: Location,
        goalCost: (id: number) => number | undefined,
        h: (id: number) => number,
        to: Location | null,
        onGoalNode?: (id: number) => void,
    ): Path | null {
        const g = new Map<number, number>();
        const came = new Map<number, { prev: number; stair: boolean }>();
        const open = new MinHeap<number>();
        g.set(START, 0);
        for (const a of this.anchors(from)) {
            if (a.cost < (g.get(a.id) ?? Infinity)) {
                g.set(a.id, a.cost);
                came.set(a.id, { prev: START, stair: false });
                open.push(a.cost + h(a.id), a.id);
            }
        }
        const closed = new Set<number>();
        while (open.size) {
            const { value: u } = open.pop()!;
            if (closed.has(u)) continue;
            closed.add(u);
            if (u === GOAL) return this.#rebuild(came, from, to, onGoalNode);
            const gu = g.get(u)!;
            const gc = goalCost(u);
            if (gc !== undefined && gu + gc < (g.get(GOAL) ?? Infinity)) {
                g.set(GOAL, gu + gc);
                came.set(GOAL, { prev: u, stair: false });
                open.push(gu + gc, GOAL);
            }
            for (const e of this.#adj[u]) {
                const ng = gu + e.cost;
                if (ng < (g.get(e.to) ?? Infinity)) {
                    g.set(e.to, ng);
                    came.set(e.to, { prev: u, stair: e.stair });
                    open.push(ng + h(e.to), e.to);
                }
            }
        }
        return null;
    }

    #rebuild(came: Map<number, { prev: number; stair: boolean }>, from: Location, to: Location | null, onGoalNode?: (id: number) => void): Path {
        const ids: Array<{ id: number; stair: boolean }> = [];
        let cur = GOAL;
        while (cur !== START) {
            const c = came.get(cur)!;
            ids.push({ id: cur, stair: c.stair });
            cur = c.prev;
        }
        ids.reverse();
        const points: PathPoint[] = [this.#pt(from)];
        for (const { id, stair } of ids) {
            if (id === GOAL) {
                if (to) points.push({ p: to.p, floorId: to.floorId, stair: false });
                continue;
            }
            const n = this.nodes[id];
            points.push({ p: n.p, floorId: n.floorId, stair });
        }
        const last = ids.filter((i) => i.id !== GOAL).pop();
        if (last && onGoalNode) onGoalNode(last.id);
        const smoothed = this.smooth(points);
        return { points: smoothed, length: pathLength(smoothed) };
    }

    #pt(loc: Location): PathPoint {
        return { p: loc.p, floorId: loc.floorId, stair: false };
    }

    /** Removes waypoints a straight line can skip (same floor, no stairs in between). */
    smooth(points: PathPoint[]): PathPoint[] {
        if (points.length < 3) return points;
        const out: PathPoint[] = [points[0]];
        let i = 0;
        while (i < points.length - 1) {
            let j = i + 1;
            for (let k = points.length - 1; k > i + 1; k--) {
                const run = points.slice(i + 1, k + 1);
                if (run.some((q) => q.stair || q.floorId !== points[i].floorId)) continue;
                const grid = getFloor(points[i].floorId).grid;
                if (grid.lineOfSight(points[i].p[0], points[i].p[2], points[k].p[0], points[k].p[2])) {
                    j = k;
                    break;
                }
            }
            out.push(points[j]);
            i = j;
        }
        return out;
    }
}

export const navGraph = new NavGraph();

/** Length of a polyline (m). */
export function pathLength(points: PathPoint[]): number {
    let l = 0;
    for (let k = 1; k < points.length; k++) l += dist3(points[k - 1].p, points[k].p);
    return l;
}
