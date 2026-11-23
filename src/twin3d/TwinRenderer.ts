//------------------------------------------------------------------------------
// The digital twin's entities in the 3D scene, all under one root: DigitalTwin.
// The building entities are never touched. Entities are transient (session only)
// and deleted when this client disconnects.
//
// DigitalTwin
//   People / <one entity per person>   moves with the feed (30 Hz, interpolated)
//            └ bodycam-FF-0x             camera at head height, facing the walking direction
//   Extinguishers / EXT-…               one anchor per extinguisher (wall position)
//   Incident / Fire                      at the fire position, with a flickering red light
//
// Markers, labels, the danger radius and the routes are drawn by TwinOverlay,
// projected through each viewport's camera. Mesh markers are not used: this
// app's public token cannot read any mesh asset, and an entity referencing an
// unreadable mesh is never created (see README, "Rendering choices").
//
// Entities are created in batches (scene.newEntities): the server handles
// creation requests one after the other.
//------------------------------------------------------------------------------
import type { Entity, Livelink, Scene } from "@3dverse/livelink";
import { building, getFloor, type Vec3 } from "../building/building";
import { ASSETS, BODY_CAM_SETTINGS, COLORS } from "../config";
import type { FireIncident, Person, Role } from "../simulation/types";
import { twinStore, type TwinState } from "../state/twinStore";
import { hexToLinear, pitchQuat, yawQuat } from "./math";
import { pushSnapshot, sample } from "./motion";

type Components = Parameters<Scene["newEntities"]>[0]["components_array"][number];

interface Spec {
    name: string;
    parent: Entity | null;
    components: Record<string, unknown>;
}

export const ROLE_COLOR: Record<Role, string> = {
    visitor: COLORS.visitor,
    staff: COLORS.staff,
    security: COLORS.security,
    medic: COLORS.medic,
    firefighter: COLORS.firefighter,
};

interface PersonEntity {
    root: Entity;
    camera: Entity | null;
    visible: boolean;
    /** Floor whose height the body cam's grid is drawn at. */
    gridFloor?: string;
}

interface FireEntity {
    incidentId: string;
    group: Entity;
    light: Entity | null;
}

/** Body cam: head height, slightly in front of the eyes, looking 7° down. */
const BODY_CAM_TRANSFORM = { position: [0, 1.68, -0.25] as Vec3, orientation: pitchQuat((-7 * Math.PI) / 180) };

export class TwinRenderer {
    readonly #ll: Livelink;
    readonly #created: Entity[] = [];
    #disposed = false;
    #root: Entity | null = null;
    #adoptQueue: Entity[] = [];
    #groups: Record<"people" | "extinguishers" | "incident", Entity> | null = null;
    #people = new Map<string, PersonEntity | "pending">();
    #fire: FireEntity | null = null;
    #fireRequest: string | null = null;
    #timer: ReturnType<typeof setInterval> | null = null;
    #unsubscribe: (() => void) | null = null;
    #prev: TwinState | null = null;
    #bodyCamListeners = new Set<() => void>();

    constructor(ll: Livelink) {
        this.#ll = ll;
    }

    //--------------------------------------------------------------------------
    async init(): Promise<void> {
        const [root] = await this.#makeMany([{ name: "DigitalTwin", parent: null, components: { local_transform: { position: [0, 0, 0] } } }]);
        if (!root) return;
        this.#root = root;
        for (const e of this.#adoptQueue.splice(0)) e.parent = root;
        const [people, extinguishers, incident] = await this.#makeMany(
            ["People", "Extinguishers", "Incident"].map((name) => ({ name, parent: root, components: { local_transform: { position: [0, 0, 0] } } })),
        );
        if (!people || !extinguishers || !incident) return;
        this.#groups = { people, extinguishers, incident };
        this.#unsubscribe = twinStore.subscribe(() => this.#onState(twinStore.getState()));
        this.#onState(twinStore.getState());
        this.#timer = setInterval(() => this.#animate(), 33);
        await this.#makeMany(building.extinguishers.map((e) => ({ name: e.id, parent: extinguishers, components: { local_transform: { position: e.position } } })));
    }

    dispose(): void {
        this.#disposed = true;
        if (this.#timer) clearInterval(this.#timer);
        this.#unsubscribe?.();
        if (this.#created.length) this.#ll.scene.deleteEntities({ entities: this.#created }).catch(() => {});
        this.#created.length = 0;
    }

    /** Moves an entity created elsewhere (the operator camera) under DigitalTwin. */
    adopt(entity: Entity): void {
        if (this.#disposed) return;
        if (this.#root) entity.parent = this.#root;
        else this.#adoptQueue.push(entity);
    }

    /** Camera attached to a firefighter's head, once created. */
    getBodyCam(personId: string): Entity | null {
        const v = this.#people.get(personId);
        return v && v !== "pending" ? v.camera : null;
    }

    onBodyCamsChanged(listener: () => void): () => void {
        this.#bodyCamListeners.add(listener);
        return () => this.#bodyCamListeners.delete(listener);
    }

    /** Counts for debugging (exposed as window.__twin in dev). */
    debugInfo() {
        const people = [...this.#people.values()];
        return {
            created: this.#created.length,
            people: people.length,
            pending: people.filter((v) => v === "pending").length,
            cameras: people.filter((v) => v !== "pending" && v.camera).length,
            fire: !!this.#fire,
        };
    }

    //--------------------------------------------------------------------------
    /** Creates entities in one request; the parent is given through the lineage component. */
    async #makeMany(specs: Spec[]): Promise<Array<Entity | null>> {
        if (this.#disposed || !specs.length) return specs.map(() => null);
        try {
            const components_array = specs.map((s) => ({
                debug_name: { value: s.name },
                ...(s.parent ? { lineage: { parentUUID: s.parent.id } } : {}),
                ...s.components,
            })) as Components[];
            const entities = await this.#ll.scene.newEntities({ components_array, options: { delete_on_client_disconnection: true } });
            if (this.#disposed) {
                this.#ll.scene.deleteEntities({ entities }).catch(() => {});
                return specs.map(() => null);
            }
            this.#created.push(...entities);
            return entities;
        } catch (err) {
            console.warn(`DigitalTwin: could not create ${specs.length} entities (${specs[0].name}…)`, err);
            return specs.map(() => null);
        }
    }

    #onState(s: TwinState): void {
        const prev = this.#prev;
        this.#prev = s;
        if (!prev || prev.snapshot !== s.snapshot) {
            pushSnapshot(s.snapshot, s.receivedAt || performance.now());
            this.#syncPeople(s.snapshot.people);
        }
        if (!prev || prev.incident !== s.incident) this.#syncFire(s.incident);
    }

    //--------------------------------------------------------------------------
    // People and body cams
    //--------------------------------------------------------------------------
    #syncPeople(people: Person[]): void {
        const fresh = people.filter((p) => !this.#people.has(p.id));
        if (fresh.length) {
            for (const p of fresh) this.#people.set(p.id, "pending");
            void this.#createPeople(fresh);
        }
        for (const p of people) {
            const v = this.#people.get(p.id);
            if (!v || v === "pending") continue;
            v.visible = p.inside;
            if (v.camera && v.gridFloor !== p.floorId) {
                v.gridFloor = p.floorId;
                v.camera.camera = {
                    renderGraphRef: ASSETS.renderGraph,
                    dataJSON: { ...BODY_CAM_SETTINGS, gridHeight: getFloor(p.floorId).y + 0.01 },
                    renderTargetIndex: -1,
                };
            }
        }
    }

    async #createPeople(list: Person[]): Promise<void> {
        const groups = this.#groups;
        if (!groups) return;
        const roots = await this.#makeMany(
            list.map((p) => ({ name: p.callsign ? `${p.callsign} ${p.name}` : p.name, parent: groups.people, components: { local_transform: { position: p.position, orientation: yawQuat(p.heading) } } })),
        );
        const firefighters = list.map((p, i) => ({ p, root: roots[i] })).filter(({ p, root }) => p.role === "firefighter" && root);
        // Cameras use newEntity({ parent }) so the client also knows their parent: the
        // body-cam overlay projects through the camera's world matrix computed here.
        const cameras = await Promise.all(
            firefighters.map(async ({ p, root }) => {
                if (this.#disposed) return null;
                try {
                    const cam = await this.#ll.scene.newEntity({
                        name: `bodycam-${p.callsign ?? p.id}`,
                        parent: root,
                        components: {
                            local_transform: BODY_CAM_TRANSFORM,
                            camera: { renderGraphRef: ASSETS.renderGraph, dataJSON: BODY_CAM_SETTINGS, renderTargetIndex: -1 },
                            perspective_lens: { fovy: 74, nearPlane: 0.05, farPlane: 0 },
                        } as Components,
                        options: { delete_on_client_disconnection: true },
                    });
                    this.#created.push(cam);
                    return cam;
                } catch (err) {
                    console.warn(`DigitalTwin: could not create the body cam of ${p.callsign}`, err);
                    return null;
                }
            }),
        );
        list.forEach((p, i) => {
            const root = roots[i];
            if (!root) return this.#people.delete(p.id);
            const k = firefighters.findIndex((f) => f.p.id === p.id);
            this.#people.set(p.id, { root, camera: k >= 0 ? cameras[k] : null, visible: p.inside });
        });
        this.#bodyCamListeners.forEach((l) => l());
    }

    //--------------------------------------------------------------------------
    // Fire
    //--------------------------------------------------------------------------
    #syncFire(incident: FireIncident | null): void {
        if (this.#fire && (!incident || incident.id !== this.#fire.incidentId)) {
            const old = this.#fire;
            this.#fire = null;
            this.#ll.scene.deleteEntities({ entities: [old.group, ...(old.light ? [old.light] : [])] }).catch(() => {});
        }
        this.#fireRequest = incident?.id ?? null;
        if (incident && !this.#fire) void this.#createFire(incident);
    }

    async #createFire(f: FireIncident): Promise<void> {
        const groups = this.#groups;
        if (!groups) return;
        const [group] = await this.#makeMany([{ name: `Fire ${f.id}`, parent: groups.incident, components: { local_transform: { position: f.position } } }]);
        if (!group) return;
        const [light] = await this.#makeMany([
            { name: "fire-light", parent: group, components: { local_transform: { position: [0, 2.2, 0] }, point_light: { color: hexToLinear(COLORS.fire), intensity: 6, range: 14 } } },
        ]);
        if (this.#fireRequest !== f.id) {
            this.#ll.scene.deleteEntities({ entities: [group, ...(light ? [light] : [])] }).catch(() => {});
            return;
        }
        this.#fire = { incidentId: f.id, group, light };
    }

    //--------------------------------------------------------------------------
    // 30 Hz: interpolated positions (the body cams ride on them) and the light flicker
    //--------------------------------------------------------------------------
    #animate(): void {
        const now = performance.now();
        for (const [id, v] of this.#people) {
            if (v === "pending" || !v.visible) continue;
            const s = sample(id, now);
            if (s) v.root.local_transform = { position: s.position, orientation: yawQuat(s.heading) };
        }
        if (this.#fire?.light) {
            const t = now / 1000;
            this.#fire.light.point_light = { color: hexToLinear(COLORS.fire), intensity: 5 + 2.5 * Math.abs(Math.sin(t * 7.1) * Math.sin(t * 3.3)), range: 14 };
        }
    }
}
