/**
 * A search asked of one workspace also names its title matches elsewhere.
 *
 * A person's question often names a workspace because the question is about
 * its topic ("the coach reading list" in a workspace called `@kiln-guild`).
 * A search addressed with `context` opens only that workspace, so a note that
 * lives in the person's own workspace, titled with the topic, was invisible to
 * it, and the answer was "no such list". When the scoped answer holds no title
 * match, the caller's own unscoped search (every workspace the person reaches,
 * through every gate) is run too, and its title matches outside the named
 * workspace are appended. Nothing here resolves a context: the wide search is
 * the caller's ordinary call with no `context`, made in `callToolForSession`.
 */

import { MEANING_ONLY_LABEL } from "../search/meaning/serve.js";
import { searchSettingsOf } from "../search/settings.js";
import { titleCoverage } from "../search/evidence.js";

/** A title or file name must hold at least this share of the query's terms. */
const TITLE_FLOOR = 0.5;

/** Most titled hits from other workspaces that are appended. */
const ELSEWHERE_HITS = 3;

/** The name of a workspace with the leading `@` and case dropped, for comparing names. */
const bare = (name) => String(name).replace(/^@/, "").toLowerCase();

/**
 * The `@name` a `search_notes` call asks of, when it is a search the caller
 * could widen: named, not the current workspace, unpinned by a prefix, with a
 * query, from a store that reaches other workspaces with `everywhere` on.
 * Null otherwise.
 *
 * @param {{ name?: string, arguments?: Record<string, unknown> }} call
 * @param {{ openContext?: unknown, contexts?: { name: string, current?: boolean }[], searchSettings?: object }} store
 * @returns {string | null}
 */
export function namedOtherWorkspace(call, store) {
  if (call?.name !== "search_notes") return null;
  const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
  const named = args.context;
  if (typeof named !== "string" || named.trim() === "") return null;
  if (typeof args.prefix === "string" && args.prefix !== "") return null;
  if (typeof args.query !== "string" || args.query.trim() === "") return null;
  if (typeof store?.openContext !== "function") return null;
  if (!searchSettingsOf(store).everywhere) return null;
  const current = (store.contexts ?? []).find((entry) => entry?.current)?.name;
  if (typeof current === "string" && bare(current) === bare(named)) return null;
  return named;
}

/**
 * The hits in a search's text that are titled by the query: each block's first
 * line is its key, and a block is kept when its file name holds at least half
 * the query's terms. Meaning-only blocks are skipped (their title is not what
 * matched), and so is any key under `skip` (a workspace's `@name/` prefix).
 *
 * @param {string} text a `search_notes` result's text
 * @param {string} query
 * @param {{ skip: string | null }} options
 * @returns {{ key: string, block: string }[]}
 */
export function titledKeys(text, query, { skip }) {
  const body = String(text ?? "");
  // "(no matches)" has no hits, and its header is not a block.
  if (body.startsWith("(no matches)")) return [];
  const blocks = body.split("\n\n").slice(1);
  const skipPrefix = typeof skip === "string" && skip !== "" ? `${skip.toLowerCase()}/` : null;
  const out = [];
  for (const block of blocks) {
    if (block.includes(MEANING_ONLY_LABEL)) continue;
    const key = block.split("\n")[0];
    if (!key) continue;
    if (skipPrefix !== null && key.toLowerCase().startsWith(skipPrefix)) continue;
    if (titleCoverage(query, { key, title: "" }) < TITLE_FLOOR) continue;
    out.push({ key, block });
  }
  return out;
}

/**
 * The scoped result, extended with the titled hits of the wide search that are
 * not in the named workspace. The scoped result is returned as-is when it is an
 * error, already holds a titled hit, or the wide search has none to add.
 *
 * @param {{ content: { type: string, text: string }[], isError?: boolean }} scoped
 * @param {{ content: { type: string, text: string }[], isError?: boolean }} wide
 * @param {string} query
 * @param {string} named the `@name` the scoped search was asked of
 */
export function withElsewhere(scoped, wide, query, named) {
  if (scoped?.isError) return scoped;
  const scopedText = scoped?.content?.[0]?.text ?? "";
  if (titledKeys(scopedText, query, { skip: null }).length > 0) return scoped;
  if (wide?.isError) return scoped;
  const found = titledKeys(wide?.content?.[0]?.text ?? "", query, { skip: named }).slice(0, ELSEWHERE_HITS);
  if (found.length === 0) return scoped;
  const paragraph =
    `\n\nThis search was asked of ${named} only. A workspace named in a question is often its topic, not where the note lives: ` +
    "in the other workspaces they reach, these are named for it (a path without @name/ is in their own workspace: read it with no context):\n\n" +
    found.map((entry) => entry.block).join("\n\n");
  return { ...scoped, content: [{ ...scoped.content[0], text: scopedText + paragraph }, ...scoped.content.slice(1)] };
}
