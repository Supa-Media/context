/**
 * A group photo (`group/photo`, running the group): the picture is an attachment already on the line, read whole
 * from the SDK's download stream before `groups.setIcon`, which takes the bytes.
 */
import { RequestError } from "./errors.mjs";

/** Bigger than any picture Messages sends. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** The stream's primary bytes as one array; refused past `max`, or when there are none. The stream is always closed. */
export async function readWhole(stream, max) {
  const chunks = [];
  let size = 0;
  try {
    for await (const part of stream) {
      if (part?.type !== "primaryChunk") continue;
      size += part.data.byteLength;
      if (size > max) throw new RequestError(413, "photo_too_large");
      chunks.push(part.data);
    }
  } finally {
    await stream.close();
  }
  if (size === 0) throw new RequestError(502, "photo_empty");
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
