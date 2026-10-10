/** `search_notes`, and ChatGPT's `search` and `fetch`. */

import { canSee, isPlumbing } from "../privacy/engine.js";
import { encryptedNoteRefusal, openStoredNote } from "../notes/sealing.js";
import { forwardPath, readForwarding } from "../forwarding.js";
import { getVisibleMovedNote } from "../notes/visibleKeys.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { normalizePath, noteUrl } from "../notes/paths.js";
import { NOTE_INDEX_CHAR_CAP } from "../search/maintain.js";
import { noteTitle, splitReducedRecallNotes } from "../search/visible.js";
import { probeWithLegacyFallback } from "../notes/storage.js";
import { searchVisibleNotes } from "../search/visibleNotes.js";
import { MEANING_ONLY_LABEL, meaningSearchable, searchBothWays } from "../search/meaning/serve.js";
import { meaningEmbedderFor } from "../search/meaning/store.js";
import { searchSettingsOf } from "../search/settings.js";
import { loadPrivacyState } from "../privacy/state.js";
import { folderPrefix } from "../search/indexable.js";
import { splitMessageAnchor } from "../search/commsIndex.js";
import { toolError, toolText } from "./results.js";

/** Most hits a search across every workspace shows: a round of each list's best, bounded. */
const EVERYWHERE_HITS = 12;

/** Word search and search by meaning in one workspace, as `search_notes` has always asked. */
function searchOne(store, scope, rules, overrides, query, prefix, embed) {
  return searchBothWays(
    store,
    () => searchVisibleNotes(store, scope, rules, overrides, query, prefix),
    // A folder, never the start of a sibling's name: see `folderPrefix`. The
    // app answers alike (`apps/convex/__tests__/searchParity.test.ts`).
    { query, scope, prefix: folderPrefix(prefix), isVisible: (path) => canSee(path, scope, rules, overrides), ...(embed ? { embed } : {}) },
  );
}

/**
 * One query, one fingerprint: the embedder of the connection's own store,
 * remembered after the first call, so a search across six workspaces embeds
 * the query once. Undefined when this store has no meaning index, and each
 * workspace then embeds on its own terms.
 */
function sharedEmbedder(store) {
  if (!meaningSearchable(store)) return undefined;
  let vector = null;
  return async (texts) => {
    if (vector === null) [vector] = await meaningEmbedderFor(store)(texts);
    return [vector];
  };
}

/**
 * `search_notes` across every workspace the person can reach (the setting
 * `everywhere`, `../search/settings.js`; asked for by the owner 2026-10-10 so
 * an assistant need not guess which workspace an answer lives in).
 *
 * Each other workspace is opened the way a tool call addressed with
 * `context: "@name"` opens it (`store.openContext`), so it is searched under
 * the person's role *there* and its own `privacy.md`: a note held back from a
 * member is as absent through this as through a direct search. A workspace
 * that cannot be opened or read right now is left out, never guessed at. The
 * lists are fused a rank at a time, this workspace first, and a hit from
 * another workspace carries its name in front of the path.
 */
async function searchEverywhere(store, here, names, query, embed) {
  const elsewhere = (
    await Promise.all(
      names.map(async (name) => {
        try {
          const { session: target, store: targetStore } = await store.openContext(name);
          const privacy = await loadPrivacyState(targetStore);
          if (privacy.error) return null;
          const found = await searchOne(targetStore, target.scope, privacy.rules, privacy.overrides, query, "", embed);
          return { name, found };
        } catch {
          return null;
        }
      }),
    )
  ).filter(Boolean);
  const lists = [here.hits, ...elsewhere.map(({ name, found }) => found.hits.map((hit) => ({ ...hit, key: `${name}/${hit.key}` })))];
  const hits = [];
  for (let rank = 0; hits.length < EVERYWHERE_HITS; rank += 1) {
    let any = false;
    for (const list of lists) {
      if (list[rank] === undefined) continue;
      any = true;
      if (hits.length < EVERYWHERE_HITS) hits.push(list[rank]);
    }
    if (!any) break;
  }
  return {
    ...here,
    hits,
    matchCount: elsewhere.reduce((total, { found }) => total + found.matchCount, here.matchCount),
    matchCountIsFloor: here.matchCountIsFloor || elsewhere.some(({ found }) => found.matchCountIsFloor),
    crossWorkspace: hits.some((hit) => hit.key.startsWith("@")),
  };
}

export async function toolSearchNotes(store, scope, rules, overrides, query, prefixArg) {
  if (!query || typeof query !== "string") return toolError("query required");
  const prefix = prefixArg ? normalizePath(prefixArg) : "";
  if (prefixArg && prefix === null) return toolError("invalid prefix");
  // A prefix names a folder in this workspace, so a search with one stays here.
  const names =
    searchSettingsOf(store).everywhere && !prefix && typeof store.openContext === "function"
      ? (store.contexts ?? []).filter((entry) => !entry.current && typeof entry.name === "string").map((entry) => entry.name)
      : [];
  const embed = names.length > 0 ? sharedEmbedder(store) : undefined;
  const here = await searchOne(store, scope, rules, overrides, query, prefix, embed);
  const found = names.length > 0 ? await searchEverywhere(store, here, names, query, embed) : here;
  const hits = found.hits.map(({ key, snippets, title, meaningOnly }) =>
    meaningOnly
      ? // Found by what it is about, not by the words typed: said so, so an
        // agent does not quote the snippet as if it carried the term.
        `${key}\n    (${MEANING_ONLY_LABEL})\n${(snippets.length ? snippets : [title])
          .map((line) => `    ${line}`)
          .join("\n")}`
      : snippets.length
      ? `${key}\n${snippets.map((line) => `    ${line}`).join("\n")}`
      : // Indexed, then edited: it matched when it was indexed and its current
        // text does not carry the term. The title was actually read; a snippet
        // here would be invented.
        `${key}\n    ${title}`
  );
  // An empty search is the moment an agent decides the context is useless and
  // answers from its own head. It is almost always the wrong conclusion — the
  // note exists under a word the user would have used and this query did not —
  // so the miss says what to try instead of stopping the sentence at "no".
  let out = hits.length
    ? `${found.matchCount}${found.matchCountIsFloor ? "+" : ""} matching note${
        found.matchCount === 1 && !found.matchCountIsFloor ? "" : "s"
      }${hits.length < found.matchCount ? ` — the ${hits.length} best shown` : ""}\n\n${hits.join(
        "\n\n"
      )}`
    : "(no matches)\n\nA miss usually means the wrong word rather than the wrong assumption — " +
      (found.meaning === "off"
        ? "this searches the words in the notes, not their meaning. "
        : "this searched the words in the notes and what they are about, and nothing was close. ") +
      "Before concluding it is not " +
      "written down: try the term the user would have typed, drop the prefix if you passed " +
      "one, or call orient / list_notes to see which folders exist. And if the note is long, " +
      `a note is indexed by its opening ${NOTE_INDEX_CHAR_CAP.toLocaleString("en-US")} characters, ` +
      "so a term deep inside a saved session or a long log will not match here even though " +
      "read_note returns the whole file.";
  // The floor, in the language the census and orient already use. Deliberately
  // no number: how many notes are still unindexed is a fact about the whole
  // bucket, private notes included, and this connection may not be able to see
  // them.
  if (found.indexIncomplete) {
    out +=
      "\n\n[note: the search index is still catching up on this context, so these results may " +
      "be incomplete — searching again continues the backfill]";
  }
  // Distinct from the banner above on purpose (`docs/decisions/search.md`,
  // sizing section): that one resolves by searching again, and this one does
  // not — a channel-day note past the index's per-shard capacity keeps
  // exactly one summary document until the note itself shrinks or the index
  // gets more room. Named rather than counted, and only the notes this
  // caller may already see: `found.reducedRecallNotes` is pre-filtered by
  // `isVisible`, the same as every hit above it.
  if (found.reducedRecall && found.reducedRecallNotes?.length) {
    // Bounded for the same reason `orient`'s copy is: unbounded, a mailbox
    // that sheds by the day turns a one-hit answer into 23,000 characters of
    // warning, which buries the hits this search did find. The overflow is
    // counted rather than dropped — see `RENDERED_RECALL_NOTE_LIMIT`.
    const { shown, rest } = splitReducedRecallNotes(found.reducedRecallNotes);
    out +=
      "\n\n[note: these notes hold more messages than the search index can keep in full, so a " +
      "term that appeared only in a message it had to drop will not surface here even though " +
      "the note itself still exists and read_note always returns it whole — a miss on one of " +
      `these is not proof the content is gone, only that this search cannot reach all of it: ` +
      `${shown.join(", ")}${rest ? ` (+${rest} more)` : ""}]`;
  }
  if (found.degraded && (found.totalCount > found.scannedCount || found.totalIsFloor)) {
    out += `\n\n[note: scanned ${found.scannedCount} of ${found.totalCount}${
      found.totalIsFloor ? "+" : ""
    } notes — narrow with a prefix if needed]`;
  }
  if (found.crossWorkspace) {
    out +=
      '\n\nA path that starts with @name/ is in that workspace: pass context: "@name" with its path to read_note, or to any other tool, to reach it.';
  }
  return toolText(out);
}

/** The first heading if the note has one, else its filename. */
export async function toolOpenAiSearch(store, scope, rules, overrides, query) {
  if (!query || typeof query !== "string") return toolError("query required");
  const { hits } = await searchBothWays(
    store,
    () => searchVisibleNotes(store, scope, rules, overrides, query, ""),
    { query, scope, isVisible: (path) => canSee(path, scope, rules, overrides) },
  );
  // Titles come from the text already fetched for the snippets, so a result
  // costs no read of its own. This used to spend a second GET per hit, which
  // doubled the most expensive part of the old scan.
  const results = hits.map(({ key, title, snippets }) => ({
    id: key,
    title,
    text: (snippets.length ? snippets.join(" … ") : title).slice(0, 400),
    url: noteUrl(key),
  }));
  return toolText(JSON.stringify({ results }));
}

export async function toolOpenAiFetch(store, scope, rules, overrides, idArg) {
  // `search` answers a message inside a channel-day note with the id
  // `<notePath>#<anchor>`, and `fetch(id)` is the only thing ChatGPT does
  // with an id it was given. Split before the `.md` test, which that id
  // would otherwise fail one line before the read ever happened.
  const path = splitMessageAnchor(normalizePath(idArg) ?? "").path;
  if (!path || !path.endsWith(".md")) return toolError("invalid id");
  if (isPlumbing(path)) return toolError("not found");
  /*
    `read_note`'s rule, because this is `read_note`: the resolution runs the
    same way for everybody and the decision is taken once both answers are in,
    so the refusal for a note being held back costs what the refusal for an
    absent one costs. It resolves on metadata and fetches the body only after
    both questions have passed — this door was the widest of the four, 1 trip
    against 3.
  */
  const seen = canSee(path, scope, rules, overrides);
  const found = await getVisibleMovedNote(
    store,
    scope,
    rules,
    overrides,
    path,
    probeWithLegacyFallback,
  );
  let present = Boolean(found.object);
  let physicalPath = found.physicalPath;
  // Metadata can report a logical-delete marker as present. Resolve the
  // authorized logical object before deciding whether the stale path needs
  // forwarding, exactly as read_note does; otherwise a tombstone suppresses
  // the forwarding lookup and the fetch ends as a false not-found.
  let obj = seen && present ? await getWithLegacyFallback(store, physicalPath) : null;
  if (seen && present && !obj) present = false;
  if (!seen || !present) {
    const forwarded = forwardPath(await readForwarding(store), path);
    if (forwarded !== path && canSee(forwarded, scope, rules, overrides)) {
      const landed = await getVisibleMovedNote(
        store,
        scope,
        rules,
        overrides,
        forwarded,
        probeWithLegacyFallback,
      );
      if (landed.object && seen && !present) {
        const landedObject = await getWithLegacyFallback(store, landed.physicalPath);
        if (landedObject) {
          present = true;
          physicalPath = landed.physicalPath;
          obj = landedObject;
        }
      }
    }
  }
  if (!seen || !present) return toolError("not found");
  if (!obj) return toolError("not found");
  const stored = await obj.text();
  // The same decrypt `read_note` does, because this is `read_note` wearing
  // OpenAI's contract and "a second path is a second place for a bug". A note
  // this request cannot open is refused rather than answered with its envelope
  // — returning the ciphertext as `text` would put it in a chat transcript.
  const opened = await openStoredNote(store, stored);
  if (!opened.ok) return encryptedNoteRefusal(path);
  return toolText(
    JSON.stringify({
      id: path,
      title: noteTitle(path, opened.text),
      text: opened.text,
      url: noteUrl(path),
      metadata: { etag: obj.etag, encrypted: opened.encrypted || undefined },
    })
  );
}
