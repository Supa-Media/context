/**
 * The geometry of `/tex/<handle>`'s remote screen: where the picture of Tex's
 * browser sits on the phone, how pinching moves it, and where a point on the
 * glass lands on the page.
 *
 * Three spaces, kept apart by name:
 *
 *  - **stage**: the phone's view the picture is drawn in, in its own points,
 *    origin at its top left;
 *  - **page**: the browser's viewport in CSS pixels, the space every action
 *    the screenshot Worker takes is in (`frame.width × frame.height`);
 *  - **view**: how the picture is placed on the stage — `zoom` over the
 *    letterboxed fit, and `x`, `y`, the stage point its top left corner is at.
 *
 * Pure, so the mapping can be proved at every zoom, pan and letterbox without
 * a renderer; `TexRemoteStage.tsx` only feeds it touches.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface RemoteView {
  zoom: number;
  x: number;
  y: number;
}

/** No smaller than the whole page on the phone; up to five times that, which reads a 1280px page's small print. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;
/** The most one scroll moves the page; the screenshot Worker refuses more. */
export const MAX_SCROLL = 3_000;
/** How close to the stage's edge the cursor may come before the view follows it, in stage points. */
export const FOLLOW_MARGIN = 32;
/** How much more one axis must move than the other before a scroll keeps to it alone. */
export const RAIL = 3;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const tenth = (value: number) => Math.round(value * 10) / 10;
const sane = (size: Size) => size.width > 0 && size.height > 0 && Number.isFinite(size.width) && Number.isFinite(size.height);

/** The picture at zoom 1: the whole page, as large as the stage allows, centred, letterboxed on the long side. */
export function fitFrame(stage: Size, page: Size): (Point & Size) | null {
  if (!sane(stage) || !sane(page)) return null;
  const ratio = Math.min(stage.width / page.width, stage.height / page.height);
  const width = page.width * ratio;
  const height = page.height * ratio;
  return { x: (stage.width - width) / 2, y: (stage.height - height) / 2, width, height };
}

/** The whole page, centred: where every frame starts and where a reset returns. */
export function restingView(stage: Size, page: Size): RemoteView {
  const fit = fitFrame(stage, page);
  return fit === null ? { zoom: 1, x: 0, y: 0 } : { zoom: 1, x: fit.x, y: fit.y };
}

/**
 * The view held inside its bounds: zoom between the limits, and the picture
 * never dragged off the stage. Along an axis where the zoomed picture is
 * smaller than the stage it is centred, so letterboxing stays even.
 */
export function clampView(view: RemoteView, stage: Size, page: Size): RemoteView {
  const fit = fitFrame(stage, page);
  if (fit === null) return { zoom: 1, x: 0, y: 0 };
  const zoom = clamp(Number.isFinite(view.zoom) ? view.zoom : 1, MIN_ZOOM, MAX_ZOOM);
  const axis = (at: number, shown: number, room: number) => (shown <= room ? (room - shown) / 2 : clamp(at, room - shown, 0));
  return {
    zoom,
    x: axis(view.x, fit.width * zoom, stage.width),
    y: axis(view.y, fit.height * zoom, stage.height),
  };
}

/** Page CSS pixels per stage point at this view. One number: a fit keeps the page's aspect. */
export function pagePerPoint(stage: Size, page: Size, view: RemoteView): number | null {
  const fit = fitFrame(stage, page);
  return fit === null ? null : page.width / (fit.width * view.zoom);
}

/**
 * Where a point on the stage lands on the page, to a tenth of a pixel, or
 * null when it is on the letterbox rather than the picture.
 */
export function stageToPage(point: Point, stage: Size, page: Size, view: RemoteView): Point | null {
  const per = pagePerPoint(stage, page, view);
  if (per === null) return null;
  const x = (point.x - view.x) * per;
  const y = (point.y - view.y) * per;
  if (!(x >= 0 && x <= page.width && y >= 0 && y <= page.height)) return null;
  return { x: tenth(x), y: tenth(y) };
}

/** Where a page point is drawn on the stage: the cursor's position. */
export function pageToStage(point: Point, stage: Size, page: Size, view: RemoteView): Point | null {
  const per = pagePerPoint(stage, page, view);
  if (per === null) return null;
  return { x: view.x + point.x / per, y: view.y + point.y / per };
}

/** The view zoomed to `zoom`, keeping the page point under `anchor` where it is. */
export function zoomAt(view: RemoteView, anchor: Point, zoom: number, stage: Size, page: Size): RemoteView {
  const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const k = next / view.zoom;
  return clampView({ zoom: next, x: anchor.x - (anchor.x - view.x) * k, y: anchor.y - (anchor.y - view.y) * k }, stage, page);
}

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const span = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Two fingers, from where they went down to where they are: the zoom follows
 * the distance between them, and the point under their midpoint follows the
 * midpoint, so a pinch that also drifts pans as it zooms.
 */
export function pinchView(start: RemoteView, from: readonly [Point, Point], to: readonly [Point, Point], stage: Size, page: Size): RemoteView {
  const before = span(from[0], from[1]);
  const after = span(to[0], to[1]);
  const zoom = clamp(before > 0 ? start.zoom * (after / before) : start.zoom, MIN_ZOOM, MAX_ZOOM);
  const was = mid(from[0], from[1]);
  const now = mid(to[0], to[1]);
  const k = zoom / start.zoom;
  return clampView({ zoom, x: now.x - (was.x - start.x) * k, y: now.y - (was.y - start.y) * k }, stage, page);
}

/** The view dragged by a finger's movement on the stage. */
export function panView(view: RemoteView, delta: Point, stage: Size, page: Size): RemoteView {
  return clampView({ zoom: view.zoom, x: view.x + delta.x, y: view.y + delta.y }, stage, page);
}

/**
 * The cursor moved as a trackpad moves it: a finger's movement on the stage,
 * one to one with what the person sees, in page pixels, held on the page.
 */
export function moveCursor(cursor: Point, delta: Point, stage: Size, page: Size, view: RemoteView): Point {
  const per = pagePerPoint(stage, page, view);
  if (per === null) return cursor;
  return { x: tenth(clamp(cursor.x + delta.x * per, 0, page.width)), y: tenth(clamp(cursor.y + delta.y * per, 0, page.height)) };
}

/** The view panned just far enough that the cursor stays on the stage, as a zoomed-in remote desktop follows it. */
export function followCursor(view: RemoteView, cursor: Point, stage: Size, page: Size, margin = FOLLOW_MARGIN): RemoteView {
  const at = pageToStage(cursor, stage, page, view);
  if (at === null) return view;
  const shift = (value: number, room: number) => {
    const edge = Math.min(margin, room / 2);
    if (value < edge) return edge - value;
    if (value > room - edge) return room - edge - value;
    return 0;
  };
  return clampView({ zoom: view.zoom, x: view.x + shift(at.x, stage.width), y: view.y + shift(at.y, stage.height) }, stage, page);
}

/**
 * Two fingers dragged across the stage, as a wheel on the page. Natural
 * scrolling, as on a phone: fingers moving up move the page's content up,
 * which is the page scrolling down. Zero when nothing moved.
 *
 * Railed, as a trackpad is: a swipe that is mostly vertical scrolls only
 * vertically, so the drift every thumb has does not slide the page sideways.
 */
export function scrollFrom(delta: Point, stage: Size, page: Size, view: RemoteView): { dx: number; dy: number } {
  const per = pagePerPoint(stage, page, view);
  if (per === null) return { dx: 0, dy: 0 };
  const rail = (along: number, across: number) => (Math.abs(along) * RAIL < Math.abs(across) ? 0 : along);
  const axis = (value: number) => {
    const moved = Math.round(clamp(-value * per, -MAX_SCROLL, MAX_SCROLL));
    return moved === 0 ? 0 : moved;
  };
  return { dx: axis(rail(delta.x, delta.y)), dy: axis(rail(delta.y, delta.x)) };
}

/** The middle of the page: where the cursor starts. */
export function pageCentre(page: Size): Point {
  return { x: tenth(page.width / 2), y: tenth(page.height / 2) };
}
