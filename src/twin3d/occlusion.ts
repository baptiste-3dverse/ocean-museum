//------------------------------------------------------------------------------
// Occlusion: is a point hidden from a camera by the building?
//
// The overlay is drawn on top of the 3D view, so it has to know itself whether a
// person is behind a wall or under a floor. The test uses the building's own
// geometry (walls, columns, slabs, roofs, ceilings), extracted from the scene and
// clipped to the section box, which is all that is rendered. A line that crosses
// a wall through one of its openings (door, window, arch) is not blocked.
//------------------------------------------------------------------------------
import { building, type Vec3 } from "../building/building";

const N = building.occluders.length;
const boxes = new Float32Array(N * 6);
const axes = new Int8Array(N);
const holes: Array<Float32Array | null> = new Array(N);
building.occluders.forEach((o, i) => {
    boxes.set(o.b, i * 6);
    axes[i] = o.a ?? -1;
    holes[i] = o.h ? Float32Array.from(o.h.flat()) : null;
});

/**
 * True if nothing of the building stands between `eye` and `target`. The last
 * `margin` metres before the target are ignored (the person's own floor, a door
 * frame they are standing in).
 */
export function lineOfSight(eye: Readonly<Vec3>, target: Vec3, margin = 0.35): boolean {
    const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len <= margin) return true;
    const tEnd = 1 - margin / len;
    const lo = [Math.min(eye[0], target[0]), Math.min(eye[1], target[1]), Math.min(eye[2], target[2])];
    const hi = [Math.max(eye[0], target[0]), Math.max(eye[1], target[1]), Math.max(eye[2], target[2])];
    for (let i = 0; i < N; i++) {
        const k = i * 6;
        if (boxes[k + 3] < lo[0] || boxes[k] > hi[0] || boxes[k + 4] < lo[1] || boxes[k + 1] > hi[1] || boxes[k + 5] < lo[2] || boxes[k + 2] > hi[2]) continue;
        // slab test: [t0, t1] is where the segment is inside the box
        let t0 = 0;
        let t1 = tEnd;
        let miss = false;
        for (let j = 0; j < 3 && !miss; j++) {
            const bmin = boxes[k + j];
            const bmax = boxes[k + 3 + j];
            if (Math.abs(d[j]) < 1e-9) {
                miss = eye[j] < bmin || eye[j] > bmax;
                continue;
            }
            let ta = (bmin - eye[j]) / d[j];
            let tb = (bmax - eye[j]) / d[j];
            if (ta > tb) [ta, tb] = [tb, ta];
            t0 = Math.max(t0, ta);
            t1 = Math.min(t1, tb);
            miss = t0 > t1;
        }
        if (miss) continue;
        const h = holes[i];
        if (h) {
            const tm = (t0 + t1) / 2;
            const along = eye[axes[i]] + d[axes[i]] * tm;
            const y = eye[1] + d[1] * tm;
            let through = false;
            for (let q = 0; q < h.length && !through; q += 4) through = along >= h[q] && along <= h[q + 1] && y >= h[q + 2] && y <= h[q + 3];
            if (through) continue;
        }
        return false;
    }
    return true;
}

/** A person is in view if their head or their chest can be seen. */
export function personInView(eye: Readonly<Vec3>, feet: Vec3): boolean {
    return lineOfSight(eye, [feet[0], feet[1] + 1.7, feet[2]]) || lineOfSight(eye, [feet[0], feet[1] + 1.0, feet[2]]);
}

/** Keeps a visibility state stable: it only flips after a few identical answers in a row. */
export class VisibilityTracker {
    #state = new Map<string, { visible: boolean; streak: number }>();

    update(id: string, visible: boolean, needed = 3): boolean {
        const s = this.#state.get(id);
        if (!s) {
            this.#state.set(id, { visible, streak: 0 });
            return visible;
        }
        if (visible === s.visible) s.streak = 0;
        else if (++s.streak >= needed) {
            s.visible = visible;
            s.streak = 0;
        }
        return s.visible;
    }

    get(id: string): boolean {
        return this.#state.get(id)?.visible ?? true;
    }
}
