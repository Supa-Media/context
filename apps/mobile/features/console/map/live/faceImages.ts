import { defaultFace } from "../../faces/defaultFace";
import { faceFor as storedFace } from "../../faces/faceStore";
import type { FaceFor, Who } from "./engine/draw/primitives";

/**
 * People's faces as canvas images, for the map engine's `faceFor`: the photo
 * or emoji they chose (`faceStore`), else the Supa mark on the ground their
 * handle hashes to (`defaultFace`), the same face `PersonFace` draws.
 *
 * Images load asynchronously; until one has, the engine draws a silhouette,
 * and `onReady` asks for a redraw once it lands. Browser-only (it makes DOM
 * images and canvases), and only ever called from the web wrapper.
 */
export function createFaceImages(onReady: () => void, size = 64): FaceFor & { clear(): void } {
  const cache = new Map<string, HTMLCanvasElement | null>();

  const compose = (key: string, draw: (ctx: CanvasRenderingContext2D) => void) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    draw(ctx);
    cache.set(key, canvas);
    onReady();
  };

  const load = (key: string, src: string, ground: string | null) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () =>
      compose(key, (ctx) => {
        if (ground) {
          ctx.fillStyle = ground;
          ctx.fillRect(0, 0, size, size);
        }
        // Cover the square, like `object-fit: cover`.
        const k = Math.max(size / img.naturalWidth, size / img.naturalHeight);
        const w = img.naturalWidth * k;
        const h = img.naturalHeight * k;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      });
    img.onerror = () => cache.set(key, null);
    img.src = src;
  };

  const fn = ((who: Who) => {
    if (who.kind !== "person") return null;
    const key = who.name;
    if (cache.has(key)) return cache.get(key) ?? null;
    cache.set(key, null);
    const face = storedFace(who.name);
    if (face?.kind === "photo") {
      load(key, face.uri, null);
    } else if (face?.kind === "emoji") {
      compose(key, (ctx) => {
        ctx.font = `${size * 0.62}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(face.emoji, size / 2, size / 2 + size * 0.04);
      });
    } else {
      const fallback = defaultFace(who.name);
      load(key, fallback.logo, fallback.ground);
    }
    return null;
  }) as FaceFor & { clear(): void };
  fn.clear = () => cache.clear();
  return fn;
}
