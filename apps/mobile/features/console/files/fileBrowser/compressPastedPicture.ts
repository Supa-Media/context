/**
 * A pasted picture, compressed on the device before it is uploaded.
 *
 * Pictures are kept compressed (decided by the owner, 2026-11-01). The gateway
 * does this for agent uploads, but a paste goes straight from the app to a
 * Convex action, and Convex cannot re-encode an image. So the browser does it
 * here, with the same policy the gateway uses: a lossy WebP no wider or taller
 * than `PICTURE_MAX_EDGE`, and no lossless copy kept. The policy constants come
 * from `packages/shared`, so the two cannot drift apart.
 *
 * Only the browser can do this. Native has no canvas, so there the picture is
 * returned as it came, and so is anything that is not a PNG, JPEG or WebP.
 */

import { PICTURE_MAX_EDGE, PICTURE_QUALITY } from "@context/shared/src/pictureCompression.cjs";

/** The bytes of a picture and the type they declare. */
export type PictureForEncoding = { bytes: ArrayBuffer; contentType: string };

/** What an encoder is asked for: the format to encode, and the policy it must meet. */
export type PictureEncodeOptions = {
  format: "image/webp" | "image/jpeg";
  maxEdge: number;
  quality: number;
};

/**
 * Re-encodes a picture. The default draws it on a canvas; a test passes its
 * own. The type it answers with is what the browser actually produced, which
 * is not always what was asked for (Safari cannot encode WebP).
 */
export type PictureEncoder = (
  picture: PictureForEncoding,
  options: PictureEncodeOptions,
) => Promise<PictureForEncoding>;

/** The types that are re-encoded. A GIF may move, and anything else is not a picture to this path. */
const COMPRESSIBLE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

/** The canvas API takes quality on a 0-1 scale; the gateway's policy is 1-100. */
const CANVAS_QUALITY = PICTURE_QUALITY / 100;

/**
 * Compress a pasted picture, or return it unchanged.
 *
 * The input comes back as the same object whenever anything is off: the type is
 * not compressible, there is no canvas, the encoder fails, or the result is not
 * strictly smaller. An upload is never refused because compression went wrong.
 * An encoder passed in is the environment, so the canvas check is skipped for it.
 */
export async function compressPastedPicture(
  picture: PictureForEncoding,
  encoder?: PictureEncoder,
): Promise<PictureForEncoding> {
  if (!COMPRESSIBLE_TYPES.has(picture.contentType)) return picture;
  const encode = encoder ?? canvasEncoderIfAvailable();
  if (encode === null) return picture;
  try {
    const webp = await encode(picture, { format: "image/webp", maxEdge: PICTURE_MAX_EDGE, quality: CANVAS_QUALITY });
    /*
      Safari cannot encode WebP, and a canvas asked for one hands back a PNG
      without complaint. The check is on the type the browser answered with,
      so the fallback is taken exactly when it is needed.
    */
    const encoded = webp.contentType === "image/webp"
      ? webp
      : await encode(picture, { format: "image/jpeg", maxEdge: PICTURE_MAX_EDGE, quality: CANVAS_QUALITY });
    if (encoded.contentType !== "image/webp" && encoded.contentType !== "image/jpeg") return picture;
    if (encoded.bytes.byteLength === 0) return picture;
    if (encoded.bytes.byteLength >= picture.bytes.byteLength) return picture;
    return encoded;
  } catch {
    return picture;
  }
}

/**
 * The longest side is brought down to `maxEdge`, keeping the aspect ratio, and
 * a picture already within it is left at its size. Never scales up.
 */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The default encoder, or null where the browser cannot draw.
 *
 * Both checks are needed: `createImageBitmap` decodes the picture and the canvas
 * encodes it, and a browser or a React Native runtime may have one without the
 * other. Native has neither, so it gets null and keeps every picture as it came.
 */
function canvasEncoderIfAvailable(): PictureEncoder | null {
  if (typeof createImageBitmap !== "function") return null;
  const hasOffscreen = typeof OffscreenCanvas === "function";
  const hasDocument = typeof document !== "undefined" && typeof document.createElement === "function";
  if (!hasOffscreen && !hasDocument) return null;
  return encodeWithCanvas;
}

/** Decode, scale and encode with a canvas. Throws on anything the browser refuses. */
async function encodeWithCanvas(picture: PictureForEncoding, options: PictureEncodeOptions): Promise<PictureForEncoding> {
  const source = await createImageBitmap(new Blob([picture.bytes], { type: picture.contentType }));
  try {
    const { width, height } = fitWithin(source.width, source.height, options.maxEdge);
    const canvas = typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(width, height)
      : document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (context === null) throw new Error("No 2D canvas context.");
    /*
      JPEG has no transparency, so a transparent PNG would come out black
      wherever it was clear. Painting white underneath keeps it looking as it
      did on the page.
    */
    if (options.format === "image/jpeg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(source, 0, 0, width, height);
    const blob = await canvasToBlob(canvas, options);
    return { bytes: await blob.arrayBuffer(), contentType: blob.type };
  } finally {
    source.close();
  }
}

function canvasToBlob(canvas: OffscreenCanvas | HTMLCanvasElement, options: PictureEncodeOptions): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: options.format, quality: options.quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("The canvas could not be encoded.")) : resolve(blob)),
      options.format,
      options.quality,
    );
  });
}
