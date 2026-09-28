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
