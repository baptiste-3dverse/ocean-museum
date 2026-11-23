//------------------------------------------------------------------------------
// A real people feed over WebSocket (indoor positioning, an MQTT bridge, …).
//
// Expected messages (JSON):
//   { "type": "snapshot", "timestamp": 1732100000000,
//     "people": [ { "id": "b-17", "name": "…", "role": "visitor",
//                   "floorId": "R0", "position": [x, y, z], "heading": 0.3,
//                   "status": "visiting" } ] }
//   { "type": "person", "person": { …one person… } }      (partial update)
//
// Positions are in scene coordinates (metres, Y up). If your positioning system
// gives (x, y) on a floor plan, convert it once on the server or in `toScene`.
//------------------------------------------------------------------------------
import { building, type Vec3 } from "../building/building";
import { ROLES, type FeedStatus, type FireIncident, type PeopleFeed, type PeopleSnapshot, type Person, type Role } from "./types";

type Incoming = { type: "snapshot"; timestamp?: number; people: Partial<Person>[] } | { type: "person"; person: Partial<Person> };

export class WebSocketPeopleFeed implements PeopleFeed {
    readonly kind = "live";
    readonly label: string;
    readonly #url: string;
    readonly #people = new Map<string, Person>();
    readonly #listeners = new Set<(s: PeopleSnapshot) => void>();
    readonly #statusListeners = new Set<(s: FeedStatus) => void>();
    #socket: WebSocket | null = null;
    #retry: ReturnType<typeof setTimeout> | null = null;
    #closed = false;

    constructor(url: string) {
        this.#url = url;
        this.label = `Live · ${new URL(url).host}`;
    }

    connect(): void {
        this.#closed = false;
        this.#setStatus("connecting");
        const ws = new WebSocket(this.#url);
        this.#socket = ws;
        ws.onopen = () => this.#setStatus("live");
        ws.onmessage = (e) => this.#onMessage(e.data);
        ws.onclose = () => {
            this.#setStatus("offline");
            if (!this.#closed) this.#retry = setTimeout(() => this.connect(), 2000);
        };
        ws.onerror = () => ws.close();
    }

    disconnect(): void {
        this.#closed = true;
        if (this.#retry) clearTimeout(this.#retry);
        this.#socket?.close();
        this.#socket = null;
    }

    subscribe(listener: (s: PeopleSnapshot) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    onStatus(listener: (s: FeedStatus) => void): () => void {
        this.#statusListeners.add(listener);
        return () => this.#statusListeners.delete(listener);
    }

    /** Forwards the alert to the server, which may dispatch it to real responders. */
    setIncident(incident: FireIncident | null): void {
        if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify({ type: "incident", incident }));
    }

    #onMessage(data: unknown): void {
        let msg: Incoming;
        try {
            msg = JSON.parse(String(data)) as Incoming;
        } catch {
            return;
        }
        if (msg.type === "snapshot") {
            this.#people.clear();
            for (const p of msg.people) this.#upsert(p);
        } else if (msg.type === "person") {
            this.#upsert(msg.person);
        }
        const snapshot: PeopleSnapshot = { timestamp: Date.now(), people: [...this.#people.values()] };
        this.#listeners.forEach((l) => l(snapshot));
    }

    #upsert(p: Partial<Person>): void {
        if (!p.id || !p.position) return;
        const prev = this.#people.get(p.id);
        const role: Role = p.role && ROLES.includes(p.role) ? p.role : (prev?.role ?? "visitor");
        const position = this.toScene(p.position);
        this.#people.set(p.id, {
            id: p.id,
            name: p.name ?? prev?.name ?? p.id,
            role,
            callsign: p.callsign ?? prev?.callsign,
            floorId: p.floorId ?? prev?.floorId ?? nearestFloor(position[1]),
            position,
            heading: p.heading ?? prev?.heading ?? 0,
            speed: p.speed ?? 0,
            status: p.status ?? prev?.status ?? "visiting",
            inside: p.inside ?? true,
        });
    }

    /** Converts incoming coordinates to scene coordinates. Identity by default. */
    toScene(p: Vec3): Vec3 {
        return [p[0], p[1], p[2]];
    }

    #setStatus(s: FeedStatus): void {
        this.#statusListeners.forEach((l) => l(s));
    }
}

const nearestFloor = (y: number) => building.floors.reduce((a, b) => (Math.abs(b.y - y) < Math.abs(a.y - y) ? b : a)).id;
