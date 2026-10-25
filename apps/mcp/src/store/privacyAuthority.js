/**
 * The access rules, as the store serves them: the control plane's rows, rendered for the reader.
 *
 * Every privacy decision in the gateway and the console reads its rules through a store (`loadPrivacyState`).
 * The rules are the tree's access rows (`docs/decisions/storage-and-credentials/notes-by-id.md`), so the store
 * answers `privacy.md` with the managed rules block rendered from them, and carries the rules already parsed
 * (`PRE_PARSED_RULES`). Nothing is read from the bucket's file, and nothing is written to it: a write of
 * `privacy.md` is refused, and a row's tier goes through the control plane's `setAccess`.
 *
 * Only `privacy.md` itself is touched here. Every other key, and every listing, is the bucket's own.
 */
import {
  PRE_PARSED_RULES,
  PRIVACY_KEY,
  PRIVACY_RULES_BEGIN,
  PRIVACY_RULES_END,
  PrivacyOverrides,
  spliceRulesBlock,
  visibilityOf,
} from "../privacy/engine.js";
import { ROW_TOKEN_PATTERN } from "../privacy/rowAccess.js";
import { readOnlyAt, readOnlyRow } from "./readOnlyRows.js";

/**
 * @typedef {{prefix: string, visibility: string}} FolderRule
 * @typedef {{path: string, visibility: string}} NoteRule
 * @typedef {{etag: string, folders: FolderRule[], notes: NoteRule[], accessVersion: number, readOnly?: {folders: string[], notes: string[]}}} HeldRules
 * @typedef {Object} PrivacyAuthority
 * @property {HeldRules} rules the rules the control plane renders for this reader
 * @property {(change: {path: string, base: string, expectedVersion?: number, kind?: string, grantees?: unknown}) => Promise<{ok: true, version: number}|{ok: false, code?: string}>} [setAccess]
 *   one row's base, from the access version held
 * @property {(change: {path: string, entries: Array<{handle?: string, email?: string, role: string}>}) => Promise<{ok: true, version: number}|{ok: false, code?: string}>} [addGrantees]
 *   people added to one row's list, owner only
 */

/** What a workspace's `privacy.md` says when there is no rules block to splice into: the block, empty. */
const SKELETON = `# Privacy\n\n${PRIVACY_RULES_BEGIN}\n${PRIVACY_RULES_END}\n`;

/**
 * The base a row's tier write sends, and what the row's grant list is after it, in the rows the gateway holds.
 * A list (a row token) survives a tier change: a team row is open whatever its list, and a private one answers to it.
 */
function visibilityAfter(base, existing) {
  if (base === "team") return "team";
  if (existing !== undefined && ROW_TOKEN_PATTERN.test(existing)) return existing;
  if (base === "private") return "private";
  return null;
}

/** The held rules in the shape `loadPrivacyState` takes from `PRE_PARSED_RULES`. */
function parsedRules(rules) {
  const overrides = new PrivacyOverrides();
  for (const note of rules.notes) overrides.set(note.path, note.visibility);
  return { rules: rules.folders.map((folder) => ({ prefix: folder.prefix, vis: folder.visibility })), overrides };
}

/**
 * The rules' etag after a row change. The control plane's is `<mirror>.<accessVersion>`, so the new one is the same
 * mirror at the answer's version; an answer that names its etag is taken as given, and any other shape is made new.
 */
function etagAfter(etag, answer) {
  if (typeof answer.etag === "string") return answer.etag;
  const at = etag.lastIndexOf(".");
  return `${at === -1 ? etag : etag.slice(0, at)}.${answer.version}`;
}

function objectFor(text, etag, preParsed) {
  const bytes = new TextEncoder().encode(text);
  return {
    etag,
    [PRE_PARSED_RULES]: preParsed,
    size: bytes.byteLength,
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/**
 * A write of `privacy.md`: refused with the code the file-era refusal carried (`PRIVACY_MANIFEST_READ_ONLY`), since
 * access is kept on the tree's rows and nothing writes the file.
 */
export function readOnlyManifest() {
  return Object.assign(new Error("privacy.md is not written: access is kept on the tree's rows"), {
    code: "PRIVACY_MANIFEST_READ_ONLY",
  });
}

/**
 * The store with the access rules served from `authority`.
 *
 * @param {import("./index.js").ContextStore} store
 * @param {PrivacyAuthority|null|undefined} authority
 */
export function withPrivacyAuthority(store, authority) {
  if (!authority) return store;
  /** @type {HeldRules} */
  let held = authority.rules;
  const wrapped = Object.create(store);

  /**
   * One row's tier through the control plane's `setAccess` from the version held. The held rules are then brought
   * up to date, so a later check in this request sees the write. `base` is `inherit` when a note's tier is what it
   * would inherit anyway, and `tier` otherwise.
   */
  const setRowTier = async (path, tier, { folder = false } = {}) => {
    const inherited = visibilityOf(
      path,
      held.folders.map((rule) => ({ prefix: rule.prefix, vis: rule.visibility })),
    );
    const base = !folder && tier !== "inherit" && tier === inherited ? "inherit" : tier;
    const change = { path, base, ...(folder ? { kind: "folder" } : {}) };
    let answer = await authority.setAccess({ ...change, expectedVersion: held.accessVersion });
    // The version is the whole workspace's, so another row's change since this request began moves it. One row's
    // base is the same write whatever else changed, so it is sent once more without the version rather than failing.
    if (answer?.ok !== true && answer?.code === "CONFLICT") answer = await authority.setAccess(change);
    if (answer?.ok !== true) return answer ?? { ok: false };
    const listKey = folder ? "folders" : "notes";
    const field = folder ? "prefix" : "path";
    const existing = held[listKey].find((rule) => rule[field] === path)?.visibility;
    const after = visibilityAfter(base, existing);
    const others = held[listKey].filter((rule) => rule[field] !== path);
    const entries = after === null ? others : [...others, folder ? { prefix: path, visibility: after } : { path, visibility: after }];
    held = { ...held, [listKey]: entries, accessVersion: answer.version, etag: etagAfter(held.etag, answer) };
    return answer;
  };

  /** People added to one row's list through the control plane. The held rules move to its version. */
  const addRowPeople = async (path, entries) => {
    if (typeof authority.addGrantees !== "function") return { ok: false, code: "FORBIDDEN" };
    const answer = await authority.addGrantees({ path, entries });
    if (answer?.ok !== true) return answer ?? { ok: false };
    held = { ...held, accessVersion: answer.version };
    return answer;
  };

  const preParsed = () => parsedRules(held);
  const text = () => {
    const overrides = preParsed().overrides;
    return spliceRulesBlock(SKELETON, held.folders.map((folder) => ({ prefix: folder.prefix, vis: folder.visibility })), overrides);
  };

  wrapped.get = async (key, ...rest) => {
    if (key !== PRIVACY_KEY) return await store.get(key, ...rest);
    return objectFor(text(), held.etag, preParsed());
  };
  if (typeof store.head === "function") {
    wrapped.head = async (key, ...rest) => {
      if (key !== PRIVACY_KEY) return await store.head(key, ...rest);
      return { etag: held.etag };
    };
  }
  // Rows mode only: a row's tier goes through `setAccess`.
  Object.defineProperty(wrapped, "rowAccess", {
    enumerable: false,
    value: { setTier: setRowTier, addPeople: addRowPeople },
  });
  // A row held only to view (a guest chat's, `readOnlyRows.js`) is read and never changed, whichever tool asks.
  Object.defineProperty(wrapped, "readOnlyAt", { enumerable: false, value: (path) => readOnlyAt(held, path) });
  // The file is not written: its rules are the rows, and a write of it is refused rather than dropped.
  wrapped.put = async (key, value, options) => {
    if (key === PRIVACY_KEY) throw readOnlyManifest();
    if (readOnlyAt(held, key)) throw readOnlyRow(key);
    return await store.put(key, value, options);
  };
  wrapped.delete = async (key, options) => {
    if (key === PRIVACY_KEY) throw readOnlyManifest();
    if (readOnlyAt(held, key)) throw readOnlyRow(key);
    return await store.delete(key, options);
  };
  if (typeof store.copy === "function") {
    wrapped.copy = async (source, destination, options) => {
      if (destination === PRIVACY_KEY) throw readOnlyManifest();
      if (readOnlyAt(held, destination)) throw readOnlyRow(destination);
      return await store.copy(source, destination, options);
    };
  }
  return wrapped;
}
