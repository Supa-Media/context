// The matrix's own checks, on a pretend page: a folded panel that still draws
// its Tex chat is caught, and so is a page that scrolls sideways (Dev2,
// 2026-11-21: the chat stayed over the note after folding).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stateProblems } from "./uiMatrix.mjs";

function page({ shown = [], warmBox = null, sideways = 0 }) {
  return {
    getByTestId: (id) => ({
      count: async () => (shown.includes(id) || (id === "aside-tex-warm" && warmBox !== null) ? 1 : 0),
      first: () => ({ isVisible: async () => shown.includes(id), boundingBox: async () => warmBox }),
    }),
    evaluate: async () => sideways,
  };
}

test("a folded panel with nothing of itself drawn passes", async () => {
  assert.deepEqual(await stateProblems(page({ warmBox: { width: 0, height: 0 } }), "s", "folded"), []);
});

test("a folded panel still drawing the Tex chat fails, by its test id or by the hidden chat's size", async () => {
  assert.match((await stateProblems(page({ shown: ["aside-tex"] }), "s", "folded"))[0], /aside-tex is drawn while the panel is folded/);
  assert.match((await stateProblems(page({ warmBox: { width: 320, height: 800 } }), "s", "folded"))[0], /hidden Tex chat takes 320x800/);
});

test("an open panel may draw the chat, but nothing may scroll sideways", async () => {
  assert.deepEqual(await stateProblems(page({ shown: ["aside-tex"] }), "s", "open"), []);
  assert.match((await stateProblems(page({ sideways: 40 }), "s", "open"))[0], /scrolls sideways by 40px/);
});
