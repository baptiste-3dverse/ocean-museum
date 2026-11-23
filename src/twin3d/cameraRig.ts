//------------------------------------------------------------------------------
// Camera moves. The building is cut along a plane facing north (+Z): the camera
// always looks at the section from the north side.
//------------------------------------------------------------------------------
import type { DefaultCameraController } from "@3dverse/livelink-react";
import { building, getFloor, type FloorId, type Vec3 } from "../building/building";

let controller: DefaultCameraController | null = null;

export function setCameraController(c: DefaultCameraController | null): void {
    controller = c;
    if (import.meta.env.DEV) Object.assign(window, { __cam: c });
}

const sectionCenterX = (building.section.min[0] + building.section.max[0]) / 2;
const sectionCenterZ = (building.section.min[2] + building.section.max[2]) / 2;
/** The side panel covers the right of the screen: aim a bit right so the building sits in the free area. */
const AIM_X = sectionCenterX + 7;
const OVERVIEW = { eye: [AIM_X + 6, 29, 115] as Vec3, target: [AIM_X, 3, sectionCenterZ] as Vec3 };

/** The whole section, all floors. */
export function overview(animate = true): void {
    const { eye, target } = OVERVIEW;
    controller?.setLookAt(eye[0], eye[1], eye[2], target[0], target[1], target[2], animate);
}

/**
 * Sets the overview once the controller really drives the camera: a look-at
 * given too early is overwritten when the controller binds to the camera.
 */
export function initialView(): void {
    let tries = 0;
    const id = setInterval(() => {
        if (!controller || ++tries > 20) return clearInterval(id);
        // camera-controls creates the output vector when none is given
        const p = (controller.getPosition as unknown as (this: DefaultCameraController) => { toArray(): number[] }).call(controller);
        const q = p.toArray();
        if (Math.hypot(q[0] - OVERVIEW.eye[0], q[1] - OVERVIEW.eye[1], q[2] - OVERVIEW.eye[2]) < 0.5) return clearInterval(id);
        overview(false);
    }, 250);
}

/**
 * One floor, looked at almost level through the cut face, so its rooms are seen
 * between their floor and the slab above (from higher up, that slab hides them).
 */
export function focusFloor(floorId: FloorId): void {
    const y = getFloor(floorId).y;
    controller?.setLookAt(AIM_X + 4, y + 6, building.section.max[2] + 52, AIM_X, y + 1.2, sectionCenterZ, true);
}

/**
 * Close-up on a position (a person, the fire). The eye stays north of the cut
 * face, so the walls of the section never stand between the camera and the target.
 */
export function flyTo(p: Vec3, distance = 16): void {
    const eyeZ = Math.max(p[2] + distance, building.section.max[2] + distance * 0.75);
    controller?.setLookAt(p[0] + 3, p[1] + distance * 0.4, eyeZ, p[0], p[1] + 1, p[2], true);
}

/** Keeps the current viewing angle and moves the target (follow mode). */
export function follow(p: Vec3): void {
    controller?.moveTo(p[0], p[1] + 1, p[2], true);
}
