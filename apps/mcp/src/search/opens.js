/**
 * OPENS AS EVIDENCE (Dev2, 2026-11-22). Each workspace's object counts how often each note is opened
 * (`workspaceStore/opens.js`): by the searching person in the app, by every person, and by AI clients, apart. Here:
 *
 *   - `countAiRead`: a `read_note` (or ChatGPT's `fetch`) that handed a note back is one AI read of it, recorded in the
 *     object that holds the note, behind the response. A search hit that was only listed is never counted.
 *   - `countPersonOpen`: the app opening a note is one open by that person, recorded the same way.
 *   - `opensOf`: a search's counts for the notes it found, from the object, for the "Opened before" step to rank by.
 *   - `openWeight`: the multiplier those counts give a hit: 1 for a note nobody opened, and for each count a
 *     logarithmic share, so the fifth open of a note adds less than the first, and a much-opened index page cannot
 *     outrank everything a query is about. Its three weights are the step's settings (`ranking.js`).
 */
import { normalizePath } from "../notes/paths.js";
import { TEX_CLIENTS } from "./quality.js";

/** An id the opens log keeps as it is (`workspaceStore/opens.js`), or null: one it would refuse is dropped, not the open. */
const idOrNull = (value) => (typeof value === "string" && /^[A-Za-z0-9_:.-]{1,128}$/.test(value) ? value : null);

/** The object client of a store whose notes live in its workspace object, or null. */
function objectOf(store) {
  const reading = store?.objectReading;
  return reading && reading.home === "object" && reading.client?.opens ? reading.client : null;
}

/** Record a successful AI read of a note in its workspace's object, behind the response. Never throws. */
export function countAiRead(name, args, store, result) {
  try {
    if (result?.isError) return;
    const raw = name === "read_note" && args?.mail === undefined ? args?.path : name === "fetch" ? args?.id : undefined;
    if (typeof raw !== "string") return;
    const path = normalizePath(raw);
    const client = objectOf(store);
    if (!path || client === null) return;
    const actor = store.actor ?? {};
    const clientId = idOrNull(actor.clientId);
    const who = idOrNull(actor.userId);
    const clientName = typeof actor.clientName === "string" && actor.clientName !== "" ? actor.clientName.slice(0, 120) : null;
    // Tex reads over text; any other AI client over MCP. The person behind the read is kept, as who it was for.
    const surface = clientId !== null && TEX_CLIENTS.has(clientId) ? "text" : "mcp";
    const work = client.opens.record({ path, who, by: "ai", surface, client: clientId, clientName }).catch(() => null);
    if (typeof store.defer === "function") store.defer(work);
  } catch {
    // A read that cannot be counted is no reason to fail the read.
  }
}

/**
 * Record a person's open of a note in the app (`live/noteReadRoute.js`, the app's one way to open a note) in its
 * workspace's object, under who they are, behind the response. Never throws.
 */
export function countPersonOpen(store, path) {
  try {
    const client = objectOf(store);
    const who = store?.objectReading?.userId;
    if (client === null || typeof who !== "string" || who === "") return;
    const clientId = idOrNull(store.actor?.clientId);
    const work = client.opens.record({ path, who, by: "person", surface: "app", client: clientId }).catch(() => null);
    if (typeof store.defer === "function") store.defer(work);
  } catch {
    // An open that cannot be counted is no reason to fail it.
  }
}

/**
 * `{ [path]: { mine, people, ai } }` for `paths` in the store's workspace, the asker's own opens under `mine`; `{}` when
 * the notes do not live in an object, or it could not answer: a search never waits on a failure here.
 */
export async function opensOf(store, paths) {
  const client = objectOf(store);
  if (client === null || paths.length === 0) return {};
  try {
    const who = store.objectReading.userId ?? null;
    const answer = await client.opens.of(paths.slice(0, 200), typeof who === "string" ? who : null);
    return answer?.served === true && answer.opens && typeof answer.opens === "object" ? answer.opens : {};
  } catch {
    return {};
  }
}

/** The multiplier a note's opens give its score: `1 + Σ weight × log2(1 + count)`, each count weighed apart. */
export function openWeight(opens, ranking) {
  if (!opens || typeof opens !== "object") return 1;
  const part = (count, weight) => (Number.isFinite(count) && count > 0 && Number.isFinite(weight) ? weight * Math.log2(1 + count) : 0);
  // "Everyone's" opens beyond the asker's own: the asker's already count once, under `mine`.
  const others = Math.max(0, (opens.people ?? 0) - (opens.mine ?? 0));
  return 1 + part(opens.mine ?? 0, ranking.openMine ?? 0) + part(others, ranking.openPeople ?? 0) + part(opens.ai ?? 0, ranking.openAi ?? 0);
}
