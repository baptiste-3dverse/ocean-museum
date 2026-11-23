import { useContext, useEffect, useState, type PropsWithChildren } from "react";
import { LivelinkContext } from "@3dverse/livelink-react";
import { TwinRenderer } from "./TwinRenderer";
import { RendererContext } from "./rendererContext";

/** Creates the DigitalTwin entities for the current Livelink session. */
export function TwinSceneProvider({ children }: PropsWithChildren) {
    const { instance } = useContext(LivelinkContext);
    const [renderer, setRenderer] = useState<TwinRenderer | null>(null);

    useEffect(() => {
        if (!instance) return;
        const r = new TwinRenderer(instance);
        setRenderer(r);
        if (import.meta.env.DEV) Object.assign(window, { __twin: r, __ll: instance }); // debugging from the console
        r.init().catch((err) => console.warn("DigitalTwin: init failed", err));
        return () => {
            r.dispose();
            setRenderer(null);
        };
    }, [instance]);

    return <RendererContext.Provider value={renderer}>{children}</RendererContext.Provider>;
}
