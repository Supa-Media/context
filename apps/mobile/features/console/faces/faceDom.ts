import { defaultFace } from "./defaultFace";
import { faceFor } from "./faceStore";

/**
 * A person's face as plain DOM, for the editor's comment cards and typing
 * flags: the same photo, emoji or Supa mark `PersonFace` draws.
 *
 * Built with `createElement` and properties only, never markup, for the
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
  if (face?.kind === "emoji") {
    box.textContent = face.emoji;
    box.style.background = "transparent";
    return box;
  }
  const img = document.createElement("img");
  img.alt = "";
  img.style.cssText = "width: 100%; height: 100%; object-fit: cover; display: block;";
  if (face?.kind === "photo") {
    img.src = face.uri;
  } else {
    // The Supa mark on this handle's ground (`defaultFace.ts`).
    const fallback = defaultFace(name);
    img.src = fallback.logo;
    box.style.background = fallback.ground;
  }
  box.appendChild(img);
  return box;
}

const SVG = "http://www.w3.org/2000/svg";

/**
 * An agent's face as plain DOM: the robot the app's `Icon name="robot"` draws
 * (a head, an antenna, two eyes, two ears), in the surrounding text colour.
 * Agents are never drawn with a person's face, their owner's included (Dev2,
 * 2026-09-28): the robot is how you tell at a glance that it is not a person.
 */
export function robotNode(className: string): HTMLElement {
  const box = document.createElement("span");
  box.className = className;
  box.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.style.cssText = "width: 80%; height: 80%; display: block; margin: 10%;";
  const shape = (tag: string, attrs: Record<string, string>) => {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.appendChild(node);
  };
  shape("rect", { x: "4.5", y: "8", width: "15", height: "12", rx: "3.3" });
  shape("line", { x1: "12", y1: "4", x2: "12", y2: "8" });
  shape("circle", { cx: "12", cy: "2.9", r: "1.2", fill: "currentColor", stroke: "none" });
  shape("circle", { cx: "9.2", cy: "13.9", r: "1.6", fill: "currentColor", stroke: "none" });
  shape("circle", { cx: "14.8", cy: "13.9", r: "1.6", fill: "currentColor", stroke: "none" });
  shape("line", { x1: "2.4", y1: "12.3", x2: "2.4", y2: "16" });
  shape("line", { x1: "21.6", y1: "12.3", x2: "21.6", y2: "16" });
  box.appendChild(svg);
  return box;
}
