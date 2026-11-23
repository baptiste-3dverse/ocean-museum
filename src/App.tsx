//------------------------------------------------------------------------------
// Ocean Museum — real-time fire-response digital twin.
//
//   building/     geometry extracted from the scene (rooms, doors, stairs, nav grid)
//   pathfinding/  waypoint graph, A* / Dijkstra, extinguisher routes
//   simulation/   people feed interface + simulated feed (+ WebSocket adapter)
//   state/        store and user actions
//   twin3d/       entities under "DigitalTwin", labels, camera
//   ui/           HUD panels
//------------------------------------------------------------------------------
import { useCallback, useEffect, useMemo } from "react";
import { Livelink, Canvas, Viewport, CameraController, useCameraEntity, type DefaultCameraController } from "@3dverse/livelink-react";
import { LoadingOverlay } from "@3dverse/livelink-react-ui";

import { MAIN_CAMERA_SETTINGS, PUBLIC_TOKEN, SCENE_ID } from "./config";
import { createFeed } from "./simulation/createFeed";
import { startTwin } from "./state/controller";
import { TwinSceneProvider } from "./twin3d/TwinScene";
import { useTwinRenderer } from "./twin3d/rendererContext";
import { TwinOverlay } from "./twin3d/TwinOverlay";
import { CameraDirector, FirePlacement } from "./twin3d/ViewportTools";
import { initialView, setCameraController } from "./twin3d/cameraRig";
import { TopBar } from "./ui/TopBar";
import { AlertBanner } from "./ui/AlertBanner";
import { SidePanel } from "./ui/PeoplePanel";
import { IncidentControls } from "./ui/IncidentControls";
import { FloorNav } from "./ui/FloorNav";
import { BodyCamPip } from "./ui/BodyCamPip";
import "./App.css";

export function App() {
    const feed = useMemo(() => createFeed(), []);
    useEffect(() => startTwin(feed), [feed]);

    return (
        <Livelink sceneId={SCENE_ID} token={PUBLIC_TOKEN} isTransient autoJoinExisting={false} LoadingPanel={LoadingOverlay}>
            <TwinSceneProvider>
                <TwinView />
            </TwinSceneProvider>
        </Livelink>
    );
}

function TwinView() {
    const { cameraEntity } = useCameraEntity({
        name: "Operator camera",
        position: [50, 22, 78],
        settings: MAIN_CAMERA_SETTINGS,
        perspective_lens: { fovy: 50, nearPlane: 0.1, farPlane: 0 },
    });
    // the operator camera also lives under DigitalTwin, with everything else the app creates
    const renderer = useTwinRenderer();
    useEffect(() => {
        if (renderer && cameraEntity) renderer.adopt(cameraEntity);
    }, [renderer, cameraEntity]);
    const onController = useCallback((c: DefaultCameraController | undefined) => {
        setCameraController(c ?? null);
        if (c) initialView();
    }, []);

    return (
        <div className="app">
            <Canvas className="app__canvas">
                <Viewport cameraEntity={cameraEntity} className="app__viewport">
                    <CameraController ref={onController} />
                    <TwinOverlay />
                    <CameraDirector />
                    <FirePlacement />
                    <BodyCamPip />
                </Viewport>
            </Canvas>
            <div className="hud">
                <TopBar />
                <AlertBanner />
                <FloorNav />
                <IncidentControls />
                <SidePanel />
            </div>
        </div>
    );
}

export default App;
