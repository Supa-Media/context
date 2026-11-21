import { figureParts, SMALL_FIGURE, SMALL_VIEW_BOX, VIEW_BOX } from "./figureGeometry";
import { texColors } from "../design/tokens/landingColors";

const SVG = "http://www.w3.org/2000/svg";
/** `Tex.tsx`'s thinnest line on screen, so the DOM mark and the React one draw the same strokes. */
const SMALL_LINE_PX = 1.4;

/**
 * Tex's one mark, the blue googly-eyed # (`Tex.tsx` at chaos 0), as a DOM node for surfaces that are not React: the
 * editor's comment threads and selection toolbar (Dev2, 2026-11-21: "There's literally only one logo ... It should be
 * blue"). The same geometry (`figureParts`) and colours (`texColors`) as the component, without its rough-ink filter.
 */
export function texMarkNode(className: string, size: number, scheme: "light" | "dark" = "light"): HTMLElement {
  const { ink, eye } = texColors[scheme];
  const small = size <= SMALL_FIGURE;
  const box = small ? SMALL_VIEW_BOX : VIEW_BOX;
  const minStroke = small ? Math.round((SMALL_LINE_PX * box.size) / size) : 0;
  const parts = figureParts(0, { small, minStroke });

  const holder = document.createElement("span");
  holder.className = className;
  holder.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", parts.viewBox);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.style.display = "block";
  const add = (parent: Element, tag: string, attrs: Record<string, string | number>) => {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    parent.appendChild(node);
    return node;
  };
  for (const s of parts.speckles) add(svg, "circle", { cx: s.cx, cy: s.cy, r: s.r, fill: ink, opacity: s.opacity });
  for (const strand of parts.strands) {
    const line = { stroke: ink, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
    add(svg, "path", { d: strand.d, "stroke-width": strand.width, ...line });
    add(svg, "path", { d: strand.dry, "stroke-width": strand.width * 0.45, opacity: 0.7, ...line });
  }
  const g = parts.googly;
  const eyes = add(svg, "g", { transform: `translate(${g.x} ${g.y}) scale(${g.scale})` });
  for (const w of g.whites) add(eyes, "ellipse", { cx: w.cx, cy: w.cy, rx: w.rx, ry: w.ry, fill: eye, stroke: ink, "stroke-width": g.outline });
  for (const p of g.pupils) add(eyes, "circle", { cx: p.cx, cy: p.cy, r: p.r, fill: ink });
  holder.appendChild(svg);
  return holder;
}
