/**
 * Where "what Tex is working on" points (`src/agent/hubLinks.js`): the
 * signed-in Tex hub, a person's by their own handle off the grant and a
 * group's by its home's words, never anything taken from the request.
 *
 * Sabotage record (applied, suite run, named check observed failing, reverted):
 *   `groupHubUrl` dropping the words pattern → "a home folder's words, and nothing else" fails.
 *   `personHubUrl` reading any workspace's slug → "the person's own handle, never a workspace they were invited into" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { chatHubUrl, groupHubUrl, personHubUrl } from "../src/agent/hubLinks.js";

const ENV = { APP_ORIGIN: "https://context.lc/" };
const SEYI = { workspaces: [{ kind: "shared", role: "owner", slug: "supa" }, { kind: "personal", role: "owner", slug: "seyi" }] };

test("the person's own handle, never a workspace they were invited into", () => {
  assert.equal(personHubUrl(ENV, SEYI), "https://context.lc/tex/@seyi");
  assert.equal(personHubUrl(ENV, { workspaces: [{ kind: "personal", role: "editor", slug: "bola" }] }), null);
  assert.equal(personHubUrl(ENV, { workspaces: [] }), null);
  assert.equal(personHubUrl({}, SEYI), null, "no https origin, no link");
});

test("a home folder's words, and nothing else", () => {
  assert.equal(groupHubUrl(ENV, "tex/groups/brave-otter-lamp"), "https://context.lc/tex/group/brave-otter-lamp");
  assert.equal(groupHubUrl(ENV, "tex/groups/brave-otter-lamp/"), "https://context.lc/tex/group/brave-otter-lamp");
  for (const folder of ["tex/groups/../x", "tex/groups/Brave-Otter", "tex/groups/one", "tex/groups/a-b/c", "notes/a-b", "", null, undefined]) {
    assert.equal(groupHubUrl(ENV, folder), null, String(folder));
  }
});

test("a group turn points at its group's page, never the person's, and one without a home at none", () => {
  assert.equal(chatHubUrl(ENV, SEYI, null), "https://context.lc/tex/@seyi");
  assert.equal(chatHubUrl(ENV, SEYI, { home: { folder: "tex/groups/brave-otter-lamp" } }), "https://context.lc/tex/group/brave-otter-lamp");
  assert.equal(chatHubUrl(ENV, SEYI, { home: null }), null);
  assert.equal(chatHubUrl(ENV, SEYI, {}), null);
});
