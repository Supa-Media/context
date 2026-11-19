/**
 * Pictures on the chat page, both ways: the person's own, shrunk on this
 * device before they go, and Tex's or an earlier one's, fetched by id and
 * kept as an object URL until the page is gone.
 *
 * Web only. Shrinking needs a document and a canvas; where there is neither,
 * the caller says so in a sentence rather than sending the original bytes.
 */
import { MAX_PICTURE_BYTES } from "./appChatGateway";

/** The longest side a picture is shrunk to, in pixels. */
export const SHRINK_LONG_SIDE = 1600;

/**
 * Each try is a JPEG at a quality and a fraction of the size already tried.
 * The first is the usual one; the rest only run when a picture is still too big.
 */
const ATTEMPTS: readonly { quality: number; scale: number }[] = [
  { quality: 0.85, scale: 1 },
  { quality: 0.7, scale: 1 },
  { quality: 0.7, scale: 0.75 },
  { quality: 0.7, scale: 0.5 },
];

/** Whether this runtime can shrink a picture before it goes. */
export function canShrinkPictures(): boolean {
  return typeof document !== "undefined" && typeof Image !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}

/** An object URL that shows a blob the page holds, or `null` where there is no way to make one. */
export function previewUrlOf(blob: Blob): string | null {
  if (!canShrinkPictures()) return null;
  return URL.createObjectURL(blob);
}

/** Revoke an object URL the page made. Safe to call on a URL already revoked. */
export function revokeUrl(url: string): void {
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

function loadImage(source: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("picture did not decode"));
    };
    image.src = url;
  });
}

function jpegOf(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality));
}

/**
 * The picture as a JPEG under `MAX_PICTURE_BYTES`, or `null` when it cannot be
 * read, drawn, or made small enough. A PNG or GIF with a transparent ground is
 * drawn on white first, so it does not come out black.
 */
export async function shrinkPicture(source: Blob): Promise<Blob | null> {
  if (!canShrinkPictures()) return null;
  let image: HTMLImageElement;
  try {
    image = await loadImage(source);
  } catch {
    return null;
  }
  const longSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (longSide === 0) return null;
  const base = Math.min(1, SHRINK_LONG_SIDE / longSide);
  for (const attempt of ATTEMPTS) {
    const width = Math.max(1, Math.round(image.naturalWidth * base * attempt.scale));
    const height = Math.max(1, Math.round(image.naturalHeight * base * attempt.scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await jpegOf(canvas, attempt.quality);
    if (blob !== null && blob.size <= MAX_PICTURE_BYTES) return blob;
  }
  return null;
}

/** The bytes as base64, with no `data:` prefix. */
export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Every picture shrunk and encoded, in order; `null` when any one cannot be sent. */
export async function encodePictures(blobs: readonly Blob[]): Promise<string[] | null> {
  const out: string[] = [];
  for (const blob of blobs) {
    const shrunk = await shrinkPicture(blob);
    if (shrunk === null) return null;
    out.push(await base64Of(shrunk));
  }
  return out;
}

type Slot = { state: "loading" } | { state: "ready"; url: string } | { state: "failed" };

/**
 * Picture id to object URL. A id is asked for once: the first ask starts the
 * load, a failed load stays failed (no loop of refetches), and `clear` revokes
 * every URL and drops any load still in flight, so a late answer for an earlier
 * chat never lands in this one.
 */
export class PictureCache {
  private readonly slots = new Map<string, Slot>();
  private generation = 0;

  /** The object URL once loaded; `null` while loading or after a failure. */
  lookup(id: string): string | null {
    const slot = this.slots.get(id);
    return slot?.state === "ready" ? slot.url : null;
  }

  /** Start loading an id not asked for before. `load` gives the blob, or `null` for a failure. */
  request(id: string, load: () => Promise<Blob | null>, onSettled: () => void): void {
    if (this.slots.has(id)) return;
    this.slots.set(id, { state: "loading" });
    const mark = this.generation;
    const settle = (slot: Slot) => {
      if (mark !== this.generation) return;
      this.slots.set(id, slot);
      onSettled();
    };
    load().then(
      (blob) => {
        // A load that lands after `clear` is dropped before it makes a URL, so nothing leaks.
        if (mark !== this.generation) return;
        if (blob === null || !canShrinkPictures()) return settle({ state: "failed" });
        settle({ state: "ready", url: URL.createObjectURL(blob) });
      },
      () => settle({ state: "failed" }),
    );
  }

  /** Revoke every URL and forget every id. Loads still in flight are discarded when they land. */
  clear(): void {
    for (const slot of this.slots.values()) {
      if (slot.state === "ready") revokeUrl(slot.url);
    }
    this.slots.clear();
    this.generation += 1;
  }
}
