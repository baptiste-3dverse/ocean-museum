import { SimulatedPeopleFeed } from "./SimulatedPeopleFeed";
import { WebSocketPeopleFeed } from "./WebSocketPeopleFeed";
import type { PeopleFeed } from "./types";

/**
 * Picks the people feed from the URL:
 *   (default)             the simulation
 *   ?seed=42              the simulation, with another random seed
 *   ?feed=wss://host/path a live WebSocket feed (see WebSocketPeopleFeed)
 */
export function createFeed(search = window.location.search): PeopleFeed {
    const params = new URLSearchParams(search);
    const url = params.get("feed");
    if (url) return new WebSocketPeopleFeed(url);
    return new SimulatedPeopleFeed(Number(params.get("seed") ?? 7));
}
