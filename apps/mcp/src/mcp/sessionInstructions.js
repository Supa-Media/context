/**
 * The connect-time instructions one connection is given: the static text in
 * `instructions.js` with a live, privacy-filtered sketch of its context.
 */

import { canSee } from "../privacy/engine.js";
import {
  INSTRUCTIONS_BODY,
  INSTRUCTIONS_HEAD,
  INSTRUCTIONS_INDEX_CHAR_CAP,
  INSTRUCTIONS_LAYOUT_CHAR_CAP,
  INSTRUCTIONS_REACH_CHAR_CAP,
  SERVER_INSTRUCTIONS,
} from "./instructions.js";
import { isVisibleNote } from "../orient/survey.js";
import { listImmediateLayout } from "../notes/storage.js";
import { loadPrivacyState } from "../privacy/state.js";
import { namedWithRest } from "../orient/render.js";
import { readFrontPage } from "../orient/frontPage.js";

/**
 * The instructions a specific connection is given, with a live sketch of the
 * context between the call to action and the rest of the argument.
 *
 * The static text above can tell an agent that this server is worth calling.
 * Only the customer's own front page can tell it *what is in here*, and that is
 * the difference between a tool an agent might use and one it reaches for. This
 * is the one payload every client reads without deciding to — it lands in the
 * system prompt for every conversation on the connection — so the sketch is
 * deliberately two cheap round trips and a hard character cap, not a survey.
 *
 * Three properties:
 *
 * **It is filtered like everything else.** The front page and the folder names
 * both go through `canSee`, so a team connection is told exactly what a team
 * connection may know. It runs after the session is resolved, never before.
 *
 * **It fails soft, always.** A slow bucket, a revoked key, a `privacy.md`
 * somebody broke in Obsidian: none of those may take down the handshake. The
 * static instructions are the floor, and a connection that gets them is fully
 * working — it just starts less curious.
 *
 * **It is a snapshot, and says so.** A client caches instructions for the life
 * of the connection, so this text ages while `orient` does not. Every sentence
 * that could be read as current points at `orient` for the live answer.
 */
export async function instructionsForSession(store, session) {
  try {
    const privacy = await loadPrivacyState(store);
    if (privacy.error) return SERVER_INSTRUCTIONS;
    const { scope } = session;
    const { rules, overrides } = privacy;
    const [frontPage, root] = await Promise.all([
      readFrontPage(store, scope, rules, overrides, INSTRUCTIONS_INDEX_CHAR_CAP),
      listImmediateLayout(store),
    ]);

    const folders = root.prefixes
      .filter((prefix) => canSee(prefix.replace(/\/$/, ""), scope, rules, overrides))
      .sort();
    const rootNotes = root.objects
      .filter(({ key }) => isVisibleNote(key, scope, rules, overrides))
      .map(({ key }) => key)
      .sort();
    const layout = namedWithRest(
      [...folders, ...rootNotes],
      INSTRUCTIONS_LAYOUT_CHAR_CAP,
      "more"
    );
    /*
      The other contexts this connection reaches, named at connect time.

      This payload is read once and sits in the system prompt for every
      conversation, which makes it the only surface that reaches a model before
      it has decided anything — and "there is a second context and you can
      address it" is precisely the kind of fact an agent will never go looking
      for. It costs nothing to say: these are names and roles the session
      already carried, and no bucket is opened to list them.
    */
    const others = (store.contexts || []).filter((entry) => !entry.current);
    const reach = others.length
      ? "This person can also reach " +
        namedWithRest(
          others.map((entry) => entry.name),
          INSTRUCTIONS_REACH_CHAR_CAP,
          "more, which orient lists"
        ).join(", ") +
        ". Every tool takes an optional `context` argument naming one of those; " +
        "what you may do there is decided by their role there, not by this connection."
      : "";
    if (!layout.length && !frontPage) {
      return reach
        ? `${INSTRUCTIONS_HEAD}\n\n${reach}\n\n${INSTRUCTIONS_BODY}`
        : SERVER_INSTRUCTIONS;
    }

    const sketch = [
      "\n\nWHAT IS IN HERE (a snapshot taken when this connection opened; call " +
        "`orient` for the live version, with note counts and recent activity)",
    ];
    if (layout.length) sketch.push(`Top level: ${layout.join(", ")}`);
    // Ahead of the front page, because it is one short line and the front page
    // is the piece a cap cuts: a person whose own page is a signpost to another
    // workspace needs the name of that workspace more than the signpost's end.
    if (reach) sketch.push(reach);
    if (frontPage) {
      sketch.push(`Their front page, \`index.md\`:\n\n${frontPage}`);
    } else {
      sketch.push(
        "There is no `index.md` yet. It is the front page of this context, and " +
          "writing one with them is a good early contribution."
      );
    }
    // The sketch sits between the call to action and the argument — see
    // `INSTRUCTIONS_SKETCH_BUDGET` for why it may not go last.
    return `${INSTRUCTIONS_HEAD}${sketch.join("\n\n")}\n\n${INSTRUCTIONS_BODY}`;
  } catch {
    return SERVER_INSTRUCTIONS;
  }
}
