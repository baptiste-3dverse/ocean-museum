//------------------------------------------------------------------------------
// Small controllers that live inside the main viewport.
//------------------------------------------------------------------------------
import { useContext, useEffect } from "react";
import { ViewportContext } from "@3dverse/livelink-react";
import { floorAtHeight } from "../building/building";
import { triggerFire } from "../state/controller";
import { useTwin } from "../state/twinStore";
import { flyTo, follow } from "./cameraRig";
import { sample } from "./motion";

/** Flies to the selected person; keeps them in view in follow mode. */
export function CameraDirector() {
    const selectedId = useTwin((s) => s.selectedId);
    const following = useTwin((s) => s.follow);

    useEffect(() => {
        if (!selectedId) return;
        const s = sample(selectedId);
        if (s) flyTo(s.position);
    }, [selectedId]);

    useEffect(() => {
        if (!following || !selectedId) return;
        const id = setInterval(() => {
            const s = sample(selectedId);
            if (s) follow(s.position);
        }, 200);
        return () => clearInterval(id);
    }, [following, selectedId]);

    return null;
}

/** "Place on map": the next click in the 3D view starts a fire where it hits. */
export function FirePlacement() {
    const { viewport } = useContext(ViewportContext);
    const placing = useTwin((s) => s.placingFire);

    useEffect(() => {
        if (!placing || !viewport) return;
        const el = viewport.dom_element;
        el.style.cursor = "crosshair";
        let down: { x: number; y: number } | null = null;
        const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
        const onUp = async (e: PointerEvent) => {
            if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // a drag, not a click
            const hit = await viewport.castScreenSpaceRay({ screen_position: viewport.getScreenPositionFromEvent({ event: e }), mode: "None" });
            if (!hit) return;
            const [x, y, z] = hit.world_position;
            const floor = floorAtHeight(y);
            triggerFire(floor.id, [x, floor.y, z]);
        };
        el.addEventListener("pointerdown", onDown);
        el.addEventListener("pointerup", onUp);
        return () => {
            el.style.cursor = "";
            el.removeEventListener("pointerdown", onDown);
            el.removeEventListener("pointerup", onUp);
        };
    }, [placing, viewport]);

    return null;
}
