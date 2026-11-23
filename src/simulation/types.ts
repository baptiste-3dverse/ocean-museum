//------------------------------------------------------------------------------
// The data contract between a people feed (simulated or real) and the app.
// The UI and the 3D layer only depend on these types.
//------------------------------------------------------------------------------
import type { FloorId, Vec3 } from "../building/building";

export type Role = "visitor" | "staff" | "security" | "medic" | "firefighter";

export const ROLES: Role[] = ["visitor", "staff", "security", "medic", "firefighter"];

export type PersonStatus =
    // civilians
    | "visiting"
    | "viewing"
    | "on duty"
    | "evacuating"
    | "evacuated"
    // security, medics, firefighters
    | "patrolling"
    | "standby"
    | "responding"
    | "cordon"
    | "staging"
    | "en route"
    | "on scene"
    | "returning";

export interface Person {
    id: string;
    name: string;
    role: Role;
    /** Radio call sign (firefighters). */
    callsign?: string;
    floorId: FloorId;
    /** World position of the feet (m). */
    position: Vec3;
    /** Walking direction, radians around +Y; 0 = facing -Z (north is +Z). */
    heading: number;
    /** Current speed (m/s). */
    speed: number;
    status: PersonStatus;
    /** False once the person has left the building. */
    inside: boolean;
}

export interface PeopleSnapshot {
    /** ms since epoch */
    timestamp: number;
    people: Person[];
}

export interface FireIncident {
    id: string;
    floorId: FloorId;
    position: Vec3;
    roomName: string;
    /** ms since epoch */
    startedAt: number;
    /** Danger radius (m). */
    radius: number;
}

export type FeedStatus = "connecting" | "live" | "offline";

/**
 * Where people positions come from. The app only talks to this interface:
 * swap the simulation for indoor positioning, MQTT or a WebSocket by providing
 * another implementation (see WebSocketPeopleFeed and the README).
 */
export interface PeopleFeed {
    readonly kind: "simulation" | "live";
    readonly label: string;
    connect(): void;
    disconnect(): void;
    /** Called with every new snapshot (at least 5 per second). Returns an unsubscribe function. */
    subscribe(listener: (snapshot: PeopleSnapshot) => void): () => void;
    onStatus(listener: (status: FeedStatus) => void): () => void;
    /** The app tells the feed about the current incident. A simulation reacts to it; a real feed may forward or ignore it. */
    setIncident?(incident: FireIncident | null): void;
}
