/**
 * WHO MAY OPEN A SEALED SECRET, pinned rather than described.
 *
 * `seal.js` said the secret part was "opened only by `openForFill`" while a
 * second legitimate opener existed (the proxy step), and `vault.ts` said
 * `reveal`'s "only caller is `revealVaultEntry`" while `vaultMove.ts` was a
 * second. Both were true when written and neither was enforced by anything,
 * which is register row 762: a header that counts its callers is a guard with
 * an expiry date.
 *
 * So the count lives here instead. Adding a third opener is allowed — it just
 * has to be a deliberate edit of this list, by somebody who has read why the
 * other two are safe: the fill step types the value into the live page and
 * the proxy step adds it to an outgoing request, and neither returns it to a
 * model, a tool result, a log or a message.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const VAULT = join(dirname(fileURLToPath(import.meta.url)), "../src/vault");

/** The files that may open a sealed secret, and why each one is allowed to. */
const DOORS = {
  "fill.js": "types the value into the live page and returns it to nothing else",
  "proxy.js": "adds the value to one outgoing request and blanks it out of the answer",
  "entries.js": "defines readSecret itself",
};

test("only the fill step and the proxy step open a sealed secret", () => {
  const opens = readdirSync(VAULT)
    .filter((name) => name.endsWith(".js"))
    .filter((name) => /\breadSecret\b/.test(readFileSync(join(VAULT, name), "utf8")));
  assert.deepEqual(opens.sort(), Object.keys(DOORS).sort());
});

test("the secret read throws rather than answering null, so a caller cannot read it as empty", () => {
  const source = readFileSync(join(VAULT, "entries.js"), "utf8");
  const body = source.slice(source.indexOf("export async function readSecret"));
  assert.match(body.slice(0, body.indexOf("\n}\n")), /throw/);
});
