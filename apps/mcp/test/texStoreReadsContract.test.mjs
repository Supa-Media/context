/**
 * Tex's store reads moved onto shared contracts (`packages/shared/src/texContract/`) and Tex-side reads of the
 * store it is handed (`packages/tex/gateway/agent/pinnedNote.js`). These hold each copy to the gateway's answer, so a
 * change on one side that the other did not follow fails here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isTexKey as engineTexKey, isTexStateKey as engineStateKey, PRE_PARSED_RULES, PrivacyOverrides } from "../src/privacy/engine.js";
import { loadPrivacyState } from "../src/privacy/state.js";
import { readPinnedNote as gatewayPinned } from "../src/orient/globalNote.js";
import texKeys from "../../../packages/shared/src/texContract/texKeys.cjs";
import { readPinnedNote as texPinned, storeRules } from "../../../packages/tex/gateway/agent/pinnedNote.js";
import { overSearchSettings } from "../../../packages/tex/gateway/agent/searchOver.js";
import { searchSettingsOf } from "../src/search/settings.js";
import { prepareNoteImages } from "../src/notes/uploadedImages.js";
import uploads from "../../../packages/shared/src/texContract/uploadImages.cjs";

const ID = "0190f3a2-1b2c-7d3e-8f40-123456789abc";
const KEYS = [
  `tex/person:ws_1/notes/${ID}.md`,
  `tex/chat:abc/files/${ID}.png`,
  `tex/chat:abc/state/${"a".repeat(64)}.json`,
  `tex/person:abc/state/${"a".repeat(64)}.json`,
  `tex/other:abc/notes/${ID}.md`,
  `notes/${ID}.md`,
  `tex/person:ws_1/notes/${ID.replace("7d3e", "4d3e")}.md`,
  "tex/person:/notes/x.md",
  null,
];

test("Tex's key shapes agree with the privacy engine's, key by key", () => {
  for (const key of KEYS) {
    assert.equal(texKeys.isTexKey(key), engineTexKey(key), String(key));
    assert.equal(texKeys.isTexStateKey(key), engineStateKey(key), String(key));
  }
});

function storeWith(notes, rules) {
  return {
    async get(key) {
      if (key === "privacy.md") return rules === null ? null : { etag: "r1", [PRE_PARSED_RULES]: rules };
      return key in notes ? { text: async () => notes[key] } : null;
    },
  };
}

test("Tex reads the access rules a store carries exactly as the gateway does, and fails closed without them", async () => {
  const overrides = new PrivacyOverrides([["guides/held.md", "private"]]);
  const carried = storeWith({}, { rules: [{ prefix: "guides", vis: "team" }], overrides });
  const gateway = await loadPrivacyState(carried);
  const tex = await storeRules(carried);
  assert.equal(tex.rules, gateway.rules);
  assert.equal(tex.overrides, gateway.overrides);
  assert.ok((await storeRules(storeWith({}, null))).error);
  assert.ok((await loadPrivacyState(storeWith({}, null))).error);
});

test("a pinned note reads the same through Tex's door as through orient's, held-back and absent notes included", async () => {
  const rules = { rules: [{ prefix: "ai", vis: "team" }], overrides: new PrivacyOverrides([["ai/held.md", "private"]]) };
  const opened = { store: storeWith({ "ai/production/texting.md": "setup", "ai/held.md": "secret" }, rules), session: { scope: "team" } };
  const reach = { contexts: [{ name: "@context-lc" }], openPinned: async () => opened, here: null };
  for (const path of ["ai/production/texting.md", "ai/held.md", "ai/missing.md"]) {
    assert.equal(await texPinned(reach, path, (text) => text), await gatewayPinned(reach, path, (text) => text), path);
  }
  assert.equal(await texPinned(reach, "ai/production/texting.md", (text) => text), "setup");
  assert.equal(await texPinned(reach, "ai/held.md", (text) => text), null);
  assert.equal(await texPinned({ contexts: [], openPinned: reach.openPinned }, "ai/production/texting.md", (t) => t), null);
  const unruled = { contexts: reach.contexts, openPinned: async () => ({ ...opened, store: storeWith({ "ai/production/texting.md": "setup" }, null) }) };
  assert.equal(await texPinned(unruled, "ai/production/texting.md", (t) => t), null);
});

test("a setup's search settings laid over a store read back as the gateway's merge did", () => {
  for (const base of [undefined, { minScore: 0.5 }, { everywhere: false, snippetChars: 300 }]) {
    const over = { extraNotes: 2 };
    const store = { searchSettings: base };
    const expected = searchSettingsOf(store, over);
    assert.deepEqual(searchSettingsOf({ searchSettings: overSearchSettings(store, over) }), expected);
  }
});

test("a texted picture is named as write_note will store it", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const data = `data:image/png;base64,${png}`;
  const prepared = await prepareNoteImages("", [{ name: "picture", data }]);
  assert.deepEqual(await uploads.sentPictureLeaf(data), { leaf: prepared.images[0].leaf, bytes: prepared.images[0].bytes.byteLength });
  assert.equal(await uploads.sentPictureLeaf("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), null);
  assert.equal(await uploads.sentPictureLeaf("not base64!"), null);
});

test("Tex knows the gateway's refusal of a Tex key by its name, and nothing else as it", async () => {
  const { TexStoreUnavailable } = await import("../src/store/texRouting.js");
  assert.equal(texKeys.isTexStoreUnavailable(new TexStoreUnavailable("no binding")), true);
  assert.equal(texKeys.isTexStoreUnavailable(new Error("Tex's notes are not reachable here")), false);
  assert.equal(texKeys.isTexStoreUnavailable({ name: "TexStoreUnavailable" }), false);
});
