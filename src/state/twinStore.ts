//------------------------------------------------------------------------------
// App state: one small external store shared by the UI (React) and the 3D layer
// (plain subscriptions, no React re-render per frame).
//------------------------------------------------------------------------------
import { useSyncExternalStore } from "react";
import type { PathPoint } from "../pathfinding/NavGraph";
import type { FloorId } from "../building/building";
import type { FeedStatus, FireIncident, PeopleSnapshot, Role } from "../simulation/types";

/** How people are drawn: a pin (halo, stem, head) or a frame (an upright rectangle that turns with them). */
export type MarkerStyle = "pin" | "frame";

export interface ExtinguisherRoute {
    personId: string;
    extinguisherId: string;
    /** Walking distance (m). */
    distance: number;
    /** Estimated time of arrival (s). */
    eta: number;
    points: PathPoint[];
    /** Within the distance where the route is drawn. */
    inRange: boolean;
}

export interface TwinState {
    snapshot: PeopleSnapshot;
    /** performance.now() when the snapshot arrived (for interpolation). */
    receivedAt: number;
    feedStatus: FeedStatus;
    feedLabel: string;
    /** Measured snapshot rate (Hz). */
    feedRate: number;
    incident: FireIncident | null;
    routes: Record<string, ExtinguisherRoute>;
    selectedId: string | null;
    roleFilter: Role | null;
    /** The next click in the 3D view places a fire. */
    placingFire: boolean;
    /** The camera follows the selected person. */
    follow: boolean;
    markerStyle: MarkerStyle;
    /** Only this floor is shown in full; people of other floors are faded. */
    focusFloor: FloorId | null;
}

const STYLE_KEY = "ocean-twin.markerStyle";
function savedStyle(): MarkerStyle {
    try {
        return localStorage.getItem(STYLE_KEY) === "frame" ? "frame" : "pin";
    } catch {
        return "pin";
    }
}
export function saveStyle(style: MarkerStyle): void {
    try {
        localStorage.setItem(STYLE_KEY, style);
    } catch {
        // private window: the choice just isn't remembered
    }
}

type Listener = () => void;

class Store {
    #state: TwinState = {
        snapshot: { timestamp: 0, people: [] },
        receivedAt: 0,
        feedStatus: "connecting",
        feedLabel: "",
        feedRate: 0,
        incident: null,
        routes: {},
        selectedId: null,
        roleFilter: null,
        placingFire: false,
        follow: false,
        markerStyle: savedStyle(),
        focusFloor: null,
    };
    #listeners = new Set<Listener>();

    getState = (): TwinState => this.#state;

    setState = (patch: Partial<TwinState>): void => {
        this.#state = { ...this.#state, ...patch };
        this.#listeners.forEach((l) => l());
    };

    subscribe = (listener: Listener): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };
}

export const twinStore = new Store();

/** React hook: re-renders when the selected value changes (compare by reference). */
export function useTwin<T>(selector: (s: TwinState) => T): T {
    return useSyncExternalStore(twinStore.subscribe, () => selector(twinStore.getState()));
}
