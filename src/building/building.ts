//------------------------------------------------------------------------------
// Typed access to the geometry extracted from the scene
// (scripts/extract-building.mjs → museum.generated.json).
//------------------------------------------------------------------------------
import raw from "./museum.generated.json";

export type Vec3 = [number, number, number];
export type FloorId = string;

export type NodeKind = "room" | "corridor" | "door" | "stair" | "stair-exit" | "extinguisher";

export interface NavNode {
    id: number;
    floorId: FloorId;
    p: Vec3;
    kind: NodeKind;
    /** Room, door, stair or extinguisher this node belongs to. */
    ref: string;
}

export interface RoomInfo {
    id: string;
    name: string;
    floorId: FloorId;
    /** Footprint (x, z) */
    min: [number, number];
    max: [number, number];
    walkable: boolean;
    kind: "room" | "corridor";
}

export interface StairInfo {
    id: string;
    label: string;
    from: FloorId;
    to: FloorId;
    nodeIds: number[];
}

export interface ExtinguisherInfo {
    id: string;
    floorId: FloorId;
    /** Wall-mounted position, 1.1 m above the floor. */
    position: Vec3;
    /** Direction (x, z) the extinguisher faces, away from its wall. */
    facing: [number, number];
    /** Graph node in front of it. */
    nodeId: number;
    spot: "stairs" | "corridor-end" | "exit";
    near: string;
    agent: string;
}

export interface ExitInfo {
    id: string;
    label: string;
    floorId: FloorId;
    nodeId: number;
    door: string;
    doorPosition: Vec3;
}

/**
 * Something that can hide a person from a camera: an axis-aligned box (min x, y, z,
 * max x, y, z) clipped to the section. Walls also give their long axis (0 = x,
 * 2 = z) and their openings as [along min, along max, y min, y max].
 */
export interface Occluder {
    b: [number, number, number, number, number, number];
    a?: 0 | 2;
    h?: Array<[number, number, number, number]>;
}

interface RawFloor {
    id: FloorId;
    label: string;
    storey: string;
    y: number;
    grid: { x0: number; z0: number; cell: number; w: number; h: number; nav: string };
}

interface RawBuilding {
    source: { sceneId: string; sceneName: string; entities: number; triangles: number; extractedAt: string };
    section: { min: Vec3; max: Vec3 };
    floors: RawFloor[];
    rooms: RoomInfo[];
    nodes: NavNode[];
    edges: Array<[number, number, number, number]>;
    stairs: StairInfo[];
    extinguishers: ExtinguisherInfo[];
    exits: ExitInfo[];
    occluders: Occluder[];
}

//------------------------------------------------------------------------------
/** Walkable cells of one floor, already eroded by the body radius. */
export class NavGrid {
    readonly x0: number;
    readonly z0: number;
    readonly cell: number;
    readonly w: number;
    readonly h: number;
    readonly #bits: Uint8Array;

    constructor(g: RawFloor["grid"]) {
        this.x0 = g.x0;
        this.z0 = g.z0;
        this.cell = g.cell;
        this.w = g.w;
        this.h = g.h;
        const bin = atob(g.nav);
        this.#bits = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) this.#bits[k] = bin.charCodeAt(k);
    }

    cellOf(x: number, z: number): [number, number] {
        return [Math.floor((x - this.x0) / this.cell), Math.floor((z - this.z0) / this.cell)];
    }

    center(i: number, j: number): [number, number] {
        return [this.x0 + (i + 0.5) * this.cell, this.z0 + (j + 0.5) * this.cell];
    }

    get(i: number, j: number): boolean {
        if (i < 0 || j < 0 || i >= this.w || j >= this.h) return false;
        const k = j * this.w + i;
        return ((this.#bits[k >> 3] >> (k & 7)) & 1) === 1;
    }

    walkable(x: number, z: number): boolean {
        return this.get(...this.cellOf(x, z));
    }

    /** True if the straight segment only crosses walkable cells. */
    lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
        let [i, j] = this.cellOf(ax, az);
        const [ti, tj] = this.cellOf(bx, bz);
        const dx = bx - ax;
        const dz = bz - az;
        const si = Math.sign(dx);
        const sj = Math.sign(dz);
        const tDx = dx !== 0 ? Math.abs(this.cell / dx) : Infinity;
        const tDz = dz !== 0 ? Math.abs(this.cell / dz) : Infinity;
        const fx = (ax - this.x0) / this.cell - i;
        const fz = (az - this.z0) / this.cell - j;
        let tMx = dx > 0 ? (1 - fx) * tDx : dx < 0 ? fx * tDx : Infinity;
        let tMz = dz > 0 ? (1 - fz) * tDz : dz < 0 ? fz * tDz : Infinity;
        for (let n = 0; n < 4 * (this.w + this.h); n++) {
            if (!this.get(i, j)) return false;
            if (i === ti && j === tj) return true;
            if (Math.abs(tMx - tMz) < 1e-9) {
                if (!this.get(i + si, j) || !this.get(i, j + sj)) return false;
                i += si;
                j += sj;
                tMx += tDx;
                tMz += tDz;
            } else if (tMx < tMz) {
                i += si;
                tMx += tDx;
            } else {
                j += sj;
                tMz += tDz;
            }
        }
        return false;
    }

    /** Centre of the nearest walkable cell within `maxDist`, or null. */
    nearest(x: number, z: number, maxDist = 3): [number, number] | null {
        const [ci, cj] = this.cellOf(x, z);
        const r = Math.ceil(maxDist / this.cell);
        let best: [number, number] | null = null;
        let bestD = Infinity;
        for (let j = cj - r; j <= cj + r; j++)
            for (let i = ci - r; i <= ci + r; i++) {
                if (!this.get(i, j)) continue;
                const [cx, cz] = this.center(i, j);
                const d = Math.hypot(cx - x, cz - z);
                if (d < bestD && d <= maxDist) {
                    bestD = d;
                    best = [cx, cz];
                }
            }
        return best;
    }
}

//------------------------------------------------------------------------------
export interface FloorInfo {
    id: FloorId;
    label: string;
    storey: string;
    /** Walking height (world Y). */
    y: number;
    grid: NavGrid;
}

const data = raw as unknown as RawBuilding;

export const building = {
    source: data.source,
    /** The culling box that cuts the building in section. */
    section: data.section,
    floors: data.floors.map((f): FloorInfo => ({ id: f.id, label: f.label, storey: f.storey, y: f.y, grid: new NavGrid(f.grid) })),
    rooms: data.rooms,
    nodes: data.nodes,
    edges: data.edges,
    stairs: data.stairs,
    extinguishers: data.extinguishers,
    exits: data.exits,
    occluders: data.occluders,
};

const floorById = new Map(building.floors.map((f) => [f.id, f]));

export function getFloor(id: FloorId): FloorInfo {
    const f = floorById.get(id);
    if (!f) throw new Error(`Unknown floor ${id}`);
    return f;
}

/** The floor a point at height y belongs to: the highest floor at or below it. */
export function floorAtHeight(y: number): FloorInfo {
    const below = building.floors.filter((f) => f.y <= y + 0.05).sort((a, b) => b.y - a.y);
    return below[0] ?? building.floors[building.floors.length - 1];
}

/** Smallest room of the floor whose footprint contains (x, z). */
export function roomAt(floorId: FloorId, x: number, z: number): RoomInfo | null {
    let best: RoomInfo | null = null;
    let bestArea = Infinity;
    for (const r of building.rooms) {
        if (r.floorId !== floorId || x < r.min[0] || x > r.max[0] || z < r.min[1] || z > r.max[1]) continue;
        const area = (r.max[0] - r.min[0]) * (r.max[1] - r.min[1]);
        if (area < bestArea) {
            bestArea = area;
            best = r;
        }
    }
    return best;
}

/** "Circulation:4320399" → "Circulation 4320399" */
export function roomLabel(room: RoomInfo | null): string {
    return room ? room.name.replace(":", " ") : "Unnamed area";
}

/** Inside the rendered section slab (the part of the building the culling box keeps). */
export function isInsideSection(p: Vec3): boolean {
    const { min, max } = building.section;
    return p[0] >= min[0] && p[0] <= max[0] && p[2] >= min[2] && p[2] <= max[2];
}

/**
 * Not hidden behind the section: the camera looks from the north (+z), so anything
 * south of the slab's back face is behind rendered geometry.
 */
export function isInView(p: Vec3): boolean {
    return p[2] >= building.section.min[2];
}
