/**
 * The browser origins the deployed gateways accept, read from wrangler.toml.
 *
 * The console is served at context.lc and, since the Tex launch, at tex.lc
 * too: the same app, which opens a note over `/collaboration`. A console origin
 * missing here is refused with a 403 before any token is read, so notes flicker
 * and never open on that host (2026-10-20). Each listed origin is exact; a
 * wildcard would be inert (`origin.js`), and the test says so.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { allowedOrigins, originIsAllowed } from "../src/origin.js";

const TOML = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

/** `ALLOWED_ORIGINS` in the named table: `""` for the top level, else e.g. `env.staging.vars`. */
function allowedIn(table) {
  let current = "";
  for (const line of TOML.split("\n")) {
    const header = /^\s*\[{1,2}([^\]]+)\]{1,2}\s*$/.exec(line);
    if (header) current = header[1].trim();
    const value = /^\s*ALLOWED_ORIGINS\s*=\s*"([^"]*)"/.exec(line);
    if (value && current === table) return value[1];
  }
  throw new Error(`no ALLOWED_ORIGINS in [${table || "top level"}]`);
}

const DEPLOYMENTS = [
  { name: "production", table: "vars", consoles: ["https://context.lc", "https://tex.lc"] },
  { name: "staging", table: "env.staging.vars", consoles: ["https://staging.context.lc", "https://tex-staging.context.lc"] },
];

for (const { name, table, consoles } of DEPLOYMENTS) {
  test(`${name}: every console origin may open a note`, () => {
    const allowed = allowedOrigins({ ALLOWED_ORIGINS: allowedIn(table) });
    for (const origin of consoles) assert.ok(originIsAllowed(origin, allowed), `${origin} must be allowed on ${name}`);
  });

  test(`${name}: nothing beyond its console origins, and no wildcard`, () => {
    const allowed = allowedOrigins({ ALLOWED_ORIGINS: allowedIn(table) });
    assert.deepEqual([...allowed].sort(), [...consoles].sort());
    assert.ok(!allowedIn(table).includes("*"));
    for (const origin of ["https://www.tex.lc", "https://tex.lc.evil.example", "http://tex.lc", "https://evil.tex.lc"]) {
      assert.ok(!originIsAllowed(origin, allowed), `${origin} must be refused on ${name}`);
    }
  });
}

test("the other deployment's console is refused", () => {
  const production = allowedOrigins({ ALLOWED_ORIGINS: allowedIn("vars") });
  const staging = allowedOrigins({ ALLOWED_ORIGINS: allowedIn("env.staging.vars") });
  assert.ok(!originIsAllowed("https://tex-staging.context.lc", production));
  assert.ok(!originIsAllowed("https://tex.lc", staging));
});
