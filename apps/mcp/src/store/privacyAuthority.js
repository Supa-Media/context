/**
 * `privacy.md` as the export of rules the control plane holds (phase 3 of
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * Every privacy decision in the gateway and the console reads `privacy.md`
 * through a store (`loadPrivacyState`), and every change writes it back
 * through one. So the authority moves at this one seam, and none of the
 * hundred-odd readers changes:
 *
 *  - **Reading `privacy.md`** answers the bucket file's own prose with its
 *    managed block rendered from the control plane's rules, under the control
 *    plane's version. A rule edited into the file past us is not read: the
 *    block it is in is replaced.
 *  - **Writing `privacy.md`** is a compare-and-swap on the control plane's
 *    version first. Only once that has succeeded is the file written to the
 *    bucket, as the export. An export that fails is owed, and written again
 *    later; the rules have changed either way.
 *
 * Before a workspace's rules are the authority (`authority.rules === null`)
 * the store is the bucket's, and a write of `privacy.md` that succeeds also
 * tells the control plane what it now says, from the version it replaced. So
 * when staff turn the authority on, no change made just before is lost: the
 * control plane already holds it.
 *
 * Only `privacy.md` itself is touched. Every other key, and every listing,
 * is the bucket's own, so a listing's version for `privacy.md` is the
 * bucket's: that is how a file edited past us is noticed.
 */

import {
  PRE_PARSED_RULES,
  PRIVACY_KEY,
  PRIVACY_RULES_BEGIN,
  PRIVACY_RULES_END,
  PrivacyOverrides,
  parsePrivacyManifest,
  replacePrivacyRulesBlock,
  spliceRulesBlock,
  visibilityOf,
} from "../privacy/engine.js";
import { hasRowToken, ROW_TOKEN_PATTERN } from "../privacy/rowAccess.js";

/** What a workspace's `privacy.md` says when the bucket holds none, or one that will not parse. */
const SKELETON = `# Privacy\n\n${PRIVACY_RULES_BEGIN}\n${PRIVACY_RULES_END}\n`;

/**
 * @typedef {{prefix: string, visibility: string}} FolderRule
 * @typedef {{path: string, visibility: string}} NoteRule
 * @typedef {{etag: string, folders: FolderRule[], notes: NoteRule[]}} HeldRules
 * @typedef {{folders: FolderRule[], notes: NoteRule[]}} Rules
 * @typedef {Object} PrivacyAuthority
 * @property {HeldRules|null} rules the rules, while they are the authority; `null` while the file is
 * @property {(change: Rules & {expected: string|null}) => Promise<{etag: string}|{current: HeldRules}|null>} write
 *   compare-and-swap on the held version; the rules that are held when
 *   `expected` is not their version, `null` when the file is the authority again
 * @property {(change: Rules & {previous: string|null, etag: string}) => Promise<void>} written
 *   the file was written, from `previous` to `etag`, while it is the authority
 * @property {(export_: {rendered: string, etag: string|null}) => Promise<void>} exported
 *   the file was written from the rules at version `rendered`
 * @property {() => Promise<void>} owed the export did not happen; write it again later
 * @property {(change: {path: string, base: string, expectedVersion?: number}) => Promise<{ok: true, version: number}|{ok: false, code?: string}>} [setAccess]
 *   rows mode only: one row's base, from the access version held. Present when the rows are the truth.
 * @property {(change: {path: string, entries: Array<{handle?: string, email?: string, role: string}>}) => Promise<{ok: true, version: number}|{ok: false, code?: string}>} [addGrantees]
 *   rows mode only: people added to one row's list, owner only.
 */

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

/** The rules a manifest's text holds, or `null` when it does not parse. */
export function rulesOfText(text) {
  try {
    const parsed = parsePrivacyManifest(text);
    return {
      folders: parsed.rules.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })),
      notes: [...parsed.overrides.entries()].map(([path, visibility]) => ({ path, visibility })),
    };
  } catch {
    return null;
  }
}

/** Whether a text has the managed block's two markers, in order: what `replacePrivacyRulesBlock` needs. */
function hasBlock(text) {
  if (typeof text !== "string") return false;
  const begin = text.indexOf(PRIVACY_RULES_BEGIN);
  return begin >= 0 && text.indexOf(PRIVACY_RULES_END) > begin;
}

/**
 * The bucket file's prose, with its managed block rendered from `rules`. A
 * block someone broke by hand is replaced like any other; a file with no
 * block at all (or none) becomes the skeleton.
 */
export function renderWithRules(fileText, rules) {
  const { base, folders, overrides } = baseAndBlock(fileText, rules);
  return replacePrivacyRulesBlock(base, folders, overrides);
}

function baseAndBlock(fileText, rules) {
  const base = hasBlock(fileText) ? fileText : SKELETON;
  const overrides = new PrivacyOverrides();
  for (const note of rules.notes) overrides.set(note.path, note.visibility);
  const folders = rules.folders.map((folder) => ({ prefix: folder.prefix, vis: folder.visibility }));
  return { base, folders, overrides };
}

/**
 * `renderWithRules` for rules that hold a row token, which the parser refuses: the text is for reading only,
 * and `exportNow` never writes it.
 */
function renderForReading(fileText, rules) {
  const { base, folders, overrides } = baseAndBlock(fileText, rules);
  return spliceRulesBlock(base, folders, overrides);
}

/** The rules already parsed, when they hold a row token; `undefined` otherwise, and the text is parsed as always. */
function preParsedOf(rules) {
  if (!hasRowToken(rules)) return undefined;
  const overrides = new PrivacyOverrides();
  for (const note of rules.notes) overrides.set(note.path, note.visibility);
  return { rules: rules.folders.map((folder) => ({ prefix: folder.prefix, vis: folder.visibility })), overrides };
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  return null;
}

function objectFor(text, etag, file, preParsed) {
  const bytes = new TextEncoder().encode(text);
  return {
    etag,
    ...(preParsed !== undefined ? { [PRE_PARSED_RULES]: preParsed } : {}),
    size: bytes.byteLength,
    ...(file?.uploaded !== undefined ? { uploaded: file.uploaded } : {}),
    ...(file?.contentType !== undefined ? { contentType: file.contentType } : {}),
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/**
 * The store with `privacy.md` decided by `authority`, or `store` itself where
 * there is none (a store built for a probe, a hand-off copy, a scaffold).
 *
 * @param {import("./index.js").ContextStore} store
 * @param {PrivacyAuthority|null|undefined} authority
 */
export function withPrivacyAuthority(store, authority) {
  if (!authority) return store;
  /** @type {HeldRules|null} */
  let held = authority.rules ?? null;
  const wrapped = Object.create(store);

  /**
   * Rows mode: a tier on one row, through the control plane's `setAccess` from the version held. The held rules
   * are then brought up to date, so a later check in this request sees the write. `base` is `inherit` when a
   * note's tier is what it would inherit anyway (as an exception is removed from the rules), and `tier` otherwise.
   */
  const setRowTier = async (path, tier, { folder = false } = {}) => {
    const inherited = visibilityOf(
      path,
      held.folders.map((rule) => ({ prefix: rule.prefix, vis: rule.visibility })),
    );
    const base = !folder && tier !== "inherit" && tier === inherited ? "inherit" : tier;
    const answer = await authority.setAccess({
      path,
      base,
      expectedVersion: held.accessVersion,
      ...(folder ? { kind: "folder" } : {}),
    });
    if (answer?.ok !== true) return answer ?? { ok: false };
    const listKey = folder ? "folders" : "notes";
    const field = folder ? "prefix" : "path";
    const existing = held[listKey].find((rule) => rule[field] === path)?.visibility;
    const after = visibilityAfter(base, existing);
    const others = held[listKey].filter((rule) => rule[field] !== path);
    const entries = after === null ? others : [...others, folder ? { prefix: path, visibility: after } : { path, visibility: after }];
    held = { ...held, [listKey]: entries, accessVersion: answer.version };
    return answer;
  };

  /** Rows mode: people added to one row's list through the control plane. The held rules move to its version. */
  const addRowPeople = async (path, entries) => {
    if (typeof authority.addGrantees !== "function") return { ok: false, code: "NOT_ROWS_MODE" };
    const answer = await authority.addGrantees({ path, entries });
    if (answer?.ok !== true) return answer ?? { ok: false };
    held = { ...held, accessVersion: answer.version };
    return answer;
  };

  const render = async () => {
    const rules = held;
    const file = await store.get(PRIVACY_KEY);
    const fileText = file === null ? null : await file.text();
    const text = hasRowToken(rules) ? renderForReading(fileText, rules) : renderWithRules(fileText, rules);
    return { text, file, rules };
  };

  wrapped.get = async (key, ...rest) => {
    if (key !== PRIVACY_KEY || held === null) return await store.get(key, ...rest);
    const { text, file, rules } = await render();
    return objectFor(text, rules.etag, file, preParsedOf(rules));
  };

  if (typeof store.head === "function") {
    wrapped.head = async (key, ...rest) => {
      if (key !== PRIVACY_KEY || held === null) return await store.head(key, ...rest);
      return (await wrapped.get(key)) === null ? null : { etag: held.etag };
    };
  }

  /**
   * Write the bucket's file from the rules, and say whether that happened.
   * `prose` is the text just written, when there is one, so its prose is kept;
   * otherwise the bucket file's own.
   */
  const exportNow = async (prose) => {
    if (held === null) return null;
    // Rows mode (the held rules carry the rows' version): the rows are the truth and `privacy.md` is not written from them.
    if (typeof held.accessVersion === "number") return null;
    // Rules that name a row's grants are never written into the bucket: a row token has no place in `privacy.md`.
    if (hasRowToken(held)) throw new Error("privacy.md is not written from access rows: the rules name a row's grants");
    const { text, rules } =
      typeof prose === "string" ? { text: renderWithRules(prose, held), rules: held } : await render();
    let put;
    try {
      put = await store.put(PRIVACY_KEY, text);
    } catch (error) {
      await authority.owed().catch(() => {});
      throw error;
    }
    await authority.exported({ rendered: rules.etag, etag: put?.etag ?? null });
    return { rendered: rules.etag, etag: put?.etag ?? null };
  };
  /** The export, for the control plane's retry of one that was owed. */
  wrapped.exportPrivacy = () => exportNow();

  // Rows mode only (`held.accessVersion` is set): the rows are the truth, and a row's tier goes through `setAccess`.
  Object.defineProperty(wrapped, "rowAccess", {
    enumerable: false,
    get: () =>
      held !== null && typeof held.accessVersion === "number" ? { setTier: setRowTier, addPeople: addRowPeople } : undefined,
  });

  wrapped.put = async (key, value, options) => {
    if (key !== PRIVACY_KEY) return await store.put(key, value, options);
    const text = textOf(value);
    const rules = text === null ? null : rulesOfText(text);
    if (held === null) {
      const put = await store.put(key, value, options);
      if (put && rules !== null) {
        await authority
          .written({ previous: options?.onlyIf?.etagMatches ?? null, etag: put.etag, ...rules })
          .catch(() => {});
      }
      return put;
    }
    // The authority never takes a file it cannot read the rules of: that
    // would be a change to who sees what made by accident.
    if (rules === null) throw new Error("privacy.md is missing its managed rules block");
    // The file exists while there are rules, so a create-only write loses.
    if (options?.onlyIf?.absent === true) return null;
    const swapped = await authority.write({ expected: options?.onlyIf?.etagMatches ?? null, ...rules });
    // The file is the authority again (staff handed it back, or it moved past
    // a copy): this store stops rendering the rules, so the caller's next read
    // is the bucket's own file, and its retry writes that.
    if (swapped === null) {
      held = null;
      return null;
    }
    // Someone changed the rules first: the caller's next read sees theirs, and it retries on them.
    if (swapped?.current) held = swapped.current;
    if (typeof swapped?.etag !== "string") return null;
    held = { etag: swapped.etag, ...rules };
    // The rules have changed. The file follows; when it cannot, it is owed.
    await exportNow(text).catch(() => {});
    return { etag: swapped.etag };
  };

  wrapped.delete = async (key, options) => {
    if (key !== PRIVACY_KEY || held === null) return await store.delete(key, options);
    // Removing the file removes no rule. The export puts it back.
    await store.delete(key);
    await authority.owed().catch(() => {});
    return undefined;
  };

  if (typeof store.copy === "function") {
    wrapped.copy = async (source, destination, options) => {
      if (destination === PRIVACY_KEY && held !== null) {
        throw new Error("privacy.md is written from the workspace's rules, not copied over");
      }
      return await store.copy(source, destination, options);
    };
  }

  return wrapped;
}
