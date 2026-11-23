import { createContext, useContext, useEffect, useState } from "react";
import type { Entity } from "@3dverse/livelink";
import type { TwinRenderer } from "./TwinRenderer";

export const RendererContext = createContext<TwinRenderer | null>(null);

export function useTwinRenderer(): TwinRenderer | null {
    return useContext(RendererContext);
}

/** The body cam entity of a firefighter, once it exists. */
export function useBodyCam(personId: string | null): Entity | null {
    const renderer = useTwinRenderer();
    const [, force] = useState(0);
    useEffect(() => renderer?.onBodyCamsChanged(() => force((n) => n + 1)), [renderer]);
    return renderer && personId ? renderer.getBodyCam(personId) : null;
}
