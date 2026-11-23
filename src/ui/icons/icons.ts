//------------------------------------------------------------------------------
// Font Awesome Pro (solid) icons used by the HUD and the 3D overlay.
// Only the path data is used: no Font Awesome runtime, tree-shaken by Vite.
//------------------------------------------------------------------------------
import {
    faFire,
    faFireExtinguisher,
    faLocationPin,
    faRectangleVertical,
    faUser,
    faUserDoctor,
    faUserHelmetSafety,
    faUserShield,
    faUserTie,
    type IconDefinition,
} from "@fortawesome/pro-solid-svg-icons";
import type { Role } from "../../simulation/types";

export const ROLE_ICON: Record<Role, IconDefinition> = {
    visitor: faUser,
    staff: faUserTie,
    security: faUserShield,
    medic: faUserDoctor,
    firefighter: faUserHelmetSafety,
};

export const ICONS = {
    fire: faFire,
    extinguisher: faFireExtinguisher,
    pin: faLocationPin,
    frame: faRectangleVertical,
};

/** Width, height and SVG path of an icon. */
export function iconShape(def: IconDefinition): { w: number; h: number; d: string } {
    const [w, h, , , path] = def.icon;
    return { w, h, d: Array.isArray(path) ? path.join(" ") : path };
}
