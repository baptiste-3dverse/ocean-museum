//------------------------------------------------------------------------------
// Scene, assets and tuning shared by every module.
//------------------------------------------------------------------------------

/** The Ocean Museum scene (IFC, cut in section by a culling box). */
export const SCENE_ID = "c3809f0f-1246-42a2-a195-f214da250ffa";
/** Public, read-only token of this app. */
export const PUBLIC_TOKEN = "public_UFQSaEJ2N7XO3pqT";

/** Public 3dverse assets, readable by any token. */
export const ASSETS = {
    /** "PBR Opaque Uber Material": albedo / emission / opacity inputs. */
    pbrShader: "f2a549e5-4f72-4cef-a5ab-48873c209e0c",
    /** "default pbr render graph": edge outlines, bloom, exposure… */
    renderGraph: "398ee642-030a-45e7-95df-7147f6c43392",
} as const;

/** One colour code, used in 3D and in the UI. */
export const COLORS = {
    firefighter: "#ff8a1f",
    fire: "#ff2b2b",
    extinguisher: "#21ff8a",
    route: "#21ff8a",
    visitor: "#f2f8ff",
    staff: "#c8d4ff",
    security: "#3f8cff",
    medic: "#d06bff",
    edge: "#22d3ee",
} as const;

export const SIMULATION = {
    /** Positions are published at this rate (Hz). */
    tickHz: 10,
    /** Danger radius around a fire (m). */
    dangerRadius: 6,
    /** A route to an extinguisher is drawn when it is at most this far, walking (m). */
    routeMaxDistance: 20,
    /** Route recomputed when the firefighter moved this much (m) or after this delay (ms). */
    routeRecomputeDistance: 0.75,
    routeRecomputeMs: 1000,
} as const;

/** Camera options of the render graph (see the render graph's inputDescriptor). */
export type RenderSettings = Record<string, number | boolean | [number, number, number]>;

/** Look of the main camera: dark, cyan edges, glow on emissive markers. */
export const MAIN_CAMERA_SETTINGS: RenderSettings = {
    displayBackground: false,
    removeBackground: true,
    removedBackgroundColor: [0.012, 0.024, 0.04],
    edgeOutlines: true,
    edgeColor: [0.13, 0.83, 0.93],
    edgeStrength: 1,
    edgeOnSelf: true,
    bloom: true,
    bloomStrength: 0.05,
    bloomThreshold: 1,
    bcs: true,
    imageBrightness: 0.42,
    imageContrast: 1.25,
    imageSaturation: 0.35,
    ambientIntensity: 0.6,
    hbao: true,
    grid: false,
    selectionOutlines: true,
};

/** Body cams: same look, a bit brighter so the firefighter's view stays readable. */
export const BODY_CAM_SETTINGS: RenderSettings = {
    ...MAIN_CAMERA_SETTINGS,
    // a floor grid at the firefighter's level (gridHeight is updated when they change floors):
    // where the section box hides the building, the body cam still shows the floor plane
    grid: true,
    gridHeight: 0,
    imageBrightness: 1.1,
    imageContrast: 1.15,
    imageSaturation: 0.55,
    ambientIntensity: 1.6,
    bloomStrength: 0.04,
};
