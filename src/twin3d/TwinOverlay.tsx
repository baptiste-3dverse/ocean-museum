//------------------------------------------------------------------------------
// What the twin draws over the 3D view, projected through the viewport's camera
// every frame (main view and body cams):
//   - people, in two styles:
//       pin    a halo on the floor, a stem and a head
//       frame  an upright rectangle facing where the person walks, with their
//              role icon inside: it turns with them, and a tick on the floor
//              marks their front
//     firefighters also get a heading arrow on the floor
//   - the fire: a pulsing beacon and its danger radius on the floor
//   - extinguishers: a marker on the wall and a plate on the floor
//   - routes to the nearest extinguisher: an animated glowing line on the floor
//   - labels, placed by priority so they never overlap
//
// Occlusion: the overlay is drawn on top of the 3D view, so it tests itself, with
// the building geometry, whether each person can be seen from the camera
// (occlusion.ts). Hidden people are drawn dashed and faded, and their labels give
// way to the people in view. When a floor is isolated, the others fade out.
//------------------------------------------------------------------------------
import { useContext, useEffect, useMemo, useRef } from "react";
import { ViewportContext } from "@3dverse/livelink-react";
import { building, getFloor, type Vec3 } from "../building/building";
import { COLORS } from "../config";
import type { Person } from "../simulation/types";
import { select } from "../state/controller";
import { twinStore, useTwin, type MarkerStyle } from "../state/twinStore";
import { formatDistance, formatDuration } from "../ui/format";
import { FaIcon } from "../ui/icons/FaIcon";
import { ICONS, ROLE_ICON, iconShape } from "../ui/icons/icons";
import { flyTo } from "./cameraRig";
import { sample } from "./motion";
import { personInView, VisibilityTracker } from "./occlusion";
import { ROLE_COLOR } from "./TwinRenderer";

type Mat = ArrayLike<number>;
interface Pt {
    x: number;
    y: number;
    w: number;
}

const HEAD = 1.75;
const FRAME_H = 1.85;
const PAD = 3;

function project(m: Mat, W: number, H: number, p: Vec3): Pt | null {
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 0.05) return null;
    const x = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w;
    const y = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w;
    return { x: ((x + 1) / 2) * W, y: ((1 - y) / 2) * H, w };
}

const pts = (list: Array<Pt | null>): string | null => (list.some((p) => !p) ? null : (list as Pt[]).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));

/** A circle lying on the floor, as screen points; null if part of it is behind the camera. */
function floorCircle(m: Mat, W: number, H: number, c: Vec3, r: number, n = 20): string | null {
    const list: Array<Pt | null> = [];
    for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        list.push(project(m, W, H, [c[0] + Math.cos(a) * r, c[1], c[2] + Math.sin(a) * r]));
    }
    return pts(list);
}

type LabelKind = "person" | "extinguisher" | "fire" | "route";
interface LabelItem {
    key: string;
    kind: LabelKind;
    color: string;
    priority: () => number;
    anchor: () => Vec3 | null;
    personId?: string;
}

/**
 * @param ownerId  body cam mode: the wearer is not drawn, only their own route is
 * @param floorId  only draw people and extinguishers of this floor
 */
export function TwinOverlay({ labels = true, ownerId = null, floorId = null, compact = false }: { labels?: boolean; ownerId?: string | null; floorId?: string | null; compact?: boolean }) {
    const { viewport } = useContext(ViewportContext);
    const people = useTwin((s) => s.snapshot.people);
    const incident = useTwin((s) => s.incident);
    const routes = useTwin((s) => s.routes);
    const placing = useTwin((s) => s.placingFire);
    const style = useTwin((s) => s.markerStyle);
    const focusFloor = useTwin((s) => (ownerId ? null : s.focusFloor));

    const container = useRef<HTMLDivElement>(null);
    const els = useRef(new Map<string, Element>());
    const bind = (key: string) => (el: Element | null) => {
        if (el) els.current.set(key, el);
        else els.current.delete(key);
    };
    const visibility = useRef(new VisibilityTracker());

    const shown = useMemo(() => people.filter((p) => p.inside && p.id !== ownerId && (!floorId || p.floorId === floorId)), [people, ownerId, floorId]);
    const activeRoutes = useMemo(() => Object.values(routes).filter((r) => r.inRange && (!ownerId || r.personId === ownerId)), [routes, ownerId]);
    const extinguishers = useMemo(() => building.extinguishers.filter((e) => (!floorId || e.floorId === floorId) && (!focusFloor || e.floorId === focusFloor)), [floorId, focusFloor]);

    const labelItems = useMemo<LabelItem[]>(() => {
        if (!labels) return [];
        const list: LabelItem[] = [];
        if (incident) list.push({ key: "fire", kind: "fire", color: COLORS.fire, priority: () => 100, anchor: () => [incident.position[0], incident.position[1] + 3.2, incident.position[2]] });
        for (const r of activeRoutes) {
            const ext = building.extinguishers.find((e) => e.id === r.extinguisherId);
            const onFocus = () => {
                const focus = ownerId ? null : twinStore.getState().focusFloor;
                return !focus || r.points.some((q) => q.floorId === focus);
            };
            if (ext) list.push({ key: `route-${r.personId}`, kind: "route", color: COLORS.route, priority: () => (onFocus() ? 80 : 0), anchor: () => [ext.position[0], ext.position[1] + 0.6, ext.position[2]] });
        }
        for (const p of shown) {
            const base = p.role === "firefighter" ? 60 : p.role === "visitor" ? 30 : 40;
            list.push({
                key: p.id,
                kind: "person",
                personId: p.id,
                color: ROLE_COLOR[p.role],
                priority: () => {
                    const { selectedId: sel, roleFilter, focusFloor: focus } = twinStore.getState();
                    if (p.id === sel) return 90;
                    if ((!ownerId && focus && p.floorId !== focus) || (roleFilter && roleFilter !== p.role)) return 0;
                    return visibility.current.get(p.id) ? base : base - 25;
                },
                anchor: () => {
                    const s = sample(p.id);
                    return s ? [s.position[0], s.position[1] + (style === "frame" ? FRAME_H : HEAD) + 0.15, s.position[2]] : null;
                },
            });
        }
        for (const e of extinguishers) list.push({ key: e.id, kind: "extinguisher", color: COLORS.extinguisher, priority: () => 20, anchor: () => [e.position[0], e.position[1] + 0.45, e.position[2]] });
        return list;
    }, [labels, shown, incident, activeRoutes, extinguishers, style, ownerId]);

    const frame = useRef({ shown, activeRoutes, labelItems, extinguishers, style, focusFloor });
    frame.current = { shown, activeRoutes, labelItems, extinguishers, style, focusFloor };

    useEffect(() => {
        if (!viewport) return;
        let raf = 0;
        let tick = 0;
        const draw = () => {
            raf = requestAnimationFrame(draw);
            const cam = viewport.camera_projection;
            const root = container.current;
            if (!cam || !root) return;
            const W = root.clientWidth;
            const H = root.clientHeight;
            const m = cam.clip_from_world_matrix;
            const eye = cam.world_position;
            const t = performance.now() / 1000;
            const { selectedId: sel, roleFilter, incident: fire } = twinStore.getState();
            const { shown: list, style: markerStyle, focusFloor: focus } = frame.current;
            const get = (k: string) => els.current.get(k);
            const setPts = (k: string, value: string | null) => {
                const el = get(k);
                if (!el) return;
                if (value) {
                    el.setAttribute("points", value);
                    el.setAttribute("visibility", "visible");
                } else el.setAttribute("visibility", "hidden");
            };
            const checkOcclusion = tick++ % 3 === 0;

            // people
            for (const p of list) {
                const s = sample(p.id);
                const g = get(`g-${p.id}`);
                if (!s || !g) continue;
                const foot: Vec3 = [s.position[0], s.position[1] + 0.03, s.position[2]];
                const ff = p.role === "firefighter";
                const inView = checkOcclusion ? visibility.current.update(p.id, personInView(eye, s.position)) : visibility.current.get(p.id);
                g.classList.toggle("is-occluded", !inView);
                g.classList.toggle("is-other-floor", !!focus && p.floorId !== focus && p.id !== sel);
                g.classList.toggle("is-filtered", !!roleFilter && roleFilter !== p.role && p.id !== sel);
                setPts(`sel-${p.id}`, p.id === sel ? floorCircle(m, W, H, foot, 0.95 + 0.08 * Math.sin(t * 5), 24) : null);
                const f: Vec3 = [-Math.sin(s.heading), 0, -Math.cos(s.heading)];
                const r: Vec3 = [-f[2], 0, f[0]];
                const at = (along: number, side: number, up = 0): Vec3 => [foot[0] + f[0] * along + r[0] * side, foot[1] + up, foot[2] + f[2] * along + r[2] * side];
                if (ff) setPts(`arrow-${p.id}`, pts([at(1.7, 0), at(0.75, 0.42), at(0.95, 0), at(0.75, -0.42)].map((q) => project(m, W, H, q))));

                if (markerStyle === "pin") {
                    setPts(`halo-${p.id}`, floorCircle(m, W, H, foot, ff ? 0.6 : 0.42, 18));
                    const a = project(m, W, H, foot);
                    const b = project(m, W, H, [s.position[0], s.position[1] + HEAD, s.position[2]]);
                    const stem = get(`stem-${p.id}`);
                    const head = get(`head-${p.id}`);
                    if (a && b && stem && head) {
                        stem.setAttribute("x1", a.x.toFixed(1));
                        stem.setAttribute("y1", a.y.toFixed(1));
                        stem.setAttribute("x2", b.x.toFixed(1));
                        stem.setAttribute("y2", b.y.toFixed(1));
                        head.setAttribute("cx", b.x.toFixed(1));
                        head.setAttribute("cy", b.y.toFixed(1));
                        head.setAttribute("r", Math.max(2.5, Math.min(9, (ff ? 260 : 200) / b.w)).toFixed(1));
                        g.setAttribute("visibility", "visible");
                    } else g.setAttribute("visibility", "hidden");
                } else {
                    // upright rectangle facing the walking direction
                    const half = ff ? 0.4 : 0.35;
                    const quad = pts([at(0, -half), at(0, half), at(0, half, FRAME_H), at(0, -half, FRAME_H)].map((q) => project(m, W, H, q)));
                    setPts(`frame-${p.id}`, quad);
                    setPts(`tick-${p.id}`, pts([at(0.62, 0), at(0.3, 0.16), at(0.3, -0.16)].map((q) => project(m, W, H, q))));
                    const icon = get(`icon-${p.id}`);
                    const bottom = project(m, W, H, at(0, 0));
                    const top = project(m, W, H, at(0, 0, FRAME_H));
                    const left = project(m, W, H, at(0, -half, 1));
                    const right = project(m, W, H, at(0, half, 1));
                    const center = project(m, W, H, at(0, 0, 1));
                    if (quad && icon && bottom && top && left && right && center) {
                        const hpx = Math.hypot(top.x - bottom.x, top.y - bottom.y);
                        // how much of the rectangle's face we see: 1 face-on, 0 edge-on
                        const facing = Math.min(1, Math.hypot(right.x - left.x, right.y - left.y) / Math.max(1e-3, (hpx * 2 * half) / FRAME_H));
                        const ih = Math.max(7, Math.min(30, hpx * 0.36));
                        const iw = ih * Number(icon.getAttribute("data-ratio")) * Math.max(0.18, facing);
                        icon.setAttribute("x", (center.x - iw / 2).toFixed(1));
                        icon.setAttribute("y", (center.y - ih / 2).toFixed(1));
                        icon.setAttribute("width", iw.toFixed(1));
                        icon.setAttribute("height", ih.toFixed(1));
                        g.setAttribute("visibility", "visible");
                    } else g.setAttribute("visibility", "hidden");
                }
            }

            // fire
            if (fire) {
                const base: Vec3 = [fire.position[0], fire.position[1] + 0.04, fire.position[2]];
                setPts("fire-zone", floorCircle(m, W, H, base, fire.radius, 64));
                setPts("fire-ring", floorCircle(m, W, H, base, fire.radius * (0.15 + ((t * 0.45) % 1) * 0.85), 48));
                const a = project(m, W, H, base);
                const b = project(m, W, H, [fire.position[0], fire.position[1] + 4, fire.position[2]]);
                const c = project(m, W, H, [fire.position[0], fire.position[1] + 1, fire.position[2]]);
                const beam = get("fire-beam");
                const core = get("fire-core");
                const glyph = get("fire-icon");
                if (a && b && c && beam && core && glyph) {
                    beam.setAttribute("x1", a.x.toFixed(1));
                    beam.setAttribute("y1", a.y.toFixed(1));
                    beam.setAttribute("x2", b.x.toFixed(1));
                    beam.setAttribute("y2", b.y.toFixed(1));
                    const rr = Math.max(6, Math.min(26, 700 / c.w)) * (1 + 0.25 * Math.sin(t * 8.2));
                    core.setAttribute("cx", c.x.toFixed(1));
                    core.setAttribute("cy", c.y.toFixed(1));
                    core.setAttribute("r", rr.toFixed(1));
                    glyph.setAttribute("x", (c.x - rr * 0.55).toFixed(1));
                    glyph.setAttribute("y", (c.y - rr * 0.62).toFixed(1));
                    glyph.setAttribute("width", (rr * 1.1).toFixed(1));
                    glyph.setAttribute("height", (rr * 1.25).toFixed(1));
                    for (const el of [beam, core, glyph]) el.setAttribute("visibility", "visible");
                } else for (const el of [beam, core, glyph]) el?.setAttribute("visibility", "hidden");
            }

            // extinguishers
            for (const e of frame.current.extinguishers) {
                const floorY = getFloor(e.floorId).y;
                setPts(`ext-plate-${e.id}`, floorCircle(m, W, H, [e.position[0] + e.facing[0] * 0.3, floorY + 0.03, e.position[2] + e.facing[1] * 0.3], 0.35, 12));
                const q = project(m, W, H, e.position);
                const mark = get(`ext-mark-${e.id}`);
                if (!mark) continue;
                if (q) {
                    const sz = Math.max(3, Math.min(10, 160 / q.w));
                    mark.setAttribute("x", (q.x - sz / 2).toFixed(1));
                    mark.setAttribute("y", (q.y - sz).toFixed(1));
                    mark.setAttribute("width", sz.toFixed(1));
                    mark.setAttribute("height", (sz * 1.6).toFixed(1));
                    mark.setAttribute("visibility", "visible");
                } else mark.setAttribute("visibility", "hidden");
            }

            // routes
            for (const r of frame.current.activeRoutes) {
                const line = pts(r.points.map((q) => project(m, W, H, [q.p[0], q.p[1] + 0.05, q.p[2]])));
                setPts(`route-${r.personId}`, line);
                setPts(`route-glow-${r.personId}`, line);
                get(`route-g-${r.personId}`)?.classList.toggle("is-other-floor", !!focus && !r.points.some((q) => q.floorId === focus));
            }

            if (labels) placeLabels(frame.current.labelItems, els.current, m, W, H, (id) => visibility.current.get(id));
        };
        draw();
        return () => cancelAnimationFrame(raf);
    }, [viewport, labels]);

    const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
    const fireIcon = iconShape(ICONS.fire);

    return (
        <div ref={container} className={`overlay ${compact ? "overlay--compact" : ""} ${placing ? "is-placing" : ""}`}>
            <svg className="overlay__svg">
                <defs>
                    <filter id="ov-glow" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur stdDeviation="2.2" result="b" />
                        <feMerge>
                            <feMergeNode in="b" />
                            <feMergeNode in="SourceGraphic" />
                        </feMerge>
                    </filter>
                </defs>
                {incident && (
                    <g className="ov-fire">
                        <polygon ref={bind("fire-zone")} className="ov-fire__zone" />
                        <polygon ref={bind("fire-ring")} className="ov-fire__ring" />
                        <line ref={bind("fire-beam")} className="ov-fire__beam" />
                        <circle ref={bind("fire-core")} className="ov-fire__core" filter="url(#ov-glow)" />
                        <svg ref={bind("fire-icon")} viewBox={`0 0 ${fireIcon.w} ${fireIcon.h}`} preserveAspectRatio="none" className="ov-fire__icon">
                            <path d={fireIcon.d} />
                        </svg>
                    </g>
                )}
                <g className="ov-routes" filter="url(#ov-glow)">
                    {activeRoutes.map((r) => (
                        <g key={r.personId} ref={bind(`route-g-${r.personId}`)}>
                            <polyline ref={bind(`route-glow-${r.personId}`)} className="ov-route__base" />
                            <polyline ref={bind(`route-${r.personId}`)} className="ov-route__flow" />
                        </g>
                    ))}
                </g>
                <g className="ov-ext">
                    {extinguishers.map((e) => (
                        <g key={e.id}>
                            <polygon ref={bind(`ext-plate-${e.id}`)} className="ov-ext__plate" />
                            <rect ref={bind(`ext-mark-${e.id}`)} className="ov-ext__mark" rx="1.5" />
                        </g>
                    ))}
                </g>
                <g className="ov-people">
                    {shown.map((p) => (
                        <PersonMarker key={`${p.id}-${style}`} p={p} style={style} bind={bind} />
                    ))}
                </g>
            </svg>
            {labels && <Labels items={labelItems} bind={bind} peopleById={peopleById} />}
        </div>
    );
}

function PersonMarker({ p, style, bind }: { p: Person; style: MarkerStyle; bind: (k: string) => (el: Element | null) => void }) {
    const color = ROLE_COLOR[p.role];
    const ff = p.role === "firefighter";
    if (style === "frame") {
        const icon = iconShape(ROLE_ICON[p.role]);
        return (
            <g ref={bind(`g-${p.id}`)} style={{ color }} className={`ov-person ov-person--frame ${ff ? "ov-person--ff" : ""}`}>
                <polygon ref={bind(`sel-${p.id}`)} className="ov-person__sel" />
                {ff && <polygon ref={bind(`arrow-${p.id}`)} className="ov-person__arrow" />}
                <polygon ref={bind(`tick-${p.id}`)} className="ov-person__tick" />
                <polygon ref={bind(`frame-${p.id}`)} className="ov-person__frame" />
                <svg ref={bind(`icon-${p.id}`)} viewBox={`0 0 ${icon.w} ${icon.h}`} preserveAspectRatio="none" data-ratio={icon.w / icon.h} className="ov-person__icon">
                    <path d={icon.d} />
                </svg>
            </g>
        );
    }
    return (
        <g ref={bind(`g-${p.id}`)} style={{ color }} className={`ov-person ${ff ? "ov-person--ff" : ""}`}>
            <polygon ref={bind(`sel-${p.id}`)} className="ov-person__sel" />
            <polygon ref={bind(`halo-${p.id}`)} className="ov-person__halo" />
            {ff && <polygon ref={bind(`arrow-${p.id}`)} className="ov-person__arrow" />}
            <line ref={bind(`stem-${p.id}`)} className="ov-person__stem" />
            <circle ref={bind(`head-${p.id}`)} className="ov-person__head" />
        </g>
    );
}

//------------------------------------------------------------------------------
// Labels
//------------------------------------------------------------------------------
function placeLabels(items: LabelItem[], els: Map<string, Element>, m: Mat, W: number, H: number, inView: (id: string) => boolean) {
    const projected: Array<{ item: LabelItem; priority: number; x: number; y: number; depth: number }> = [];
    for (const item of items) {
        const label = els.get(`label-${item.key}`) as HTMLElement | undefined;
        const line = els.get(`leader-${item.key}`);
        const a = item.anchor();
        const q = a ? project(m, W, H, a) : null;
        if (!q || q.x < -50 || q.y < -50 || q.x > W + 50 || q.y > H + 50) {
            if (label) label.style.opacity = "0";
            line?.setAttribute("visibility", "hidden");
            continue;
        }
        projected.push({ item, priority: item.priority(), x: q.x, y: q.y, depth: q.w });
    }
    projected.sort((p, q) => q.priority - p.priority || p.depth - q.depth);
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    const free = (r: { x: number; y: number; w: number; h: number }) =>
        r.x >= 2 && r.y >= 2 && r.x + r.w <= W - 2 && r.y + r.h <= H - 2 && placed.every((o) => r.x + r.w + PAD <= o.x || o.x + o.w + PAD <= r.x || r.y + r.h + PAD <= o.y || o.y + o.h + PAD <= r.y);
    for (const { item, priority, x, y } of projected) {
        const label = els.get(`label-${item.key}`) as HTMLElement | undefined;
        const line = els.get(`leader-${item.key}`);
        if (!label) continue;
        if (item.personId) label.classList.toggle("is-behind", !inView(item.personId));
        const w = label.offsetWidth;
        const h = label.offsetHeight;
        const g = 8;
        const spots = [
            { x: x - w / 2, y: y - h - g, w, h },
            { x: x + g, y: y - h / 2, w, h },
            { x: x - w - g, y: y - h / 2, w, h },
            { x: x + g, y: y - h - g, w, h },
            { x: x - w - g, y: y - h - g, w, h },
            { x: x - w / 2, y: y - h - g * 3.5, w, h },
            { x: x - w / 2, y: y + g, w, h },
        ];
        const spot = priority > 5 ? spots.find(free) : undefined;
        if (!spot) {
            label.style.opacity = "0";
            label.style.pointerEvents = "none";
            line?.setAttribute("visibility", "hidden");
            continue;
        }
        placed.push(spot);
        label.style.opacity = "";
        label.style.pointerEvents = "auto";
        label.style.transform = `translate(${spot.x.toFixed(1)}px, ${spot.y.toFixed(1)}px)`;
        if (line) {
            line.setAttribute("x1", x.toFixed(1));
            line.setAttribute("y1", y.toFixed(1));
            line.setAttribute("x2", Math.max(spot.x, Math.min(x, spot.x + w)).toFixed(1));
            line.setAttribute("y2", Math.max(spot.y, Math.min(y, spot.y + h)).toFixed(1));
            line.setAttribute("visibility", "visible");
        }
    }
}

function Labels({ items, bind, peopleById }: { items: LabelItem[]; bind: (k: string) => (el: Element | null) => void; peopleById: Map<string, Person> }) {
    const routes = useTwin((s) => s.routes);
    const incident = useTwin((s) => s.incident);
    const selectedId = useTwin((s) => s.selectedId);
    return (
        <>
            <svg className="overlay__svg">
                {items.map((it) => (
                    <line key={it.key} ref={bind(`leader-${it.key}`)} stroke={it.color} strokeWidth={1} strokeOpacity={0.65} visibility="hidden" />
                ))}
            </svg>
            {items.map((it) => {
                const ref = bind(`label-${it.key}`);
                if (it.kind === "person") {
                    const p = peopleById.get(it.personId!);
                    if (!p) return null;
                    const selected = p.id === selectedId;
                    return (
                        <div key={it.key} ref={ref} className={`hud-label ${selected ? "hud-label--selected" : ""}`} style={{ color: it.color, opacity: 0 }} onClick={() => select(p.id)}>
                            <span className="hud-label__row">
                                <FaIcon icon={ROLE_ICON[p.role]} size={10} />
                                <span className="hud-label__name">{p.callsign ? `${p.callsign} · ${p.name.split(" ").slice(-1)[0]}` : p.name}</span>
                                <span className="hud-label__floor">{p.floorId}</span>
                            </span>
                            {selected && <span className="hud-label__meta">{p.status}</span>}
                        </div>
                    );
                }
                if (it.kind === "fire" && incident) {
                    return (
                        <div key={it.key} ref={ref} className="hud-label hud-label--fire" style={{ opacity: 0 }} onClick={() => flyTo(incident.position, 18)}>
                            <span className="hud-label__row">
                                <FaIcon icon={ICONS.fire} size={12} />
                                <span className="hud-label__name">FIRE</span>
                                <span className="hud-label__floor">{incident.floorId}</span>
                            </span>
                            <span className="hud-label__meta">danger r = {incident.radius} m</span>
                        </div>
                    );
                }
                if (it.kind === "route") {
                    const r = routes[it.key.slice(6)];
                    const ff = r && peopleById.get(r.personId);
                    if (!r || !ff) return null;
                    return (
                        <div key={it.key} ref={ref} className="hud-label hud-label--route" style={{ opacity: 0 }} onClick={() => select(ff.id)}>
                            <span className="hud-label__name">
                                {ff.callsign} → {r.extinguisherId}
                            </span>
                            <span className="hud-label__meta">
                                {formatDistance(r.distance)} · ETA {formatDuration(r.eta)}
                            </span>
                        </div>
                    );
                }
                const ext = building.extinguishers.find((e) => e.id === it.key);
                return (
                    <div key={it.key} ref={ref} className="hud-label hud-label--ext" style={{ opacity: 0 }} onClick={() => ext && flyTo(ext.position, 9)}>
                        <FaIcon icon={ICONS.extinguisher} size={10} />
                        <span className="hud-label__name">{it.key.replace("EXT-", "")}</span>
                    </div>
                );
            })}
        </>
    );
}
