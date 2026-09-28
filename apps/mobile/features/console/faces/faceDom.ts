import { defaultFace, FACE_SHAPES } from "./defaultFace";
import { faceFor } from "./faceStore";

/**
 * A person's face as plain DOM, for the editor's comment cards and typing
 * flags: the same photo, emoji or drawn figure `PersonFace` draws.
 *
 * Built with `createElement(NS)` and properties only, never markup, for the
 * reason `comments/dom.ts` gives: the name came out of a note anybody could
 * have written. The name is only ever a lookup key and a hash input here; it
 * is not drawn.
 */
export function faceNode(name: string | null | undefined, className: string): HTMLElement {
  const box = document.createElement("span");
  box.className = className;
  box.setAttribute("aria-hidden", "true");
  box.style.overflow = "hidden";
  const face = faceFor(name);
  if (face?.kind === "photo") {
    const img = document.createElement("img");
    img.src = face.uri;
    img.alt = "";
    img.style.cssText = "width: 100%; height: 100%; object-fit: cover; display: block;";
    box.appendChild(img);
    return box;
  }
  if (face?.kind === "emoji") {
    box.textContent = face.emoji;
    box.style.background = "transparent";
    return box;
  }
  box.style.background = "transparent";
  box.appendChild(drawnFace(name));
  return box;
}

const SVG = "http://www.w3.org/2000/svg";

function shape(tag: string, attributes: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

/** The drawn head and shoulders in this name's colours. */
export function drawnFace(name: string | null | undefined): SVGElement {
  const face = defaultFace(name);
  const id = `cx-face-${face.index}`;
  const svg = shape("svg", { viewBox: "0 0 100 100", width: "100%", height: "100%" });
  const defs = shape("defs", {});
  const gradient = shape("linearGradient", { id, x1: 0, y1: 0, x2: 1, y2: 1 });
  gradient.append(
    shape("stop", { offset: 0, "stop-color": face.groundTop }),
    shape("stop", { offset: 1, "stop-color": face.groundBottom }),
  );
  defs.appendChild(gradient);
  const { shirt, skin, hair } = FACE_SHAPES;
  svg.append(
    defs,
    shape("rect", { width: 100, height: 100, fill: `url(#${id})` }),
    shape("ellipse", { cx: shirt.cx, cy: shirt.cy, rx: shirt.rx, ry: shirt.ry, fill: face.shirt }),
    shape("circle", { cx: skin.cx, cy: skin.cy, r: skin.r, fill: face.skin }),
    shape("circle", { cx: hair.cx, cy: hair.cy, r: hair.r, fill: face.hair }),
  );
  return svg;
}
