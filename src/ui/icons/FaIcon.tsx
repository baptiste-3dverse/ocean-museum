import type { IconDefinition } from "@fortawesome/pro-solid-svg-icons";
import { iconShape } from "./icons";

/** An inline Font Awesome icon, coloured with currentColor. */
export function FaIcon({ icon, size = 12, className }: { icon: IconDefinition; size?: number; className?: string }) {
    const { w, h, d } = iconShape(icon);
    return (
        <svg className={className} viewBox={`0 0 ${w} ${h}`} width={(size * w) / h} height={size} fill="currentColor" aria-hidden="true">
            <path d={d} />
        </svg>
    );
}
