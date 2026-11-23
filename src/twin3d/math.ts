import type { Vec3 } from "../building/building";

export type Quat = [number, number, number, number];

export const qmul = (a: Quat, b: Quat): Quat => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** Rotation around +Y. With heading h, local -Z (forward) points to (-sin h, 0, -cos h). */
export const yawQuat = (h: number): Quat => [0, Math.sin(h / 2), 0, Math.cos(h / 2)];

/** Rotation around +X (positive tilts forward -Z upwards). */
export const pitchQuat = (a: number): Quat => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];

/** Orientation that points local +Z along `d`. */
export function alongQuat(d: Vec3): Quat {
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    const yaw = Math.atan2(d[0], d[2]);
    const pitch = -Math.asin(Math.max(-1, Math.min(1, d[1] / len)));
    return qmul(yawQuat(yaw), pitchQuat(pitch));
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export function lerpAngle(a: number, b: number, t: number): number {
    const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    return a + d * t;
}

/** "#ff8a1f" → linear RGB (the shader works in linear space). */
export function hexToLinear(hex: string): Vec3 {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as Vec3;
}
