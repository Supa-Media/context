/**
 * `read_image`: the image types the gateway serves back, the inline size
 * ceiling, and the tool itself. IMAGE_MIME_TYPES and MAX_INLINE_IMAGE_BYTES
 * are scraped from THIS FILE's text by the email worker's and control plane's
 * tests, which keep their own copies in step — keep the declarations literal.
 */

import { base64FromBytes, noteReferencesImage } from "../notes/embeds.js";
import { canSee } from "../privacy/engine.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { IMAGE_PREFIX, legacyStorageKey } from "../../../../packages/shared/src/storageLayout.cjs";
import { normalizePath } from "../notes/paths.js";
import { probeWithLegacyFallback } from "../notes/storage.js";
import { toolError } from "./results.js";

/**
 * The opaque image store.
 *
 * `.context/assets/images/` is dot-prefixed, so `isPlumbing` already hides it from every
 * listing, every search and every note tool, at every scope. That is the whole
 * point of the location and it must not be relaxed: making `.context/assets/images/`
 * non-plumbing would put every stored image into listings and defeat the
 * design. `read_image` is the one deliberate way back in, and it is narrow by
 * construction — see `toolReadImage`.
 */

/**
 * The types an image may be returned as, and the only extensions `read_image`
 * will resolve at all.
 *
 * SVG is absent on purpose. An SVG is a script container, and what this tool
 * returns is rendered by whatever client asked for it; a stored `.svg` is
 * unreachable rather than special-cased, which is the safe direction. The
 * customer's own bucket may still hold one — we simply will not hand it out.
 */
const IMAGE_MIME_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
]);

/**
 * A ceiling on what one call will inline. Base64 inflates by 4/3 and a Worker
 * response is not unbounded, so this is a real limit rather than a policy one.
 * Reaching it requires already having proved visibility, so unlike every other
 * refusal in `toolReadImage` it may say what happened.
 */
const MAX_INLINE_IMAGE_BYTES = 5_000_000;

/**
 * Turn whatever the caller passed as `image` into the one key it may mean.
 *
 * Accepts `.context/assets/images/<leaf>` or the bare `<leaf>`, and nothing else. This is the
 * function that stops `read_image` from being a general object reader: this one
 * reads raw bytes by key, so if `image` could name an arbitrary object then a
 * note reading "privacy.md" would exfiltrate the manifest and "../" would walk
 * out of the store. (An earlier version of this sentence said "every other read
 * path in this gateway is gated on `.md` plus `canSee`". `toolReadNote` is not:
 * it is `normalizePath` + `canSee`, with no `.md` gate. The listing, search and
 * `fetch` paths do gate on both.) The leaf is a single path segment with an image extension —
 * no slashes, no dots leading anywhere, nothing outside `.context/assets/images/`.
 *
 * Returns null for anything else; the caller turns null into the same "not
 * found" as every other failure.
 */
export function imageRefFor(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  // A backstop, and honestly labelled as one: with the character class below in
  // place this line can never be the thing that refuses anything, because "/"
  // and "\\" are already outside it and a leading "." already fails it. It
  // earns its keep only if that class is ever loosened — and loosening it is
  // itself caught, by the nested-key check in the suite. Sabotaging this line
  // alone turns nothing red; that is the expected result, not a missing test.
  if (!raw || raw.length > 512 || raw.includes("..") || raw.includes("\\")) return null;
  const legacyImagePrefix = legacyStorageKey(IMAGE_PREFIX);
  const leaf = raw.startsWith(IMAGE_PREFIX)
    ? raw.slice(IMAGE_PREFIX.length)
    : legacyImagePrefix && raw.startsWith(legacyImagePrefix)
      ? raw.slice(legacyImagePrefix.length)
      : raw;
  // One segment, and the load-bearing line here. The character class excludes
  // "/" so nothing nested and nothing outside `.context/assets/images/` can be named, and it
  // requires an alphanumeric first character so the leaf cannot itself be
  // plumbing. This is what stops `read_image` being a general object reader.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(leaf)) return null;
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0) return null;
  const mimeType = IMAGE_MIME_TYPES.get(leaf.slice(dot + 1).toLowerCase());
  if (!mimeType) return null;
  return { key: IMAGE_PREFIX + leaf, leaf, mimeType };
}

/**
 * Resolve one image, and only through a note that reaches it.
 *
 * An image has no visibility of its own. It borrows the visibility of whatever
 * note names it, which is the property that makes the image store safe to have
 * at all: there is nothing here that can drift out of sync with `privacy.md`,
 * because there is nothing here that `privacy.md` does not already decide.
 *
 * The caller must therefore name a note, that note must be one they can already
 * see, and it must reference the image. A bare hash resolves nothing — accepting
 * one would turn this into an enumeration oracle over a store whose entire
 * design is that it cannot be enumerated, which is the same class of bug closed
 * for `move_folder` in #33.
 *
 * One consequence, stated here so it is a decision rather than a discovery: an
 * image referenced by both a private note and a team note is reachable by a team
 * connection *through the team note*. That is correct — the team note has to
 * display it — and it is asserted out loud in the suite.
 *
 * Every refusal below is the same three bytes. "no such image", "no such note",
 * "you cannot see that note" and "that note does not reference this image" are
 * indistinguishable, for the reason every other refusal in this gateway is.
 */
export async function toolReadImage(store, scope, rules, overrides, args) {
  const notFound = toolError("not found");
  const notePath = normalizePath(args.note);
  const image = imageRefFor(args.image);
  if (!notePath || !notePath.endsWith(".md") || !image) return notFound;
  /*
    **THE SECOND DOOR TO THE SAME FACT, AND IT COSTS WHAT THE FIRST DOES.**

    This tool takes a NOTE path and asks `canSee` about it, so it answers the
    question `read_note` answers and its refusal is the same three bytes.
    Refusing on visibility before touching the bucket, while a path the caller
    could have seen went to storage and missed first, made the two refusals 2
    storage round trips against 3 — identical to read, a trip apart to measure,
    and the bit on offer was exactly `canSee(notePath)`.

    So the lookup runs the same way for everybody and the decision is taken
    once both answers are in. It is a metadata probe rather than a `get` for
    the reason spelled out in `toolReadNote`: `S3Store.get` and
    `DropboxStore.get` both buffer the whole object before any caller asks for
    its text, so resolving an invisible path with a real `get` would pull a
    private note's plaintext into the worker on behalf of somebody who may not
    read it. The body below is fetched only after both questions have passed.
  */
  const seen = canSee(notePath, scope, rules, overrides);
  const present = await probeWithLegacyFallback(store, notePath);
  if (!seen || !present) return notFound;
  const note = await getWithLegacyFallback(store, notePath);
  if (!note) return notFound;
  if (!noteReferencesImage(await note.text(), image)) return notFound;
  const object = await getWithLegacyFallback(store, image.key);
  if (!object) return notFound;
  const bytes = new Uint8Array(await object.arrayBuffer());
  // Past this point the caller has already proved they can see a note that
  // references this image, so there is nothing left to conceal and a size
  // refusal can say what it is.
  if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
    return toolError(
      `image too large to return inline: ${bytes.byteLength} bytes, limit ${MAX_INLINE_IMAGE_BYTES}`
    );
  }
  return {
    content: [
      {
        type: "text",
        text: `image: ${image.key}\nreferenced by: ${notePath}\nbytes: ${bytes.byteLength}`,
      },
      { type: "image", data: base64FromBytes(bytes), mimeType: image.mimeType },
    ],
  };
}
