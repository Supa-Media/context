/**
 * Searching the whole context from the console, rather than filtering the
 * folders somebody happened to expand.
 *
 * The palette was a file picker wearing a magnifying glass: it ranked the
 * listings the browser had already loaded, and said so — "only folders you
 * have opened are searched". For a person looking up a name they wrote down
 * months ago, that is a miss on the one question search exists to answer, and
 * an honest message about it does not make it less of a miss.
 *
 * This asks `functions/files.searchContext`, which runs the gateway's own
 * indexed search over the customer's bucket. Five consequences worth knowing:
 *
 *  - **It costs a round trip and touches storage**, so the query is debounced
 *    and short queries are never sent. Every keystroke reaching the bucket
 *    would spend somebody's request quota on prefixes of a word.
 *  - **It can be behind.** The index is a derivative that catches up over
 *    successive calls, and a context that has never been searched has none at
 *    all. `indexing` is reported as its own state, never as "no matches".
 *  - **It can be missing something on purpose, permanently.** A mailbox note
 *    past the index's own per-shard capacity keeps one summary document and
 *    stays that way until it shrinks or the index grows — searching again
 *    does not fix it, unlike `indexing`. `reducedRecallNotes` names the
 *    caller's own affected notes and `reducedRecallMessage` is the sentence
 *    that says so, the same one an AI client reads off the same field.
 *  - **Answers can arrive out of order.** Each request records the query it
 *    was for and a later answer for an earlier query is dropped, so a fast
 *    reply to "ike" cannot overwrite the results for "ikenna".
 *  - **It can fail to arrive at all**, and that has to end. `searchContext` is
 *    a Convex action, and `ConvexReactClient.action()` has no client-side
 *    timeout — the same property `features/offline` exists around — so a
 *    request lost to a dead uplink leaves "Searching the rest of this
 *    context…" on screen with nothing behind it and no way out but retyping.
 *    A spinner that cannot stop is the one state a person cannot act on.
 *
 * ## And it can answer with no connection at all
 *
 * The phone holds every note body in its mirror (`features/offline/mirror*`),
 * so a search with no signal has something to read. `device` is that search
 * (`features/offline/mirrorSearch.ts`), and the rule for when it answers is
 * the smallest one that removes the defect:
 *
 *  - **Offline, the device answers and the bucket is not asked.** Asking would
 *    buy exactly the ten-second spinner this exists to remove, for an answer
 *    that cannot arrive.
 *  - **Online, the bucket answers, as it always has.** Its index is the whole
 *    context at the caller's clearance and ranks by what the notes say; the
 *    device's copy can be behind by a sync, and a search that silently
 *    preferred it would be the stale answer somebody did not ask for.
 *  - **Online and the bucket fails or times out, the device answers — and
 *    says so.** "Unknown" reachability is treated as online, for the reason
 *    `connectionLine` gives: a claim of offline that flashes on every cold
 *    start teaches people to ignore it.
 *
 * Showing the device's answer first and replacing it with the bucket's was
 * considered and not done: the two rank differently, so the list would
 * reorder under a thumb about to press a row — the flicker `landingStep`
 * exists to prevent, on the one surface where a mis-press opens the wrong note.
 *
 * Every answer from the device carries `notice` — that it came from the device,
 * why, how much of the context is on it, and how many encrypted notes it could
 * not read — because a list from a partial copy that did not say so reads as
 * the whole answer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SearchAnswer } from "./browser";
import type { PaletteItem } from "./palette";
import { parentPath } from "./paths";
import { raceTimeout } from "../storage/timeout";
import type { Reachability } from "../../offline/copy";
import {
  DEVICE_SEARCH_UNAVAILABLE,
  deviceSearchNotice,
  type DeviceSearchReason,
} from "../../offline/mirrorCopy";
import type { DeviceSearchAnswer } from "../../offline/mirrorSearch";
import type { MirrorStatus } from "../../offline/mirrorStatus";

/**
 * Below this, a query is a prefix of a word rather than a word, and the
 * results are noise bought with a round trip. The local filename filter keeps
 * answering underneath — a two-letter query is exactly what that half is good
 * at.
 */
const MIN_QUERY = 3;

/**
 * Long enough that typing a name does not send its prefixes, short enough that
 * the results feel like they belong to what is on screen.
 */
const DEBOUNCE_MS = 250;

/**
 * How long to wait for an answer before saying we stopped waiting.
 *
 * A search reads a ready index: a manifest, the shards the query's terms are
 * in, and the notes it quotes — a handful of round trips against the customer's
 * bucket, plus the one listing a miss over a converged index is allowed to buy.
 * Ten seconds is far past all of that and short enough that a palette does not
 * hold a spinner nobody can dismiss. It is the same order as the per-request
 * deadline the control plane puts on the customer's endpoint, which is what
 * would end a hung search from the other side if the request got that far.
 */
export const SEARCH_TIMEOUT_MS = 10_000;

export type SearchState = "idle" | "searching" | "ready" | "indexing" | "failed";

export interface ContextSearch {
  onQuery: (query: string) => void;
  items: PaletteItem[];
  state: SearchState;
  /**
   * The caller's own visible notes that hold more messages than the search
   * index can keep in full, or `[]` where none do (including every state
   * that is not a settled answer — idle, searching, timed out or failed).
   *
   * Unlike `state`, this is not folded away once there are hits on screen:
   * a shed note's miss is permanent rather than "ask again in a moment", so
   * the caveat belongs beside a real answer as much as beside an empty one.
   * `reducedRecallMessage` turns this into what the palette actually draws.
   */
  reducedRecallNotes: readonly string[];
  /** Who answered what is on screen — the bucket's index, or the copy on this device. */
  source: "server" | "device";
  /**
   * A sentence for above the list, or `null`. Set for every answer from the
   * device (see the file comment) and for an offline search on a browser that
   * keeps no copy; never for the bucket's own answers, which say what they
   * need through `state` and `reducedRecallNotes`.
   */
  notice: string | null;
  /** The label over the results, where it differs from the palette's default. */
  heading?: string;
  /** What an answered search with no rows says, where the palette's default would be wrong. */
  emptyMessage?: string;
}

/**
 * The search over the copy on this device, as the console hands it in.
 *
 * `search` answers `null` when there is no mirror on this device at all — a
 * browser whose IndexedDB is refused — which is a different sentence from a
 * context with nothing in it yet (`mirrored: false`).
 */
export interface DeviceSearch {
  reachability: Reachability;
  /** The mirror's own account of this context, for "only 340 of 1,204". */
  status: MirrorStatus | undefined;
  search: (query: string) => Promise<DeviceSearchAnswer | null>;
}

type SearchHit = SearchAnswer["hits"][number];

/**
 * How many of the caller's own affected notes the palette names before it
 * switches to "(+N more)".
 *
 * A shed mailbox sheds by the day, so unbounded this is the same defect
 * `RENDERED_RECALL_NOTE_LIMIT` exists to stop in `apps/mcp/src/index.js` —
 * measured there at ~23,000 characters of warning burying a one-hit answer.
 * Three rather than that file's ten: a palette row is one line and the panel
 * itself is a few hundred pixels tall, so the ceiling this format can carry
 * before it reads as chrome rather than a caveat is much lower here than on
 * an `orient` page or a tool result meant to be read in full.
 */
export const REDUCED_RECALL_DISPLAY_LIMIT = 3;

/**
 * The rendered share of `paths`, and how many more there are.
 *
 * Mirrors `splitReducedRecallNotes` in `apps/mcp/src/search/visible.js`
 * exactly, at this surface's own limit: named, then counted, so the claim
 * stays true without ever growing with the mailbox. `paths` itself is never
 * mutated or truncated upstream — see `SearchAnswer.reducedRecallNotes`.
 */
export function splitReducedRecallNotes(
  paths: readonly string[],
  limit: number = REDUCED_RECALL_DISPLAY_LIMIT,
): { shown: readonly string[]; rest: number } {
  return { shown: paths.slice(0, limit), rest: Math.max(0, paths.length - limit) };
}

/**
 * The sentence a shed note earns, worded to match the fact an AI client
 * already reads off the same field — `apps/mcp/src/index.js`'s
 * `toolSearchNotes` and `orient` (`docs/decisions/search.md`, "A shed index
 * must say so to the caller it happened to"). Reused rather than invented a
 * third time: a person reading this in the console and the same fact from an
 * AI client must be told the same story, with the console's own verbs
 * ("open the note" for `read_note`, "a search" for `search_notes`) standing
 * in for tool names nobody here would recognise.
 *
 * `null` for an empty list — the palette renders nothing rather than an
 * empty banner — and the notes named are always the caller's own: `paths` is
 * already `canSee`-filtered on the server before it ever reaches this
 * function, the same guarantee `hits` carries.
 */
export function reducedRecallMessage(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const { shown, rest } = splitReducedRecallNotes(paths);
  const plural = paths.length !== 1;
  return (
    `${paths.length} ${plural ? "notes" : "note"} ${plural ? "hold" : "holds"} more messages ` +
    "than the search index can keep in full, so a term that appeared only in a message it had " +
    "to drop will not surface here — the note itself still exists, and opening it always shows " +
    `it whole. A miss on one of these is not proof the content is gone: ${shown.join(", ")}` +
    `${rest ? ` (+${rest} more)` : ""}`
  );
}

/** A hit as a palette row: the note's own title, over where it lives. */
export function itemsFromHits(hits: SearchHit[]): PaletteItem[] {
  return hits.map((hit) => {
    const folder = parentPath(hit.path);
    // The first matching line, when the search found one — the reason this row
    // is here, which a folder path alone never shows. Trimmed hard: a palette
    // row is one line, and a snippet that wraps pushes the next result off a
    // phone screen.
    const snippet = hit.snippets[0]?.trim();
    return {
      id: hit.path,
      label: hit.title,
      detail: snippet ? `${folder === "" ? "" : `${folder} · `}${snippet}`.slice(0, 120) : folder,
      kind: "note" as const,
    };
  });
}

/** What the palette shows for one settled search — set together, so no half of it lags. */
interface Shown {
  items: PaletteItem[];
  state: SearchState;
  reducedRecallNotes: readonly string[];
  source: "server" | "device";
  notice: string | null;
  heading?: string;
  emptyMessage?: string;
}

const IDLE: Shown = {
  items: [],
  state: "idle",
  reducedRecallNotes: [],
  source: "server",
  notice: null,
};

/** An answer from the device, as the palette draws it. */
export function shownFromDevice(
  answer: DeviceSearchAnswer | null,
  reason: DeviceSearchReason,
  status: MirrorStatus | undefined,
): Shown {
  if (answer === null) {
    // No mirror on this device. Offline that is the whole story and worth a
    // sentence; online the bucket's failure is, and `failed` already says it.
    return {
      ...IDLE,
      state: "failed",
      notice: reason === "offline" ? DEVICE_SEARCH_UNAVAILABLE : null,
    };
  }
  return {
    items: itemsFromHits(answer.hits),
    state: "ready",
    reducedRecallNotes: [],
    source: "device",
    notice: deviceSearchNotice({
      reason,
      status,
      encryptedSkipped: answer.encryptedSkipped,
      mirrored: answer.mirrored,
    }),
    heading: "On this device",
    emptyMessage: answer.mirrored
      ? "Nothing on this device matches that."
      : "There is nothing from this context on this device to search yet.",
  };
}

/**
 * @param search the browser's own `search`, or `null` where there is nothing
 *   to search — an all-contexts route has no single bucket to ask.
 * @param device the search over this device's copy of the same context, or
 *   `null` where there is none to offer (no context, or a clearance the
 *   console could not work out).
 */
export function useContextSearch(
  search: ((query: string) => Promise<SearchAnswer>) | null,
  device: DeviceSearch | null = null,
): ContextSearch {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<Shown>(IDLE);

  /** The query the newest request was for; older answers are ignored. */
  const latest = useRef("");

  /*
    Read through a ref, so a status that ticks while a download runs does not
    re-send the query. Whether the device is offline *is* a dependency: going
    offline with a failed search on screen should answer it from the device.
  */
  const deviceRef = useRef(device);
  deviceRef.current = device;
  const offline = device !== null && device.reachability === "offline";

  useEffect(() => {
    const trimmed = query.trim();
    if (search === null || trimmed.length < MIN_QUERY) {
      latest.current = trimmed;
      setShown(IDLE);
      return;
    }

    setShown((current) => ({ ...current, state: "searching" }));

    /** The device's answer, if the person has not typed since. */
    const fromDevice = async (local: DeviceSearch, reason: DeviceSearchReason) => {
      let answer: DeviceSearchAnswer | null;
      try {
        answer = await local.search(trimmed);
      } catch {
        answer = null;
      }
      if (latest.current !== trimmed) return;
      setShown(shownFromDevice(answer, reason, local.status));
    };

    const timer = setTimeout(() => {
      latest.current = trimmed;
      void (async () => {
        const local = deviceRef.current;
        if (offline && local !== null) {
          await fromDevice(local, "offline");
          return;
        }
        // Raced rather than awaited, so a request that never settles ends as a
        // stated failure instead of a permanent spinner. A late answer is
        // dropped rather than shown: `raceTimeout` settles once, and the query
        // check below drops it again if the person has typed since.
        const settled = await raceTimeout(
          // Called inside the race so a `search()` that throws synchronously is
          // a rejected promise here rather than an exception out of the effect.
          (async () => await search(trimmed))(),
          {
            ms: SEARCH_TIMEOUT_MS,
            schedule: (fn, ms) => setTimeout(fn, ms),
            cancel: (handle) => clearTimeout(handle),
          },
        );
        if (latest.current !== trimmed) return;
        if (settled.kind === "value") {
          const hits = itemsFromHits(settled.value.hits);
          // An empty answer from an index that is still catching up is not an
          // answer about somebody's notes. With hits on screen the caveat is
          // not worth a state of its own — the rows are real either way — but
          // with none, "nothing matches" would be exactly the claim this
          // feature exists to stop making.
          const behind =
            settled.value.indexMissing || (settled.value.indexIncomplete && hits.length === 0);
          setShown({
            items: hits,
            state: behind ? "indexing" : "ready",
            // Set beside `state` rather than folded into it: a shed note's miss
            // does not resolve by waiting, so — unlike `indexing` — this stays
            // true with real hits on screen exactly as it does over none.
            reducedRecallNotes: settled.value.reducedRecallNotes ?? [],
            source: "server",
            notice: null,
          });
          return;
        }
        // The bucket did not answer. Where the device holds a copy, that is
        // the answer left — labelled as the device's, never as the bucket's.
        const fallback = deviceRef.current;
        if (fallback !== null) {
          await fromDevice(fallback, "unreachable");
          return;
        }
        // A failure and a timeout land in the same place on purpose: both mean
        // this half of the palette has no answer, and the copy already says
        // only the loaded folders were filtered. Deliberately not an error
        // dialog either — the local filter is still filtering, so the palette
        // went from "better" back to what it was, and a modal over a working
        // list is worse than a line of text.
        setShown({ ...IDLE, state: "failed" });
      })();
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, search, offline]);

  const onQuery = useCallback((next: string) => setQuery(next), []);

  return useMemo(() => ({ onQuery, ...shown }), [onQuery, shown]);
}
