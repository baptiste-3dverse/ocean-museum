//------------------------------------------------------------------------------
// Smooth positions between two feed snapshots (10 Hz) for display (30+ Hz).
// Shared by the 3D markers, the labels and the camera.
//------------------------------------------------------------------------------
import type { Vec3 } from "../building/building";
import type { PeopleSnapshot } from "../simulation/types";
import { lerp3, lerpAngle } from "./math";

interface Track {
    from: Vec3;
    to: Vec3;
    fromHeading: number;
    toHeading: number;
}

const tracks = new Map<string, Track>();
let receivedAt = 0;
let interval = 100;

/** Feed a new snapshot: each track starts from where it is drawn now. */
export function pushSnapshot(snapshot: PeopleSnapshot, at: number): void {
    const now = at;
    const dt = receivedAt ? now - receivedAt : 100;
    interval = Math.min(400, Math.max(50, dt));
    for (const p of snapshot.people) {
        const cur = sample(p.id, now);
        tracks.set(p.id, {
            from: cur ? cur.position : p.position,
            to: p.position,
            fromHeading: cur ? cur.heading : p.heading,
            toHeading: p.heading,
        });
    }
    receivedAt = now;
}

export function sample(id: string, now = performance.now()): { position: Vec3; heading: number } | null {
    const t = tracks.get(id);
    if (!t) return null;
    const a = Math.min(1, Math.max(0, (now - receivedAt) / interval));
    return { position: lerp3(t.from, t.to, a), heading: lerpAngle(t.fromHeading, t.toHeading, a) };
}
