/**
 * Storing and reading an image: a pasted one, a workspace icon, an attachment.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { WORKSPACE_ICON_EXTENSIONS } from "@context/shared/src/workspaceIcon";
import { IMAGE_PREFIX, legacyStorageKey } from "@context/shared/src/storageLayout.cjs";
import type { FileStore } from "./store";
import { FileOpError, notFound } from "./errors";

/* -------------------------------------------------------------------------- */
/*                          writing something that is not a note              */
/* -------------------------------------------------------------------------- */

/**
 * The most one stored image may be.
 *
 * Deliberately its own number rather than `MAX_NOTE_BYTES`. They are the same
 * today and mean different things: one bounds a document a person typed, the
 * other bounds bytes a machine produced, and tying them together means changing
 * the note limit silently changes what a bucket may be made to hold.
 */
export const MAX_STORED_IMAGE_BYTES = 5_000_000;

/**
 * Where objects that are not notes live: `.images/`, opaque and unlistable.
 *
 * Dot-prefixed, so `isPlumbing` hides it from every listing, every search and
 * Obsidian itself. That opacity is the point of the location — see the comment
 * on `IMAGE_PREFIX` in the gateway, which reads the same store from the other
 * side.
 */
export { IMAGE_PREFIX };

/**
 * The leaf extensions `read_image` will serve back.
 *
 * The gateway's `IMAGE_MIME_TYPES` keys, restated rather than imported for the
 * same reason the character class below is: `apps/mcp` is dependency-free by
 * design, so the two cannot share a module. **`writeImage.test.ts` reads the
 * gateway's source and fails on drift** — and until now that arrangement was
 * claimed here and did not exist, which is why this list is the second half of
 * a rule that had only ever had its first half enforced.
 *
 * SVG is absent, deliberately and on both sides: it is a script container, and
 * a store that accepted one would make the gateway's refusal to serve one moot.
 */
export const STORABLE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "heic",
  "heif",
]);

/**
 * Write bytes into the opaque store.
 *
 * A deliberately different function from `writeFile`, not an option on it, and
 * the differences are all the reasons it exists:
 *
 *  - **No `.md`, no `privacy.md` check, no visibility check.** An image has no
 *    visibility of its own — it borrows the visibility of whatever note
 *    references it, which is what keeps it from drifting out of sync with the
 *    access map. Asking `canSee` about a key under `.images/` would be asking a
 *    question the manifest has no answer to, and inventing one is how the two
 *    start disagreeing.
 *  - **No history.** `.history/` exists so a person can recover a document they
 *    edited. These keys are content-addressed: a different image is a different
 *    key, so there is no previous version of one to keep.
 *  - **No conditional write.** For the same reason. Writing the same key twice
 *    is writing the same bytes twice.
 *
 * What it does enforce is the shape of the key and the type of the object,
 * because this is the one write path that can put a non-note in a customer's
 * bucket. The leaf rule is the gateway's, deliberately: a key this writes and
 * `read_image` cannot name is bytes nobody can ever get back out.
 *
 * **That rule had one of its FOUR gates.** `imageRefFor` refuses an empty
 * value, one over 512 characters, a `\`, or a `..` anywhere in the raw value;
 * then requires the character class below; then a `.` past position 0; then an
 * extension in `IMAGE_MIME_TYPES`. Only the
 * character class was enforced here, so `writeImage` would happily resolve for
 * `abc`, `abc.txt` and `abc.svg` — measured, returning
 * `{ key: ".context/assets/images/abc" }`
 * — every one of which `read_image` refuses forever.
 *
 * (An earlier version of this comment said "two halves" and enumerated three
 * gates as the whole rule. It omitted `..`, and the code omitted it too, so
 * `a..png` and `abc..jpeg` still resolved and still wrote bytes the gateway
 * would never hand back. A comment that enumerates somebody else's rule is a
 * claim about their code, and this one was made by reading three lines of
 * four.)
 * Latent rather than live: this function has no production call site. Which is
 * a fact about today, and the reason to close it now rather than when one
 * appears.
 */
export async function writeImage(
  store: FileStore,
  options: { leaf: string; bytes: Uint8Array; contentType: string },
): Promise<{ key: string; etag: string }> {
  const leaf = options.leaf;
  // The gateway's rule, restated rather than imported: `apps/mcp` is
  // dependency-free by design, so the two cannot share a module. A test reads
  // the gateway's source and fails on drift — the same arrangement
  // `MAX_INLINE_IMAGE_BYTES` already has. (It says so now. When this comment
  // was first written it named a test that did not exist, for either half of
  // the rule below.)
  // `..` first, as the gateway does: it survives the character class, because
  // `.` is inside that class, so nothing below would catch it.
  //
  // The gateway's first line also refuses an empty value, a `\`, and anything
  // over 512 characters. All three are subsumed here — empty and `\` by the
  // character class, 512 by the stricter 200 — which is a claim a fuzz over
  // 18,277 leaves against the gateway's own extracted `imageRefFor` bears out:
  // zero inputs this accepts and the gateway refuses. Said explicitly because
  // the comment above is about enumerating a rule by reading part of it.
  if (
    leaf.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(leaf) ||
    leaf.length > 200
  ) {
    throw new FileOpError("PATH_INVALID", "That is not a valid stored-object name.");
  }
  // The last two gates. `imageRefFor` resolves the mime type from the
  // extension, so a leaf without one, or with one the gateway cannot serve,
  // names an object no tool can ever return.
  //
  // `dot <= 0` is not a subsumed backstop and is pinned by its own case: with
  // it gone, `slice(-1 + 1)` is the whole leaf, so a leaf that IS an extension
  // name — `png`, `jpeg` — passes the set lookup and writes `.images/png`,
  // which `imageRefFor` refuses because it finds no dot at all.
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0 || !STORABLE_IMAGE_EXTENSIONS.has(leaf.slice(dot + 1).toLowerCase())) {
    throw new FileOpError(
      "PATH_INVALID",
      "A stored object must end in an image extension the gateway can serve.",
    );
  }
  if (options.bytes.byteLength === 0) {
    throw new FileOpError("CONTENT_TOO_LARGE", "There is nothing to store.");
  }
  if (options.bytes.byteLength > MAX_STORED_IMAGE_BYTES) {
    throw new FileOpError(
      "CONTENT_TOO_LARGE",
      `A stored image must be at most ${MAX_STORED_IMAGE_BYTES} bytes.`,
    );
  }

  const key = `${IMAGE_PREFIX}${leaf}`;
  // `assertWritableContentType` in the store layer is the authority and will
  // refuse anything outside the allow-list; this is not a second guess at it,
  // only the value being passed through.
  const put = await store.put(key, options.bytes, { contentType: options.contentType });
  if (put === null) {
    // `null` is the conditional-write refusal, and this write is not
    // conditional — so reaching it means the adapter's contract changed under
    // us. `CONFLICT` is the honest code: something else wrote that key.
    throw new FileOpError("CONFLICT", "Your bucket did not accept that write.");
  }
  return { key, etag: put.etag };
}

/**
 * Read bytes back out of the opaque store.
 *
 * The mirror of `writeImage`, and exempt from the same three rules for the same
 * reasons: no `.md`, no manifest, no history. **It applies the identical leaf
 * check**, which is what stops it being a general object reader — the same
 * property `read_image` in the gateway is built around. Without it, a caller
 * naming `../privacy.md` would walk straight out of `.images/` and hand back
 * the access map.
 *
 * Missing is `FILE_NOT_FOUND`, the same code an invisible note gets, so a
 * caller cannot tell "no card yet" from "never existed".
 */
export async function readImage(store: FileStore, leaf: string): Promise<ArrayBuffer> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(leaf) || leaf.length > 200) {
    throw new FileOpError("PATH_INVALID", "That is not a valid stored-object name.");
  }
  const key = `${IMAGE_PREFIX}${leaf}`;
  const legacyKey = legacyStorageKey(key);
  const object = (await store.get(key)) || (legacyKey ? await store.get(legacyKey) : null);
  if (object === null) throw notFound();
  // `arrayBuffer` rather than `text`: a PNG decoded as UTF-8 is mojibake, and
  // the adapters that predate images only guaranteed `text`.
  const reader = object as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof reader.arrayBuffer !== "function") {
    // Every real adapter has it; the narrow `ScaffoldStore` type predates
    // images and only promises `text`. `FILE_NOT_FOUND` rather than a new code:
    // from the caller's side a store that cannot hand back bytes and a card
    // that was never written are the same absence, and both mean "serve the
    // static card".
    throw notFound();
  }
  return await reader.arrayBuffer();
}

/* -------------------------------------------------------------------------- */
/*                      an image somebody pasted into a note                   */
/* -------------------------------------------------------------------------- */

/**
 * The leaf a pasted image is stored under, inside `IMAGE_PREFIX`.
 *
 * **It goes in the opaque store with everything else, and that reverses the
 * first version of this feature**, which put pastes in a visible
 * `attachments/<YYYY>/<MM>/` folder so the embed would resolve in Obsidian. The
 * owner's call, and the reasons are good ones: one image store rather than two,
 * nothing new in the listing, the file tree stays the customer's own folders,
 * and `read_image` already serves this prefix — so an agent can fetch a pasted
 * image, which the visible folder could not offer without widening
 * `imageRefFor`. What it costs is stated rather than hidden: Obsidian skips
 * dot-folders, so the embed draws as a broken link there until this product
 * writes an Obsidian-side resolver or the file is exported.
 *
 * The name is the content hash, which buys the same three things it always did:
 * the same paste in three notes is one object, a retried upload overwrites
 * itself rather than leaving `-1` behind, and a clipboard with no filename needs
 * no invented one. `paste-` in front so a person looking at the store can see
 * where an object came from, and because `writeImage`'s leaf rule wants an
 * alphanumeric first character.
 */
const PASTE_EXTENSIONS = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
]);

export function pasteImageLeaf(options: { hash: string; contentType: string }): string {
  const extension = PASTE_EXTENSIONS.get(options.contentType);
  if (extension === undefined) {
    throw new FileOpError("PATH_INVALID", "That is not an image type this store accepts.");
  }
  const hash = options.hash.toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 16);
  if (hash.length < 8) {
    throw new FileOpError("PATH_INVALID", "A stored image needs a content hash for its name.");
  }
  return `paste-${hash}.${extension}`;
}

/**
 * The leaf a workspace's icon photo is stored under, inside `IMAGE_PREFIX`.
 *
 * The same store as a paste and a different prefix, for the reason `paste-`
 * has one: somebody reading the objects in their own bucket can see where each
 * came from. It is not a namespace and nothing resolves on it — `readImage`
 * takes leaves, not patterns — so the prefix is a label and the content hash is
 * still what names the object.
 *
 * Content-addressed like a paste, and the same three things follow: setting the
 * same photo on two workspaces writes one object, a retried upload overwrites
 * itself, and a picker result with no filename needs no invented one.
 *
 * **The type list is narrower than `PASTE_EXTENSIONS`** and that is the
 * difference worth stating: `WORKSPACE_ICON_EXTENSIONS` drops `gif`, `heic` and
 * `heif`, because an icon has to draw in a browser and two of those do not. It
 * is imported from `@context/shared` rather than restated, because the picker
 * pre-flights the same rule before it uploads and two copies of it would be a
 * picker offering what this refuses; see its own note for why each type is out.
 */
export function workspaceIconLeaf(options: { hash: string; contentType: string }): string {
  const extension = WORKSPACE_ICON_EXTENSIONS.get(options.contentType);
  if (extension === undefined) {
    throw new FileOpError("PATH_INVALID", "That is not an image type an icon can be stored as.");
  }
  const hash = options.hash.toLowerCase().replace(/[^a-f0-9]/g, "").slice(0, 16);
  if (hash.length < 8) {
    throw new FileOpError("PATH_INVALID", "A stored image needs a content hash for its name.");
  }
  return `icon-${hash}.${extension}`;
}
