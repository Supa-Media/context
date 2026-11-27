import assert from "node:assert/strict";
import { screenNode } from "../../../../../packages/tex/gateway/agent/graph/nodes/screen.js";
import { saveSeen, screenNote, validSeen } from "../../../../../packages/tex/gateway/agent/screen.js";

const USER = "k7m2q9x4b8n3c6v1";
const CHAT = `app:${USER}`;

/** The chat objects, by name: what `POST /app/seen` keeps is what `GET /app/seen` answers. */
function chatObjects() {
  const kept = new Map();
  return {
    idFromName: (name) => name,
    get: (name) => ({
      fetch: async (request) => {
        if (request.method === "POST") {
          kept.set(name, await request.json());
          return new Response(null, { status: 204 });
        }
        return kept.has(name) ? Response.json(kept.get(name)) : new Response(null, { status: 404 });
      },
    }),
  };
}

export default {
  id: "app-open-sheet-seen",
  incident: "2026-11-27: with a sheet of what Tex does open in the app, Dev2 asked Tex to break up the file formats into rows, then \"do you see the file I have open??\"; Tex said it could not see the screen and guessed another file.",
  cause: "The app chat's texts run through the chat's queue like iMessage, so the turn arrives as the texting client with the chat app:<userId>; the screen read was gated on the console's client alone, so no app turn ever read what was open.",
  path: "1:1 text (app)",
  // Sabotage (2026-11-27): make `isAppTurn` name the console's client alone, as before, and the node answers
  // "not the app chat" and the turn note says nothing of the sheet.
  async run() {
    const env = { TEX_CHAT: chatObjects() };
    // The app's send: the open sheet, saved beside the chat before the text is handed over (`appChatRoute.js`).
    await saveSeen(env, CHAT, validSeen({ note: { workspace: "ws1", path: "products/capabilities/files.csv" } }), () => Date.now());
    // The turn, as the chat's queue asks the gateway: the texting client, the app chat named.
    const t = {
      session: { actorClientId: "context_texts", actorUserId: USER, workspaceId: "ws1" },
      body: { conversation: "texts", chat: CHAT, covers: ["e1"] },
      group: null,
      runner: false,
      env,
      dispatch: async () => ({ content: [{ text: "files.csv\n\nWhat Tex does,In a 1:1\nReads photos, PDFs, Word; hears voice memos,yes" }] }),
    };
    const out = await screenNode({}, { ctx: { turn: t } });
    assert.deepEqual(out.when, ["found"], `the node read the screen: ${JSON.stringify(out)}`);
    assert.equal(out.open, "sheet");
    const words = screenNote(t.screen);
    assert.match(words, /Open sheet: products\/capabilities\/files\.csv/, "the front door is told which sheet is open");
    assert.match(words, /Reads photos, PDFs, Word; hears voice memos/, "and what is in it");
    assert.match(words, /"this sheet" or "this spreadsheet" means this one/);
    // A phone text in the same person's chat never reads it.
    const texted = { ...t, body: { conversation: "texts", chat: "+15555550100", covers: ["e2"] }, screen: undefined };
    assert.deepEqual(await screenNode({}, { ctx: { turn: texted } }), { when: ["none"], why: "not the app chat" });
  },
};
