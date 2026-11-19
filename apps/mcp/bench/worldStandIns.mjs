/**
 * WHAT THE WORLD STANDS IN FOR BEYOND ITS CONTROL PLANE AND BROWSER (`world.mjs`), one conversation's worth: Tex's
 * chat commands (`texCommands.mjs`), the connected-apps list, the look at a picture the bench drew
 * (`drawnPictures.mjs`), the mail that has arrived by the test's day, and the record of what no stand-in could
 * answer (`benchGaps.mjs`). Kept out of `world.mjs` so that file stays the world's wiring.
 */
import { benchGaps, isRouteGap, watchedBinding } from "./benchGaps.mjs";
import { createTexCommands } from "./texCommands.mjs";
import { drawnPictures, keepsRenders, looksPastDrawn } from "./drawnPictures.mjs";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

export function worldStandIns({ models, person }) {
  // What the bench's stand-ins could not answer this conversation, kept on its record.
  const gaps = benchGaps();
  // The chat's own settings, changed by the settings tools.
  const commands = createTexCommands({ group: models.group ?? null, setBy: String(person).toLowerCase().replace(/[^a-z0-9-]/g, "") });
  let commandsBefore = 0;
  const drawn = drawnPictures();
  return {
    gaps,
    /** The model transport: a look at a picture the bench itself drew is answered here, never by a model. */
    modelFetch: typeof models.gatewayFetch === "function" ? looksPastDrawn(models.gatewayFetch, drawn) : models.gatewayFetch,
    /** The browser Worker's stand-in, with its unanswered calls kept as gaps and its drawn pictures remembered. */
    binding: (inner) => keepsRenders(watchedBinding(inner, gaps), drawn),
    /**
     * A test conversation's world dates its mail (`setsWorld.mjs`): an email dated after the test's own day
     * (`mail_until:`) has not arrived yet for that test, or Monday's email would sit in the inbox of the Thursday before.
     */
    arrived: (email) => typeof models.mailUntil !== "string" || Number.isNaN(Date.parse(email.date)) || Date.parse(email.date) <= Date.parse(`${models.mailUntil}T23:59:59Z`) + 12 * 3_600_000,
    /** One call to the control plane: the routes its stand-in never learnt answered here, the rest by `below`. */
    async controlPlane(url, input, init, below) {
      const path = new URL(url).pathname;
      // Tex's chat commands (the settings tools).
      if (path === "/gateway/tex/command") return json(commands.answer(JSON.parse(typeof init?.body === "string" ? init.body : await new Request(input, init).text())?.command));
      // No bench person has connected an app (Slack and the rest): the list is empty and a call says so, as the
      // control plane does (`functions/connect*.ts` "not_connected"), instead of a route nobody answers.
      if (path === "/gateway/connect/apps") return json({ apps: [] });
      if (path === "/gateway/connect/call") return json({ ok: false, refused: "not_connected" });
      // Any other route the stand-in never learnt answers 404: the tool that asked fails on the bench, not on Tex.
      // A stand-in slower than the gateway waits (a simulated Gmail asking its model while the search's 25 s ran out,
      // running-the-shop 77, 2026-11-19) fails the tool with "timed out": that is the bench's failure too (`lateAnswer`).
      const response = await lateAnswer(() => below(input, init), signalOf(input, init), `the bench's control plane answered ${path}`, gaps);
      if (response.status === 404 && isRouteGap(path) && (await response.clone().json().catch(() => null))?.error === "not_found") gaps.add(`the bench's control plane has no ${path}`);
      return response;
    },
    /** A fetch to a host the world has no stand-in for, kept as a gap before the world refuses it. */
    noStandIn(url) {
      let host = "a host";
      try {
        host = new URL(url).host;
      } catch {
        // not an address
      }
      gaps.add(`the bench has no stand-in for ${host}`);
    },
    /** The settings changes since `mark()`: each a change the turn made, kept by the control plane, never in a note. */
    settingsChanges: () => commands.changes().slice(commandsBefore).map((detail) => ({ workspace: "this chat's settings", path: "tex", kind: "set", detail })),
    mark() {
      commandsBefore = commands.changes().length;
    },
  };
}

/** The abort signal a fetch was given, on its init or its Request. */
export const signalOf = (input, init) => init?.signal ?? (typeof input === "object" && input !== null ? input.signal : undefined) ?? null;

/**
 * A stand-in's answer, with a gap kept when the caller had already given up on it: the gateway aborts a control plane
 * or browser call at its own time limit (`controlPlane/client.js`), and a stand-in that answers after that (a simulated
 * service waiting on its model) made the tool fail for a reason production would not give it. `what` says which.
 */
export async function lateAnswer(call, signal, what, gaps) {
  const started = Date.now();
  const late = () => signal?.aborted === true && gaps.add(`${what} after the gateway stopped waiting (${Math.round((Date.now() - started) / 1000)} s)`);
  try {
    const answer = await call();
    late();
    return answer;
  } catch (error) {
    late();
    throw error;
  }
}

/**
 * What changed in a group chat's own home (its voice note, its memory) between two snapshots, as change rows. Left
 * out, "less emojis" kept in the chat's voice note read as nothing done (Training, 2026-11-18). `skip(path)` leaves
 * plumbing out; a routine's own file is the routine runner's.
 */
export function homeChanges(before, now, home, skip) {
  const out = [];
  for (const [key, text] of now) {
    const path = key.slice(home.length + 1);
    if (before.get(key) === text || skip(path) || path.startsWith("routines/")) continue;
    const was = before.get(key);
    out.push({ workspace: "this chat's home", path, kind: "written", detail: (was !== undefined && text.startsWith(was) ? text.slice(was.length) : text).replace(/\s+/g, " ").trim().slice(0, 300) });
  }
  return out;
}

/**
 * What a conversation changed in one invented workspace between two snapshots, as change rows: each note written
 * (with what it added, not the top of the note) and each deleted. Plumbing a turn writes for itself (history, reads,
 * audit, and the privacy manifest and activity log the gateway rewrites on every save) is not something it did:
 * round two failed six change questions for every setup on "changed another note", every one `privacy.md`.
 */
export function noteChanges(workspace, was, now, skip) {
  const out = [];
  for (const [path, text] of now) {
    if (was.get(path) === text || skip(path)) continue;
    const added = was.has(path) && text.startsWith(was.get(path)) ? text.slice(was.get(path).length) : text;
    out.push({ workspace, path, kind: "written", detail: added.replace(/\s+/g, " ").trim().slice(0, 300) });
  }
  for (const path of was.keys()) {
    if (!now.has(path) && !skip(path)) out.push({ workspace, path, kind: "deleted", detail: "" });
  }
  return out;
}
