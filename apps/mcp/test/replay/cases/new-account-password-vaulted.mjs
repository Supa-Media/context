import assert from "node:assert/strict";

import { webSession } from "../../../src/agent/computer.js";
import { BROWSE_TOOL } from "../../../src/agent/browse.js";
import { listMeta } from "../../../src/vault/entries.js";
import { openForFill } from "../../../src/vault/fill.js";

const PAGE = "https://www.tidepool-forum.example/join";
const KEYS = { current: "k1", keys: { k1: Buffer.from(new Uint8Array(32).fill(3)).toString("base64") } };

/** The person's own vault, every write and fill logged in one order. */
function vault(log) {
  const objects = new Map();
  const store = {
    async get(key) {
      return objects.has(key) ? { text: async () => objects.get(key) } : null;
    },
    async put(key, value) {
      log.push("vault write");
      objects.set(key, String(value));
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
  Object.defineProperty(store, "encryptionKey", { value: KEYS, enumerable: false });
  store.actor = { workspaceId: "ws_maya", userId: "user_maya", workspaceKind: "personal", role: "owner" };
  return store;
}

/** Tex's own browser on a sign-up form: email, password, repeat password. */
function signUpBrowser(log) {
  const typed = {};
  const kinds = { 1: "username", 2: "password", 3: "password" };
  return {
    typed,
    async browse(_session, steps) {
      const ran = steps.map((step) => {
        if (step.do !== "fill") return { do: step.do, ok: true };
        if (step.origin !== new URL(PAGE).origin || kinds[step.ref] !== step.field) return { do: "fill", ok: false, reason: "wrong box" };
        log.push(`fill ${step.ref}`);
        typed[step.ref] = step.value;
        return { do: "fill", ok: true };
      });
      return {
        session: "bb-1",
        ran,
        page: {
          url: PAGE,
          title: "Join",
          text: "Create your account",
          elements: [
            { ref: 1, kind: "input email", label: "Email" },
            { ref: 2, kind: "input password", label: "Password" },
            { ref: 3, kind: "input password", label: "Repeat password" },
            { ref: 4, kind: "button", label: "Create account" },
          ],
        },
      };
    },
    async closeBrowser() {},
  };
}

export default {
  id: "new-account-password-vaulted",
  incident:
    "2026-11-18: a background job signing the person up for a new forum account stopped and sent a vault link, because Tex had no way to make a login for an account that didn't exist yet.",
  cause: "The vault only held logins a person saved; nothing could make a password and keep it without the model holding it.",
  path: "1:1 text or background job, Tex's own browser",
  async run() {
    const log = [];
    const store = vault(log);
    const browser = signUpBrowser(log);
    const web = webSession(browser, `sign me up at ${PAGE}`, { store });
    assert.ok(web.tools.some((tool) => tool.name === "make_login"), "a turn with a browser and a vault can make a new login");
    await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: PAGE }] });

    const made = await web.call("make_login", { username: "maya@example.test", username_ref: 1, password_ref: 2, confirm_ref: 3, name: "Tidepool forum" });
    assert.notEqual(made.isError, true, made.content[0].text);
    assert.deepEqual(log, ["vault write", "fill 1", "fill 2", "fill 3"], "the login is in the vault before any box is typed");

    const [entry] = await listMeta(store, KEYS, "ws_maya");
    const saved = await openForFill(store, undefined, { entryId: entry.id, origin: new URL(PAGE).origin });
    assert.equal(browser.typed[2], saved.password, "what was typed is what was saved");
    assert.equal(browser.typed[3], saved.password);
    assert.ok(saved.password.length >= 12);
    assert.ok(!JSON.stringify(made).includes(saved.password), "the model never sees the password");
    assert.match(made.content[0].text, new RegExp(entry.id));

    // An account they already have keeps the old path: no second password, sign in with the saved login.
    const again = webSession(signUpBrowser([]), `sign me up at ${PAGE}`, { store });
    await again.call(BROWSE_TOOL, { steps: [{ do: "goto", url: PAGE }] });
    const refused = await again.call("make_login", { username: "maya@example.test", password_ref: 2 });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /fill_login/);
    assert.equal((await listMeta(store, KEYS, "ws_maya")).length, 1);
  },
};
