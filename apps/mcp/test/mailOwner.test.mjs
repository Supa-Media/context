// Whose agent wrote a line (Dev, 2026-11-26: mail from Claude should show the Claude logo and whose Claude it is).
// The gateway signs a line's app with the sender's `@handle` (`tools/notes/mail.js` `appFor`), and the app reads it
// back apart (`splitApp`). Sabotage, confirmed: `appWithOwner` returning the app alone → the first case fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import mail from "../../../packages/shared/src/mail.cjs";

const { appWithOwner, splitApp, appendMail, parseMail } = mail;

test("an app is signed with the person whose it is, and read back apart", () => {
  assert.equal(appWithOwner("Claude Code", "@seyi"), "Claude Code · @seyi");
  assert.deepEqual(splitApp("Claude Code · @seyi"), { app: "Claude Code", owner: "@seyi" });
  assert.deepEqual(splitApp("Claude"), { app: "Claude", owner: null });
  assert.deepEqual(splitApp(null), { app: null, owner: null });
});

test("a long app is cut short so the person always fits", () => {
  const signed = appWithOwner("A very long client name that goes on and on", "@someone");
  assert.ok(signed.length <= 40, signed);
  assert.equal(splitApp(signed).owner, "@someone");
});

test("no person, or not a handle: the app alone, as before", () => {
  assert.equal(appWithOwner("Codex", null), "Codex");
  assert.equal(appWithOwner("Codex", "seyi"), "Codex");
  assert.equal(appWithOwner("", "@seyi"), null);
});

test("the owner is signed into the line and survives a parse", () => {
  const text = "# Plan\n\n```mail\n```\n";
  const result = appendMail(text, { from: "builder", app: appWithOwner("Claude Code", "@seyi"), kind: "mail", to: "everyone", text: "hi", at: "2026-11-26T18:00:00.000Z" });
  assert.equal(result.error, undefined);
  let out = text;
  for (const change of [...result.changes].sort((a, b) => b.from - a.from)) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  assert.match(out, /builder \(Claude Code · @seyi\) to everyone: hi/);
  const [event] = parseMail(out).events;
  assert.deepEqual(splitApp(event.app), { app: "Claude Code", owner: "@seyi" });
});
