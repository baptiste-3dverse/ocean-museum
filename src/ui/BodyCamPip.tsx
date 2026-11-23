//------------------------------------------------------------------------------
// Picture-in-picture: live point of view of the selected firefighter. It is a
// second Livelink viewport, nested in the main one so it is drawn on top, that
// renders the camera entity attached to the firefighter's head.
//------------------------------------------------------------------------------
import { useCallback } from "react";
import { Viewport } from "@3dverse/livelink-react";
import { getFloor, isInsideSection } from "../building/building";
import { select } from "../state/controller";
import { useTwin } from "../state/twinStore";
import { useBodyCam } from "../twin3d/rendererContext";
import { TwinOverlay } from "../twin3d/TwinOverlay";
import { formatDistance, formatDuration, formatHeading } from "./format";

export function BodyCamPip() {
    const person = useTwin((s) => s.snapshot.people.find((p) => p.id === s.selectedId) ?? null);
    const route = useTwin((s) => (s.selectedId ? s.routes[s.selectedId] : undefined));
    const isFirefighter = !!person && person.role === "firefighter" && person.inside;
    const camera = useBodyCam(isFirefighter ? person.id : null);
    // the main camera controller listens on the parent viewport element: keep the PiP's events to itself
    const isolate = useCallback((el: HTMLDivElement | null) => {
        if (!el) return;
        const stop = (e: Event) => e.stopPropagation();
        for (const type of ["pointerdown", "pointerup", "wheel", "contextmenu", "dblclick"]) el.addEventListener(type, stop);
    }, []);
    if (!isFirefighter) return null;

    return (
        <div className="pip" ref={isolate}>
            <div className="pip__header">
                <span className="rec-dot" />
                <span>BODY CAM</span>
                <span className="pip__callsign">{person.callsign}</span>
                <span className="pip__name">{person.name}</span>
                <button className="pip__close" onClick={() => select(null)} aria-label="Close body cam">
                    ×
                </button>
            </div>
            <div className="pip__frame">
                {camera ? (
                    <Viewport key={camera.id} cameraEntity={camera} className="pip__viewport">
                        <TwinOverlay ownerId={person.id} floorId={person.floorId} compact />
                    </Viewport>
                ) : (
                    <div className="pip__wait">Connecting camera…</div>
                )}
                <div className="pip__hud">
                    <div className="pip__reticle" />
                    <div className="pip__compass">{formatHeading(person.heading)}</div>
                    {!isInsideSection(person.position) && <div className="pip__note">OUTSIDE THE SECTION · WALLS HIDDEN BY THE CUT</div>}
                    <div className="pip__bl">
                        <span>{getFloor(person.floorId).label.toUpperCase()}</span>
                        <span>{person.status.toUpperCase()}</span>
                        <span>{person.speed.toFixed(1)} m/s</span>
                    </div>
                    {route && (
                        <div className={`pip__br ${route.inRange ? "is-in-range" : ""}`}>
                            <span>NEAREST EXT {route.extinguisherId}</span>
                            <span>
                                {formatDistance(route.distance)} · ETA {formatDuration(route.eta)}
                            </span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
