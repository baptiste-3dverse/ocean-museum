#!/usr/bin/env node
//------------------------------------------------------------------------------
// extract-building.mjs
//
// Reads the Ocean Museum scene description (IFC hierarchy converted by 3dverse)
// and generates `src/building/museum.generated.json`, the single source of
// geometry for the app:
//
//   - floors: the levels we simulate, their walking height (Y) and a navigation
//     grid (walkable cells, eroded by the body radius),
//   - rooms: every IfcSpace on those floors (name + footprint),
//   - a waypoint graph: room / corridor / door / stair / extinguisher nodes,
//     with edges only where the straight segment stays on walkable cells,
//   - stairs: 3D waypoint chains built from IfcStairFlight + landing slabs,
//   - extinguishers and exits, placed from the same geometry.
//
// Nothing in the app hard-codes a coordinate: every position comes from here.
//
// Usage:
//   node scripts/extract-building.mjs            # uses the cached description
//   node scripts/extract-building.mjs --refresh  # downloads it again (after a scene change)
//   node scripts/extract-building.mjs --debug-svg <dir>   # writes one SVG floor plan per level
//
// Debugging the navigation data (environment variables):
//   DEBUG_COMPONENTS=1          prints the connected parts of the waypoint graph
//   NO_PRUNE=1                  keeps unreachable nodes in the output
//   ASCII=R0 ASCII_BOX=x0,z0,x1,z1   prints the walkable grid of a level around a box
//------------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENE_ID = process.env.SCENE_ID ?? "c3809f0f-1246-42a2-a195-f214da250ffa";
// Public (read-only) token of the app, the same one used in src/config.ts.
const TOKEN = process.env.PUBLIC_TOKEN ?? "public_UFQSaEJ2N7XO3pqT";
const API = "https://api.3dverse.com/app/v1";
const CACHE = path.join(ROOT, "scripts/.cache/scene-description.json");
const OUT = path.join(ROOT, "src/building/museum.generated.json");

const args = process.argv.slice(2);
const REFRESH = args.includes("--refresh");
const DEBUG_DIR = args.includes("--debug-svg") ? args[args.indexOf("--debug-svg") + 1] : null;

//------------------------------------------------------------------------------
// Parameters
//------------------------------------------------------------------------------
/** The levels we simulate: two above ground, two basements. All are inside the visible section. */
const FLOORS = [
    { id: "R+1", label: "Level +1", storey: "Niveau R+1 (IfcBuildingStorey)" },
    { id: "R0", label: "Ground floor", storey: "Niveau R-0 (IfcBuildingStorey)" },
    { id: "R-1", label: "Basement -1", storey: "Niveau R-1 (IfcBuildingStorey)" },
    { id: "R-2", label: "Basement -2", storey: "Niveau R-2 (IfcBuildingStorey)" },
];
const CELL = 0.25; // nav grid resolution (m)
const BODY_RADIUS = 0.25; // clearance kept from walls (m): lets a 0.73 m door through on a 0.25 m grid
const BAND = [0.25, 1.8]; // obstacles count if they cross this height above the floor (m)
const MAX_EDGE = 22; // longest straight edge of the waypoint graph (m)

/** Spaces that are not floor you can walk on. */
const NOT_WALKABLE = /^(Vide|Ascenseur|Gaine|Placard|Trémie|Grand bassin|Bassin|Aquarium|Bac)/i;
/** Corridor-like spaces (French IFC naming: C…, Circulation, Passage, Couloir, Dégagement). */
const CORRIDOR = /^(C\d|C1|C2|Circulation|Passage|Couloir|Dégagement|Hall)/i;

/**
 * Stairs linking the simulated floors. Each one lists its flights and landings in
 * walking order, from the lower floor up. `up` is the axis direction in which a
 * flight climbs, read from the flight / landing bounding boxes (see README).
 * Stairs that are mostly outside the visible section are left out.
 */
const STAIRS = [
    {
        id: "stair-tower",
        label: "Stair tower",
        from: "R0",
        to: "R+1",
        parts: [
            ["flight", "Escalier:1834023 Run 1 (IfcStairFlight)", "+x"],
            ["landing", "Escalier:1834023 Landing 1 (IfcSlab)"],
            ["flight", "Escalier:1834023 Run 2 (IfcStairFlight)", "-x"],
            ["landing", "Escalier:1834023 Landing 2 (IfcSlab)"],
            ["flight", "Escalier:1835581 Run 1 (IfcStairFlight)", "+x"],
            ["landing", "Escalier:1835581 Landing 1 (IfcSlab)"],
            ["flight", "Escalier:1835581 Run 2 (IfcStairFlight)", "-x"],
            ["landing", "Escalier:1835581 Landing 2 (IfcSlab)"],
            ["flight", "Escalier:1836382 Run 1 (IfcStairFlight)", "+x"],
            ["landing", "Escalier:1836382 Landing 2 (IfcSlab)"],
            ["flight", "Escalier:1836382 Run 2 (IfcStairFlight)", "-x"],
            ["landing", "Escalier:1836382 Landing 1 (IfcSlab)"],
        ],
    },
    {
        // Single-mesh stair. It climbs towards -x: the R-1 stair space is at its +x end
        // (Escalier:4333957, x 45.0–47.8) and it passes under the R0→R+1 flight 290575.
        id: "central-west",
        label: "Central stair (west)",
        from: "R-1",
        to: "R0",
        parts: [["flight", "Escalier:1543977 (IfcStair)", "-x"]],
    },
    {
        // Mirror of the west one: R-1 stair space Escalier:4335603 (x 51.9–54.5) at its -x end.
        id: "central-east",
        label: "Central stair (east)",
        from: "R-1",
        to: "R0",
        parts: [["flight", "Escalier:1541793 (IfcStair)", "+x"]],
    },
    {
        id: "east-service",
        label: "East service stair",
        from: "R-2",
        to: "R-1",
        parts: [
            ["flight", "Escalier:1863685 Run 1 (IfcStairFlight)", "+x"],
            ["landing", "Escalier:1863685 Landing 1 (IfcSlab)"],
            ["flight", "Escalier:1863846 (IfcStair)", "-x"],
        ],
    },
];

/**
 * Openings that are part of a wall's own mesh (no IfcOpeningElement in the IFC), so
 * the bounding boxes cannot see them. Each one was measured on the rendered scene with
 * Livelink screen-space ray casts along a horizontal line 0.35 m above the floor,
 * looking at the wall face: the x range is where the rays went through the wall.
 */
const MEASURED_PASSAGES = [
    {
        floor: "R-1",
        wall: "Mur de base:Générique - Ext. 1100 mm:869655 (IfcWallStandardCase)",
        along: [48.39, 51.48],
        note: "central arch between the stair hall and the Grand bassin hall (3.1 m)",
    },
];

//------------------------------------------------------------------------------
// Scene description
//------------------------------------------------------------------------------
async function loadDescription() {
    if (!REFRESH && fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE, "utf8"));
    console.log(`Downloading scene ${SCENE_ID} description…`);
    const res = await fetch(`${API}/assets/scenes/${SCENE_ID}/description`, { headers: { user_token: TOKEN } });
    if (!res.ok) throw new Error(`Scene description: HTTP ${res.status}`);
    const json = await res.json();
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(json));
    return json;
}

//------------------------------------------------------------------------------
// Transforms
//------------------------------------------------------------------------------
const qmul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
function qrot(q, v) {
    const [x, y, z, w] = q;
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

function buildWorld(desc) {
    const byId = new Map(desc.entities.map((e) => [e.euid.value, e]));
    const children = new Map();
    for (const e of desc.entities) {
        const p = e.lineage.parentUUID;
        if (!children.has(p)) children.set(p, []);
        children.get(p).push(e.euid.value);
    }
    const global = new Map();
    const walk = (id, [pp, pq, ps]) => {
        const t = byId.get(id).local_transform;
        const lp = t.position.map((v, i) => v * ps[i]);
        const gp = qrot(pq, lp).map((v, i) => v + pp[i]);
        const gq = qmul(pq, t.orientation);
        const gs = ps.map((v, i) => v * t.scale[i]);
        global.set(id, [gp, gq, gs]);
        for (const c of children.get(id) ?? []) walk(c, [gp, gq, gs]);
    };
    for (const r of children.get("00000000-0000-0000-0000-000000000000") ?? []) walk(r, [[0, 0, 0], [0, 0, 0, 1], [1, 1, 1]]);

    const name = (id) => byId.get(id).debug_name.value;
    const parent = (id) => byId.get(id).lineage.parentUUID;
    /** World AABB of an entity, from its local AABB and global transform. */
    const aabb = (id) => {
        const e = byId.get(id);
        if (!e.local_aabb) return null;
        const { min, max } = e.local_aabb;
        const [gp, gq, gs] = global.get(id);
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        for (const X of [min[0], max[0]])
            for (const Y of [min[1], max[1]])
                for (const Z of [min[2], max[2]]) {
                    const v = qrot(gq, [X * gs[0], Y * gs[1], Z * gs[2]]);
                    for (let i = 0; i < 3; i++) {
                        lo[i] = Math.min(lo[i], v[i] + gp[i]);
                        hi[i] = Math.max(hi[i], v[i] + gp[i]);
                    }
                }
        return { min: lo, max: hi };
    };
    const storeyOf = new Map();
    for (const id of byId.keys()) {
        let u = id;
        while (u && byId.has(u)) {
            if (name(u).endsWith("(IfcBuildingStorey)")) {
                storeyOf.set(id, name(u));
                break;
            }
            u = parent(u);
        }
    }
    return { byId, children, global, name, parent, aabb, storeyOf };
}

const ifcType = (n) => n.match(/\((Ifc\w+)\)$/)?.[1] ?? null;
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

//------------------------------------------------------------------------------
// Grid helpers
//------------------------------------------------------------------------------
class Grid {
    constructor(x0, z0, x1, z1) {
        this.x0 = x0;
        this.z0 = z0;
        this.w = Math.ceil((x1 - x0) / CELL);
        this.h = Math.ceil((z1 - z0) / CELL);
        this.data = new Uint8Array(this.w * this.h);
    }
    idx(i, j) {
        return j * this.w + i;
    }
    inside(i, j) {
        return i >= 0 && j >= 0 && i < this.w && j < this.h;
    }
    cellOf(x, z) {
        return [Math.floor((x - this.x0) / CELL), Math.floor((z - this.z0) / CELL)];
    }
    center(i, j) {
        return [this.x0 + (i + 0.5) * CELL, this.z0 + (j + 0.5) * CELL];
    }
    get(i, j) {
        return this.inside(i, j) ? this.data[this.idx(i, j)] : 0;
    }
    /** Sets every cell whose centre lies inside the rectangle. */
    fill(minX, minZ, maxX, maxZ, v) {
        const i0 = Math.max(0, Math.ceil((minX - this.x0) / CELL - 0.5));
        const i1 = Math.min(this.w - 1, Math.floor((maxX - this.x0) / CELL - 0.5));
        const j0 = Math.max(0, Math.ceil((minZ - this.z0) / CELL - 0.5));
        const j1 = Math.min(this.h - 1, Math.floor((maxZ - this.z0) / CELL - 0.5));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.data[this.idx(i, j)] = v;
    }
    /** Blocks every cell the rectangle touches (conservative, used for obstacles). */
    block(minX, minZ, maxX, maxZ) {
        const i0 = Math.max(0, Math.floor((minX - this.x0) / CELL));
        const i1 = Math.min(this.w - 1, Math.floor((maxX - this.x0) / CELL));
        const j0 = Math.max(0, Math.floor((minZ - this.z0) / CELL));
        const j1 = Math.min(this.h - 1, Math.floor((maxZ - this.z0) / CELL));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.data[this.idx(i, j)] = 0;
    }
    clone() {
        const g = Object.create(Grid.prototype);
        Object.assign(g, this, { data: new Uint8Array(this.data) });
        return g;
    }
    /** Distance (m) from each walkable cell to the nearest blocked cell (two-pass chamfer). */
    distance() {
        const INF = 1e9;
        const d = new Float32Array(this.w * this.h);
        for (let k = 0; k < d.length; k++) d[k] = this.data[k] ? INF : 0;
        const a = CELL;
        const b = CELL * Math.SQRT2;
        const relax = (i, j, di, dj, c) => {
            if (!this.inside(i + di, j + dj)) return c === a ? 0 : Infinity; // grid border counts as wall
            return d[this.idx(i + di, j + dj)];
        };
        for (let j = 0; j < this.h; j++)
            for (let i = 0; i < this.w; i++) {
                const k = this.idx(i, j);
                if (!d[k]) continue;
                d[k] = Math.min(d[k], relax(i, j, -1, 0, a) + a, relax(i, j, 0, -1, a) + a, relax(i, j, -1, -1, b) + b, relax(i, j, 1, -1, b) + b);
            }
        for (let j = this.h - 1; j >= 0; j--)
            for (let i = this.w - 1; i >= 0; i--) {
                const k = this.idx(i, j);
                if (!d[k]) continue;
                d[k] = Math.min(d[k], relax(i, j, 1, 0, a) + a, relax(i, j, 0, 1, a) + a, relax(i, j, 1, 1, b) + b, relax(i, j, -1, 1, b) + b);
            }
        return d;
    }
    /** True if the straight segment only crosses set cells (supercover traversal). */
    lineOfSight(ax, az, bx, bz) {
        let [i, j] = this.cellOf(ax, az);
        const [ti, tj] = this.cellOf(bx, bz);
        const dx = bx - ax;
        const dz = bz - az;
        const si = Math.sign(dx);
        const sj = Math.sign(dz);
        const tDx = dx !== 0 ? Math.abs(CELL / dx) : Infinity;
        const tDz = dz !== 0 ? Math.abs(CELL / dz) : Infinity;
        const fx = (ax - this.x0) / CELL - i;
        const fz = (az - this.z0) / CELL - j;
        let tMx = dx > 0 ? (1 - fx) * tDx : dx < 0 ? fx * tDx : Infinity;
        let tMz = dz > 0 ? (1 - fz) * tDz : dz < 0 ? fz * tDz : Infinity;
        for (let n = 0; n < 4 * (this.w + this.h); n++) {
            if (!this.get(i, j)) return false;
            if (i === ti && j === tj) return true;
            if (Math.abs(tMx - tMz) < 1e-9) {
                // passing exactly through a corner: both neighbours must be free
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
    /** Nearest set cell centre to (x, z) within `maxDist`, or null. */
    nearest(x, z, maxDist = 3) {
        const [ci, cj] = this.cellOf(x, z);
        const r = Math.ceil(maxDist / CELL);
        let best = null;
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
    toBase64() {
        const bytes = new Uint8Array(Math.ceil(this.data.length / 8));
        this.data.forEach((v, k) => {
            if (v) bytes[k >> 3] |= 1 << (k & 7);
        });
        return Buffer.from(bytes).toString("base64");
    }
}

//------------------------------------------------------------------------------
// Main
//------------------------------------------------------------------------------
const desc = await loadDescription();
const W = buildWorld(desc);
const all = [...W.byId.keys()];
const ofType = (t) => all.filter((id) => ifcType(W.name(id)) === t);
const byName = new Map(all.map((id) => [W.name(id), id]));
const findByNameSuffix = (suffix) => {
    const hits = all.filter((id) => W.name(id).endsWith(suffix));
    if (hits.length !== 1) throw new Error(`Expected one entity named "…${suffix}", found ${hits.length}`);
    return hits[0];
};

// Section cut: the root entity carrying culling_geometry + box_geometry.
const cullId = all.find((id) => W.byId.get(id).culling_geometry && W.byId.get(id).box_geometry);
const cull = W.byId.get(cullId);
const [cp, , cs] = W.global.get(cullId);
const half = cull.box_geometry.dimension.map((d, i) => (d * cs[i]) / 2);
const section = { min: cp.map((v, i) => v - half[i] + (cull.box_geometry.offset?.[i] ?? 0)), max: cp.map((v, i) => v + half[i] + (cull.box_geometry.offset?.[i] ?? 0)) };
console.log("Section box:", section.min.map((v) => round(v, 2)), section.max.map((v) => round(v, 2)));

const spaces = ofType("IfcSpace").map((id) => ({ id, name: W.name(id).replace(/ \(IfcSpace\)$/, ""), storey: W.storeyOf.get(id), box: W.aabb(id) }));
const OBSTACLE_TYPES = new Set(["IfcWallStandardCase", "IfcWall", "IfcColumn", "IfcCurtainWall", "IfcRailing", "IfcBuildingElementProxy"]);
const obstacles = all.filter((id) => OBSTACLE_TYPES.has(ifcType(W.name(id)))).map((id) => ({ id, name: W.name(id), box: W.aabb(id) })).filter((o) => o.box);
/** True if the entity has an IfcStairFlight somewhere below it. */
const hasFlights = (id) => {
    const stack = [...(W.children.get(id) ?? [])];
    while (stack.length) {
        const c = stack.pop();
        if (ifcType(W.name(c)) === "IfcStairFlight") return true;
        stack.push(...(W.children.get(c) ?? []));
    }
    return false;
};
// Flights and landings block the floor they cross. A stair's own AABB is used only
// when it has no flights (single-mesh stairs): otherwise it would also cover the
// floor under its upper landings.
const stairParts = all
    .filter((id) => {
        const t = ifcType(W.name(id));
        return t === "IfcStairFlight" || (t === "IfcSlab" && /Landing|Palier/.test(W.name(id))) || (t === "IfcStair" && !hasFlights(id));
    })
    .map((id) => ({ id, name: W.name(id), box: W.aabb(id) }))
    .filter((o) => o.box);
/** Door openings: IfcOpeningElement entities that hold an IfcDoor. */
// Also floor-level glazed openings at least 2 m tall (glass doors between halls), see README.
const doors = ofType("IfcOpeningElement")
    .map((id) => {
        const kids = (W.children.get(id) ?? []).map((c) => W.name(c));
        const kind = kids.includes("IfcDoor") ? "door" : kids.includes("IfcWindow") ? "glazed" : null;
        return { id, kind, name: W.name(id).replace(/ \(IfcOpeningElement\)$/, ""), box: W.aabb(id), wall: W.aabb(W.parent(W.parent(id))) };
    })
    .filter((d) => d.kind && d.box);

const overlapsXZ = (b, minX, minZ, maxX, maxZ) => b.max[0] > minX && b.min[0] < maxX && b.max[2] > minZ && b.min[2] < maxZ;
// Navigation area: the whole building. The section box only hides geometry, the
// building is still there: corridors that join two visible rooms often run outside
// the section (e.g. the ground-floor entrance hall). The app keeps everyone visible
// with screen-space markers, and the simulation prefers rooms inside the section.
const bb = desc.aabb;
const sx0 = round(bb.min[0]); // rounded like in the JSON, so the app sees exactly the same cells
const sx1 = bb.max[0];
const sz0 = round(bb.min[2]);
const sz1 = bb.max[2];

/** Thickness written in a wall type name ("Ext. 1100 mm" → 1.1). */
const thicknessFromName = (n) => {
    const m = n.match(/(\d{2,4})\s?mm/);
    return m ? Number(m[1]) / 1000 : null;
};

const out = { source: {}, section: {}, floors: [], rooms: [], nodes: [], edges: [], stairs: [], extinguishers: [], exits: [], occluders: [] };
const report = [];
const nodes = out.nodes;
const addNode = (floorId, p, kind, ref) => {
    nodes.push({ id: nodes.length, floorId, p: p.map((v) => round(v)), kind, ref });
    return nodes.length - 1;
};
const grids = new Map();
const rawGrids = new Map();
const wallMasks = new Map();

for (const F of FLOORS) {
    // Walking height: the most common floor level of the storey's rooms inside the section.
    const own = spaces.filter((s) => s.storey === F.storey && s.box && overlapsXZ(s.box, sx0, sz0, sx1, sz1));
    const hist = new Map();
    for (const s of own) {
        const k = round(s.box.min[1], 2);
        hist.set(k, (hist.get(k) ?? 0) + 1);
    }
    const y = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0];
    F.y = y;
    const band = [y + BAND[0], y + BAND[1]];

    const grid = new Grid(sx0, sz0, sx1, sz1);
    const wallMask = new Grid(sx0, sz0, sx1, sz1); // cells blocked by walls / columns (to hang extinguishers)
    // 1. rooms you can walk in, at this height
    const walkSpaces = spaces.filter((s) => s.box && Math.abs(s.box.min[1] - y) <= 0.3 && s.box.max[1] - y > 1.9 && overlapsXZ(s.box, sx0, sz0, sx1, sz1));
    for (const s of walkSpaces) {
        out.rooms.push({ id: `${F.id}:${s.name}:${out.rooms.length}`, name: s.name, floorId: F.id, min: [round(s.box.min[0], 2), round(s.box.min[2], 2)], max: [round(s.box.max[0], 2), round(s.box.max[2], 2)], walkable: !NOT_WALKABLE.test(s.name), kind: CORRIDOR.test(s.name) ? "corridor" : "room" });
        if (!NOT_WALKABLE.test(s.name)) grid.fill(s.box.min[0], s.box.min[2], s.box.max[0], s.box.max[2], 1);
    }
    // 2. walls, columns, railings crossing the body height band
    let skipped = 0;
    for (const o of obstacles) {
        const b = o.box;
        if (b.max[1] < band[0] || b.min[1] > band[1] || !overlapsXZ(b, sx0, sz0, sx1, sz1)) continue;
        const dx = b.max[0] - b.min[0];
        const dz = b.max[2] - b.min[2];
        const t = thicknessFromName(o.name);
        const axisAligned = t ? Math.min(dx, dz) <= t + 0.3 : Math.min(dx, dz) < 0.9 || dx * dz < 6;
        if (!axisAligned) {
            skipped++;
            continue; // diagonal / curved element: its AABB would block a whole room
        }
        grid.block(b.min[0], b.min[2], b.max[0], b.max[2]);
        wallMask.fill(b.min[0], b.min[2], b.max[0], b.max[2], 1);
    }
    // 3. stairwells: flights and landings at this level are not floor (going down) or are in the way (going up)
    for (const s of stairParts) {
        const b = s.box;
        if (b.max[1] < y - 0.05 || b.min[1] > band[1] || !overlapsXZ(b, sx0, sz0, sx1, sz1)) continue;
        if (b.max[1] < y + 0.1 && b.max[1] - b.min[1] < 0.6) continue; // a few steps between two floor levels
        grid.block(b.min[0], b.min[2], b.max[0], b.max[2]);
    }
    // 4. door openings: carved through the whole wall thickness
    const floorDoors = [];
    for (const d of doors) {
        const b = d.box;
        // doors are sometimes placed at the storey level, below the finished floor: 1.4 m of clear height is enough
        if (b.min[1] > y + 0.3 || b.max[1] < y + 1.4 || !overlapsXZ(b, sx0, sz0, sx1, sz1)) continue;
        if (d.kind === "glazed" && (b.max[1] - y < 2.0 || Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) < 1.2)) continue;
        const alongX = b.max[0] - b.min[0] >= b.max[2] - b.min[2];
        const w = d.wall ?? b;
        // Across the wall: one cell beyond each face, because walls are blocked
        // conservatively (every cell they touch) and the carve must clear all of them.
        const minX = alongX ? b.min[0] : Math.max(w.min[0], b.min[0] - 1.5) - CELL;
        const maxX = alongX ? b.max[0] : Math.min(w.max[0], b.max[0] + 1.5) + CELL;
        const minZ = alongX ? Math.max(w.min[2], b.min[2] - 1.5) - CELL : b.min[2];
        const maxZ = alongX ? Math.min(w.max[2], b.max[2] + 1.5) + CELL : b.max[2];
        grid.fill(minX, minZ, maxX, maxZ, 1);
        floorDoors.push({ ...d, center: [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2], alongX });
    }
    // 4b. openings measured on the rendered mesh (see MEASURED_PASSAGES)
    for (const m of MEASURED_PASSAGES.filter((m) => m.floor === F.id)) {
        const w = W.aabb(byName.get(m.wall));
        const alongX = w.max[0] - w.min[0] >= w.max[2] - w.min[2];
        if (alongX) grid.fill(m.along[0], w.min[2] - CELL, m.along[1], w.max[2] + CELL, 1);
        else grid.fill(w.min[0] - CELL, m.along[0], w.max[0] + CELL, m.along[1], 1);
        const center = alongX ? [(m.along[0] + m.along[1]) / 2, (w.min[2] + w.max[2]) / 2] : [(w.min[0] + w.max[0]) / 2, (m.along[0] + m.along[1]) / 2];
        floorDoors.push({ name: `Passage (${m.note})`, center, alongX });
    }
    if (process.env.ASCII === F.id) {
        const [ax0, az0, ax1, az1] = process.env.ASCII_BOX.split(",").map(Number);
        const [i0, j0] = grid.cellOf(ax0, az0);
        const [i1, j1] = grid.cellOf(ax1, az1);
        for (let j = j0; j <= j1; j++) {
            let row = (grid.z0 + (j + 0.5) * CELL).toFixed(2).padStart(7) + " ";
            for (let i = i0; i <= i1; i++) row += grid.get(i, j) ? "." : "#";
            console.log(row);
        }
        console.log("x from", ax0, "to", ax1, "(1 char = 0.25 m)");
    }
    // 5. erode by the body radius → navigation grid
    const dist = grid.distance();
    const nav = grid.clone();
    for (let k = 0; k < nav.data.length; k++) nav.data[k] = dist[k] >= BODY_RADIUS ? 1 : 0;
    grids.set(F.id, nav);
    rawGrids.set(F.id, grid);
    wallMasks.set(F.id, wallMask);

    // Nodes: rooms (one per room, more for large ones), doors.
    for (const s of walkSpaces) {
        if (NOT_WALKABLE.test(s.name)) continue;
        const minX = Math.max(s.box.min[0], sx0);
        const maxX = Math.min(s.box.max[0], sx1);
        const minZ = Math.max(s.box.min[2], sz0);
        const maxZ = Math.min(s.box.max[2], sz1);
        const lx = maxX - minX;
        const lz = maxZ - minZ;
        const kind = CORRIDOR.test(s.name) ? "corridor" : "room";
        const nx = Math.max(1, Math.round(lx / 6));
        const nz = Math.max(1, Math.round(lz / 6));
        for (let a = 0; a < nx; a++)
            for (let c = 0; c < nz; c++) {
                const px = minX + ((a + 0.5) * lx) / nx;
                const pz = minZ + ((c + 0.5) * lz) / nz;
                const p = nav.nearest(px, pz, Math.min(2.5, Math.max(lx, lz) / 2));
                if (!p || p[0] < minX || p[0] > maxX || p[1] < minZ || p[1] > maxZ) continue;
                if (nodes.some((n) => n.floorId === F.id && Math.hypot(n.p[0] - p[0], n.p[2] - p[1]) < 1.5)) continue;
                addNode(F.id, [p[0], y, p[1]], kind, s.name);
            }
    }
    for (const d of floorDoors) {
        const p = nav.nearest(d.center[0], d.center[1], 0.6);
        if (!p) continue;
        if (nodes.some((n) => n.floorId === F.id && Math.hypot(n.p[0] - p[0], n.p[2] - p[1]) < 0.75)) continue;
        addNode(F.id, [p[0], y, p[1]], "door", d.name);
    }
    report.push(`${F.id}: y=${y}, grid ${nav.w}×${nav.h}, ${walkSpaces.length} rooms, ${floorDoors.length} doors, ${skipped} diagonal elements ignored`);
    out.floors.push({ id: F.id, label: F.label, storey: F.storey.replace(/ \(IfcBuildingStorey\)$/, ""), y, grid: { x0: round(sx0), z0: round(sz0), cell: CELL, w: nav.w, h: nav.h, nav: nav.toBase64() } });
}
const floorY = new Map(FLOORS.map((f) => [f.id, f.y]));

//------------------------------------------------------------------------------
// Stairs: 3D waypoint chains
//------------------------------------------------------------------------------
for (const S of STAIRS) {
    const pts = [];
    const boxes = [];
    for (const [kind, n, up] of S.parts) {
        const b = W.aabb(findByNameSuffix(n));
        boxes.push({ kind, b });
        const c = [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
        if (kind === "landing") {
            pts.push([c[0], b.max[1], c[1]]);
            continue;
        }
        const ax = up[1] === "x" ? 0 : 2;
        const sgn = up[0] === "+" ? 1 : -1;
        const lo = sgn > 0 ? b.min[ax] + 0.15 : b.max[ax] - 0.15;
        const hi = sgn > 0 ? b.max[ax] - 0.15 : b.min[ax] + 0.15;
        const mk = (along, yy) => (ax === 0 ? [along, yy, c[1]] : [c[0], yy, along]);
        pts.push(mk(lo, b.min[1]), mk(hi, b.max[1]));
    }
    // snap the two ends to the floors they serve
    pts[0][1] = floorY.get(S.from);
    pts[pts.length - 1][1] = floorY.get(S.to);
    const ids = [];
    // Floor exits: walk off the stair along its axis until the first free cell,
    // then onto the closest navigation cell in direct line of sight (never across a wall).
    // A chain that ends on a floor-level landing may also leave from any free cell of that landing.
    const exitPoint = (p, q, floorId, landing) => {
        const nav = grids.get(floorId);
        const raw = rawGrids.get(floorId);
        const tryFrom = (x, z) => {
            for (const r of [0.4, 0.8, 1.2]) {
                const n = nav.nearest(x, z, r);
                if (n && raw.lineOfSight(x, z, n[0], n[1])) return n;
            }
            return null;
        };
        const dir = [p[0] - q[0], p[2] - q[2]];
        const l = Math.hypot(dir[0], dir[1]) || 1;
        for (let step = 0; step <= 2.5; step += 0.1) {
            const x = p[0] + (dir[0] / l) * step;
            const z = p[2] + (dir[1] / l) * step;
            if (!raw.get(...raw.cellOf(x, z))) continue;
            const n = tryFrom(x, z);
            if (n) return n;
        }
        if (landing) {
            const [i0, j0] = raw.cellOf(landing.min[0], landing.min[2]);
            const [i1, j1] = raw.cellOf(landing.max[0], landing.max[2]);
            const free = [];
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (raw.get(i, j)) free.push(raw.center(i, j));
            free.sort((a, b) => Math.hypot(a[0] - p[0], a[1] - p[2]) - Math.hypot(b[0] - p[0], b[1] - p[2]));
            for (const [x, z] of free) {
                const n = tryFrom(x, z);
                if (n) return n;
            }
        }
        return null;
    };
    const first = boxes[0];
    const last = boxes[boxes.length - 1];
    const bottom = exitPoint(pts[0], pts[1], S.from, first.kind === "landing" ? first.b : null);
    const top = exitPoint(pts[pts.length - 1], pts[pts.length - 2], S.to, last.kind === "landing" ? last.b : null);
    if (!bottom || !top) {
        report.push(`WARNING stair ${S.id}: no walkable cell at its ${bottom ? "top" : "bottom"} (${(bottom ? pts[pts.length - 1] : pts[0]).map((v) => round(v, 2))}), skipped`);
        continue;
    }
    ids.push(addNode(S.from, [bottom[0], floorY.get(S.from), bottom[1]], "stair-exit", S.label));
    for (const p of pts) {
        const mid = (floorY.get(S.from) + floorY.get(S.to)) / 2;
        ids.push(addNode(p[1] < mid ? S.from : S.to, p, "stair", S.label));
    }
    ids.push(addNode(S.to, [top[0], floorY.get(S.to), top[1]], "stair-exit", S.label));
    for (let k = 1; k < ids.length; k++) out.edges.push([ids[k - 1], ids[k], round(dist3(nodes[ids[k - 1]].p, nodes[ids[k]].p), 2), 1]);
    out.stairs.push({ id: S.id, label: S.label, from: S.from, to: S.to, nodeIds: ids });
    report.push(`stair ${S.id}: ${S.from} (${bottom.map((v) => round(v, 1))}) → ${S.to} (${top.map((v) => round(v, 1))}), ${pts.length} waypoints`);
}
function dist3(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

//------------------------------------------------------------------------------
// Extinguishers: near stairs, corridor ends and exits, mounted on a wall
//------------------------------------------------------------------------------
// Exits: doors on the ground floor whose one side is outside every room (exterior doors),
// projected onto the visible section; fallback = ground floor stair landings.
const groundY = floorY.get("R0");
const exteriorDoors = doors.filter((d) => d.kind === "door").filter((d) => {
    const b = d.box;
    if (b.min[1] > groundY + 0.3 || b.max[1] < groundY + 1.9) return false;
    const alongX = b.max[0] - b.min[0] >= b.max[2] - b.min[2];
    const c = [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
    const sides = alongX ? [[c[0], c[1] - 1.6], [c[0], c[1] + 1.6]] : [[c[0] - 1.6, c[1]], [c[0] + 1.6, c[1]]];
    const inRoom = ([x, z]) => spaces.some((s) => s.box && Math.abs(s.box.min[1] - groundY) < 0.8 && x > s.box.min[0] && x < s.box.max[0] && z > s.box.min[2] && z < s.box.max[2]);
    return sides.filter(inRoom).length === 1;
});
report.push(`ground floor exterior doors: ${exteriorDoors.map((d) => `${d.name.split(":").slice(-2).join(":")} @(${round((d.box.min[0] + d.box.max[0]) / 2, 1)}, ${round((d.box.min[2] + d.box.max[2]) / 2, 1)})`).join("; ")}`);

// Graph edges between nodes of the same floor with a clear straight line.
function connectFloor(floorId, onlyIds = null) {
    const nav = grids.get(floorId);
    const ids = nodes.filter((n) => n.floorId === floorId && n.kind !== "stair").map((n) => n.id);
    const fresh = onlyIds ?? ids;
    for (const a of fresh)
        for (const b of ids) {
            if (a === b || (onlyIds === null && b < a) || (onlyIds && onlyIds.includes(b) && b < a)) continue;
            const pa = nodes[a].p;
            const pb = nodes[b].p;
            const d = Math.hypot(pa[0] - pb[0], pa[2] - pb[2]);
            if (d > MAX_EDGE || d < 0.05) continue;
            if (nav.lineOfSight(pa[0], pa[2], pb[0], pb[2])) out.edges.push([a, b, round(d, 2), 0]);
        }
}
for (const F of FLOORS) connectFloor(F.id);

// Keep the largest connected component (the one the stairs tie together).
function components() {
    const adj = new Map(nodes.map((n) => [n.id, []]));
    for (const [a, b] of out.edges) {
        adj.get(a).push(b);
        adj.get(b).push(a);
    }
    const comp = new Map();
    let c = 0;
    for (const n of nodes) {
        if (comp.has(n.id)) continue;
        const stack = [n.id];
        comp.set(n.id, c);
        while (stack.length) {
            const u = stack.pop();
            for (const v of adj.get(u)) if (!comp.has(v)) comp.set(v, c), stack.push(v);
        }
        c++;
    }
    return comp;
}
{
    const comp = components();
    const sizes = new Map();
    for (const v of comp.values()) sizes.set(v, (sizes.get(v) ?? 0) + 1);
    const main = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (process.env.DEBUG_COMPONENTS) {
        const per = new Map();
        for (const n of nodes) {
            const k = `${comp.get(n.id)}`;
            if (!per.has(k)) per.set(k, { n: 0, floors: new Set(), xs: [] });
            const e = per.get(k);
            e.n++; e.floors.add(n.floorId); e.xs.push(n.p[0]);
        }
        for (const [k, e] of [...per.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25)) console.log(`component ${k}: ${e.n} nodes, floors ${[...e.floors]}, x ${Math.min(...e.xs).toFixed(0)}..${Math.max(...e.xs).toFixed(0)}`);
    }
    const keep = process.env.NO_PRUNE ? nodes.slice() : nodes.filter((n) => comp.get(n.id) === main);
    const dropped = nodes.length - keep.length;
    const remap = new Map(keep.map((n, i) => [n.id, i]));
    out.edges = out.edges.filter(([a, b]) => remap.has(a) && remap.has(b)).map(([a, b, c, s]) => [remap.get(a), remap.get(b), c, s]);
    nodes.splice(0, nodes.length, ...keep.map((n, i) => ({ ...n, id: i }))); // out.nodes === nodes
    for (const s of out.stairs) s.nodeIds = s.nodeIds.map((id) => remap.get(id));
    report.push(`graph: ${nodes.length} nodes kept, ${dropped} unreachable nodes dropped, ${out.edges.length} edges`);
}

// Candidate spots per floor, by priority.
const wallSpot = (floorId, x, z) => {
    // the extinguisher hangs on the closest wall: walkable (not eroded) cell next to a blocked one
    const g = rawGrids.get(floorId);
    const walls = wallMasks.get(floorId);
    const [ci, cj] = g.cellOf(x, z);
    let best = null;
    for (let r = 0; r <= 10 && !best; r++)
        for (let j = cj - r; j <= cj + r; j++)
            for (let i = ci - r; i <= ci + r; i++) {
                if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r || !g.get(i, j)) continue;
                const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([di, dj]) => g.inside(i + di, j + dj) && !g.get(i + di, j + dj) && walls.get(i + di, j + dj));
                if (!n) continue;
                const [cx, cz] = g.center(i, j);
                const cand = { x: cx + n[0] * CELL * 0.35, z: cz + n[1] * CELL * 0.35, normal: [-n[0], -n[1]] };
                if (!best || Math.hypot(cand.x - x, cand.z - z) < Math.hypot(best.x - x, best.z - z)) best = cand;
            }
    return best;
};
// Exits: exterior ground-floor doors that the graph reaches (a node within 3.5 m).
const reachableExits = [];
for (const d of exteriorDoors) {
    const c = [(d.box.min[0] + d.box.max[0]) / 2, (d.box.min[2] + d.box.max[2]) / 2];
    const n = nodes
        .filter((n) => n.floorId === "R0" && (n.kind === "room" || n.kind === "corridor" || n.kind === "door"))
        .sort((a, b) => Math.hypot(a.p[0] - c[0], a.p[2] - c[1]) - Math.hypot(b.p[0] - c[0], b.p[2] - c[1]))[0];
    if (!n || Math.hypot(n.p[0] - c[0], n.p[2] - c[1]) > 3.5 || reachableExits.some((e) => e.node.id === n.id)) continue;
    const side = c[0] < 20 ? "West" : c[0] > 80 ? "East" : "Central";
    reachableExits.push({ door: d, center: c, node: n, label: `${side} exit` });
}
report.push(`reachable exits: ${reachableExits.map((e) => `${e.label} @(${e.center.map((v) => round(v, 1))})`).join("; ") || "none"}`);

for (const F of FLOORS) {
    const floorNodes = nodes.filter((n) => n.floorId === F.id);
    const cands = [];
    for (const n of floorNodes.filter((n) => n.kind === "stair-exit")) cands.push({ node: n, prio: 0, spot: "stairs", why: n.ref });
    if (F.id === "R0") for (const e of reachableExits) cands.push({ node: e.node, prio: 1, spot: "exit", why: e.label });
    // corridor ends: corridor nodes that are the extreme of their corridor along its long axis
    const byRoom = new Map();
    for (const n of floorNodes.filter((n) => n.kind === "corridor")) {
        if (!byRoom.has(n.ref)) byRoom.set(n.ref, []);
        byRoom.get(n.ref).push(n);
    }
    for (const [ref, list] of byRoom) {
        if (list.length < 2) continue;
        const ax = Math.max(...list.map((n) => n.p[0])) - Math.min(...list.map((n) => n.p[0])) >= Math.max(...list.map((n) => n.p[2])) - Math.min(...list.map((n) => n.p[2])) ? 0 : 2;
        list.sort((a, b) => a.p[ax] - b.p[ax]);
        cands.push({ node: list[0], prio: 2, spot: "corridor-end", why: ref }, { node: list[list.length - 1], prio: 2, spot: "corridor-end", why: ref });
    }
    // fallback: spread along the floor
    const xs = floorNodes.filter((n) => n.kind === "room" || n.kind === "corridor").sort((a, b) => a.p[0] - b.p[0]);
    if (xs.length) cands.push({ node: xs[0], prio: 3, spot: "corridor-end", why: "west end" }, { node: xs[xs.length - 1], prio: 3, spot: "corridor-end", why: "east end" });
    cands.sort((a, b) => a.prio - b.prio);
    const chosen = [];
    for (const c of cands) {
        if (chosen.length >= 4) break;
        if (chosen.some((o) => Math.hypot(o.node.p[0] - c.node.p[0], o.node.p[2] - c.node.p[2]) < 14)) continue;
        chosen.push(c);
    }
    let k = 1;
    for (const c of chosen) {
        const w = wallSpot(F.id, c.node.p[0], c.node.p[2]);
        if (!w) continue;
        const id = `EXT-${F.id}-${String(k++).padStart(2, "0")}`;
        // access point on the walkable grid in front of the extinguisher
        const acc = grids.get(F.id).nearest(w.x + w.normal[0] * 0.5, w.z + w.normal[1] * 0.5, 2);
        const nodeId = addNode(F.id, [acc[0], F.y, acc[1]], "extinguisher", id);
        out.extinguishers.push({ id, floorId: F.id, position: [round(w.x), round(F.y + 1.1), round(w.z)], facing: w.normal, nodeId, spot: c.spot, near: c.why, agent: c.spot === "exit" ? "CO2 5 kg" : "Water + additive 6 L" });
        connectFloor(F.id, [nodeId]);
    }
}

// Exits used for evacuation
for (const e of reachableExits) out.exits.push({ id: `EXIT-${out.exits.length + 1}`, label: e.label, floorId: "R0", nodeId: e.node.id, door: e.door.name, doorPosition: [round(e.center[0], 2), round(groundY, 2), round(e.center[1], 2)] });

//------------------------------------------------------------------------------
// Occluders: what can hide a person from a camera (src/twin3d/occlusion.ts).
// Walls, columns, slabs, roofs and ceilings, clipped to the section box (the rest
// is not rendered). Doors, windows and measured passages are holes in their wall.
//------------------------------------------------------------------------------
{
    const OCCLUDER_TYPES = new Set(["IfcWallStandardCase", "IfcWall", "IfcColumn", "IfcSlab", "IfcRoof", "IfcCovering"]);
    const holesByWall = new Map();
    const addHole = (wallId, h) => {
        if (!holesByWall.has(wallId)) holesByWall.set(wallId, []);
        holesByWall.get(wallId).push(h);
    };
    for (const d of doors) {
        const wallId = W.parent(W.parent(d.id));
        const w = d.wall;
        if (!w) continue;
        const a = w.max[0] - w.min[0] >= w.max[2] - w.min[2] ? 0 : 2;
        addHole(wallId, [d.box.min[a], d.box.max[a], d.box.min[1], d.box.max[1]]);
    }
    for (const m of MEASURED_PASSAGES) {
        const wallId = byName.get(m.wall);
        const y = floorY.get(m.floor);
        addHole(wallId, [m.along[0], m.along[1], y, y + 2.6]);
    }
    const clip = (b) => {
        const lo = b.min.map((v, i) => Math.max(v, section.min[i]));
        const hi = b.max.map((v, i) => Math.min(v, section.max[i]));
        return lo.every((v, i) => v < hi[i]) ? { min: lo, max: hi } : null;
    };
    let skipped = 0;
    for (const id of all) {
        const t = ifcType(W.name(id));
        if (!OCCLUDER_TYPES.has(t)) continue;
        const box = W.aabb(id);
        const b = box && clip(box);
        if (!b) continue;
        const dx = box.max[0] - box.min[0];
        const dz = box.max[2] - box.min[2];
        const isWall = t === "IfcWallStandardCase" || t === "IfcWall";
        if (isWall) {
            const th = thicknessFromName(W.name(id));
            if (th ? Math.min(dx, dz) > th + 0.3 : Math.min(dx, dz) >= 0.9 && dx * dz >= 6) {
                skipped++; // diagonal or curved: its box would hide far too much
                continue;
            }
        } else if (t !== "IfcColumn" && box.max[1] - box.min[1] > 1.5) {
            skipped++; // a sloped roof or a thick slab: not a plane, its box would be wrong
            continue;
        }
        const o = { b: [...b.min, ...b.max].map((v) => round(v, 2)) };
        if (isWall) {
            o.a = dx >= dz ? 0 : 2;
            const holes = holesByWall.get(id);
            if (holes) o.h = holes.map((h) => h.map((v) => round(v, 2)));
        }
        out.occluders.push(o);
    }
    report.push(`occluders: ${out.occluders.length} boxes in the section (${out.occluders.filter((o) => o.h).length} walls with openings), ${skipped} skipped`);
}

out.source = { sceneId: SCENE_ID, sceneName: desc.name, entities: desc.entities.length, triangles: desc.triangleCount, extractedAt: new Date().toISOString(), aabb: desc.aabb };
out.section = { min: section.min.map((v) => round(v)), max: section.max.map((v) => round(v)) };
out.report = report;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(report.join("\n"));
console.log(`extinguishers: ${out.extinguishers.map((e) => `${e.id} (${e.spot}: ${e.near})`).join(", ")}`);
console.log(`exits: ${out.exits.length}`);
console.log(`→ ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);

//------------------------------------------------------------------------------
// Debug SVG: one picture per floor (grid, graph, stairs, extinguishers)
//------------------------------------------------------------------------------
if (DEBUG_DIR) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const S = 12; // px per metre
    for (const F of out.floors) {
        const raw = rawGrids.get(F.id);
        const nav = grids.get(F.id);
        const Wpx = raw.w * CELL * S;
        const Hpx = raw.h * CELL * S;
        const X = (x) => (x - raw.x0) * S;
        const Z = (z) => (z - raw.z0) * S;
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Wpx + 20}" height="${Hpx + 40}" style="background:#0b1016"><g transform="translate(10,30)">`;
        svg += `<text x="0" y="-10" fill="#9cf" font-family="monospace" font-size="14">${F.id} y=${F.y}</text>`;
        for (let j = 0; j < raw.h; j++)
            for (let i = 0; i < raw.w; i++) {
                const col = nav.get(i, j) ? "#1d4f5c" : raw.get(i, j) ? "#16303a" : null;
                if (col) svg += `<rect x="${i * CELL * S}" y="${j * CELL * S}" width="${CELL * S + 0.3}" height="${CELL * S + 0.3}" fill="${col}"/>`;
            }
        for (const r of out.rooms.filter((r) => r.floorId === F.id))
            svg += `<rect x="${X(r.min[0])}" y="${Z(r.min[1])}" width="${(r.max[0] - r.min[0]) * S}" height="${(r.max[1] - r.min[1]) * S}" fill="none" stroke="#345" stroke-width="0.6"/><text x="${X((r.min[0] + r.max[0]) / 2)}" y="${Z(Math.min(r.max[1], sz1)) - 2}" fill="#567" font-size="8" font-family="monospace" text-anchor="middle">${r.name.split(":")[0]}</text>`;
        for (const [a, b, , s] of out.edges) {
            const na = nodes[a];
            const nb = nodes[b];
            if (na.floorId !== F.id && nb.floorId !== F.id) continue;
            svg += `<line x1="${X(na.p[0])}" y1="${Z(na.p[2])}" x2="${X(nb.p[0])}" y2="${Z(nb.p[2])}" stroke="${s ? "#ffb347" : "#3fd0ff"}" stroke-opacity="${s ? 1 : 0.35}" stroke-width="${s ? 2 : 0.8}"/>`;
        }
        const colors = { room: "#fff", corridor: "#9ff", door: "#fd5", stair: "#f93", "stair-exit": "#f93", extinguisher: "#2f8" };
        for (const n of nodes.filter((n) => n.floorId === F.id)) svg += `<circle cx="${X(n.p[0])}" cy="${Z(n.p[2])}" r="${n.kind === "extinguisher" ? 5 : 2.5}" fill="${colors[n.kind]}"/>`;
        for (const e of out.extinguishers.filter((e) => e.floorId === F.id)) svg += `<rect x="${X(e.position[0]) - 4}" y="${Z(e.position[2]) - 4}" width="8" height="8" fill="#2f8"/><text x="${X(e.position[0]) + 6}" y="${Z(e.position[2]) - 6}" fill="#2f8" font-size="10" font-family="monospace">${e.id}</text>`;
        for (const e of out.exits) if (F.id === "R0") svg += `<circle cx="${X(nodes[e.nodeId].p[0])}" cy="${Z(nodes[e.nodeId].p[2])}" r="6" fill="none" stroke="#f0f" stroke-width="2"/>`;
        svg += `</g></svg>`;
        fs.writeFileSync(path.join(DEBUG_DIR, `${F.id}.svg`), svg);
    }
    console.log(`debug SVGs → ${DEBUG_DIR}`);
}
