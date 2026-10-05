/**
 * Pure forward-record builder and URL comparison key (`src/graph/facts.js`,
 * `src/graph/urlKey.js`).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   encrypted-body check skipped in buildNodeRecord              1 (encrypted)
 *   links in code counted (masking bypassed)                     1 (code)
 *   userinfo check dropped in urlKey                             2 (urls, urlKey)
 *   secret query-name check dropped in urlKey                    2 (urls, urlKey)
 *   referenceSetVersion includes prose                           1 (prose)
 *   occurrences deduplicated instead of memberships              2 (duplicate, root escape)
 *   cap truncation reports complete coverage                     1 (over-cap)
 *   non-.md relative target given incoming/                      1 (non-.md)
 *   definition occurrences given memberships                     1 (definition)
 *   fragment parameters not checked in urlKey                    1 (urlKey)
 *   bare name membership dropped                                 2 (bare, duplicate)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildNodeRecord } from "../src/graph/facts.js";
import { nameHash, pathHash, urlHash } from "../src/graph/keys.js";
import { GRAPH_RECORD_BYTE_CAP, parseNode, serializeNode } from "../src/graph/records.js";
import { urlKey } from "../src/graph/urlKey.js";

const NOW = "2026-10-05T00:00:00.000Z";
const build = (path, body, version = "v1") => buildNodeRecord(path, body, version, { now: NOW });
const incoming = async (p) => `incoming:${await pathHash(p)}`;
const bare = async (n) => `bare:${await nameHash(n)}`;
const names = async (n) => `names:${await nameHash(n)}`;

const FROM = "1-projects/alpha/notes.md";

test("record shape round trips through parseNode and carries own name", async () => {
  const { record, memberships } = await build(FROM, "See [[./plan]].");
  assert.deepEqual(parseNode(serializeNode(record), FROM), record);
  assert.equal(record.coverage, "complete");
  assert.equal(record.observedSourceVersion, "v1");
  assert.equal(record.observedAt, NOW);
  assert.ok(memberships instanceof Set);
  assert.ok(memberships.has(await names("notes")));
  assert.ok(memberships.has(await incoming("1-projects/alpha/plan.md")));
});

test("prose edit leaves referenceSetVersion unchanged; adding a link changes it", async () => {
  const a = await build(FROM, "Hello [[./plan]] world.");
  const b = await build(FROM, "Entirely different prose around [[./plan]] here.", "v2");
  const c = await build(FROM, "Hello [[./plan]] and [[./other]].");
  assert.equal(a.record.referenceSetVersion, b.record.referenceSetVersion);
  assert.notEqual(a.record.referenceSetVersion, c.record.referenceSetVersion);
  assert.match(a.record.referenceSetVersion, /^[0-9a-f]{64}$/);
});

test("a link past 2,048 characters is a membership; links in code are not", async () => {
  const far = `${"x".repeat(2100)} [[./far]]`;
  const r = await build(FROM, far);
  assert.ok(r.memberships.has(await incoming("1-projects/alpha/far.md")));
  const code = await build(FROM, "`[[./a]]` and\n```\n[[./b]]\n```\n[[./c]]");
  assert.ok(!code.memberships.has(await incoming("1-projects/alpha/a.md")));
  assert.ok(!code.memberships.has(await incoming("1-projects/alpha/b.md")));
  assert.ok(code.memberships.has(await incoming("1-projects/alpha/c.md")));
  assert.equal(code.record.occurrences.length, 1);
});

test("reference definition is kept as an occurrence with no membership", async () => {
  const r = await build(FROM, "[ref]: ./plan.md\n\n[ext]: https://example.com/x");
  assert.equal(r.record.occurrences.filter((o) => o.kind === "definition").length, 2);
  assert.ok(!r.memberships.has(await incoming("1-projects/alpha/plan.md")));
  assert.deepEqual(r.record.externalReferences, []);
  assert.deepEqual([...r.memberships], [await names("notes")]);
});

test("root escape and anchor-only produce nothing", async () => {
  const r = await build("a.md", "[[../../outside]] [x](../../../o.md) [x](#g) [[#g]]");
  assert.deepEqual([...r.memberships], [await names("a")]);
  assert.equal(r.record.occurrences.length, 4);
});

test("bare name goes to bare/ and the written target is kept", async () => {
  const r = await build(FROM, "See [[Overview.md#Goals]] and [[plan]].");
  assert.ok(r.memberships.has(await bare("Overview")));
  assert.ok(r.memberships.has(await bare("plan")));
  assert.ok(!r.memberships.has(await incoming("Overview.md")));
  assert.ok(r.record.occurrences.some((o) => o.target === "Overview.md#Goals" && o.style === "bare"));
});

test("non-.md relative target is excluded from incoming/ (OPEN-5)", async () => {
  const r = await build(FROM, "![pic](./pic.png) [[./doc.pdf]] [[./plan]]");
  assert.ok(!r.memberships.has(await incoming("1-projects/alpha/pic.png")));
  assert.ok(!r.memberships.has(await incoming("1-projects/alpha/doc.pdf")));
  assert.ok(r.memberships.has(await incoming("1-projects/alpha/plan.md")));
  assert.equal(r.record.occurrences.length, 3);
});

test("duplicate links are one membership and two occurrences", async () => {
  const r = await build(FROM, "[[./plan]] again [x](./plan.md#g) and [[plan]] [[plan]]");
  const plan = await incoming("1-projects/alpha/plan.md");
  assert.equal([...r.memberships].filter((m) => m === plan).length, 1);
  assert.equal(r.record.occurrences.length, 4);
  assert.equal([...r.memberships].filter((m) => m.startsWith("bare:")).length, 1);
});

test("encrypted body is excluded with no memberships at all", async () => {
  const body = "---\ncontext_encryption: v1\n---\n[[./plan]] https://example.com/x";
  const r = await build(FROM, body);
  assert.equal(r.record.coverage, "excluded");
  assert.deepEqual(r.record.occurrences, []);
  assert.deepEqual(r.record.externalReferences, []);
  assert.equal(r.memberships.size, 0);
  assert.deepEqual(parseNode(serializeNode(r.record), FROM), r.record);
});

test("urls/: http and https externals via urlKey; excluded keys contribute nothing", async () => {
  const body = "[a](https://Example.COM:443/Path?b=2&a=1#F) [b](https://u:pw@host.test/) [c](mailto:me@example.com) [d](https://x.test/?token=zz)";
  const r = await build("a.md", body);
  const k = urlKey("https://example.com/Path?b=2&a=1#F");
  assert.ok(r.memberships.has(`urls:${await urlHash(k.key)}`));
  assert.equal([...r.memberships].filter((m) => m.startsWith("urls:")).length, 1);
  assert.equal(r.record.externalReferences.length, 1);
  assert.equal(r.record.externalReferences[0].key, k.key);
  assert.equal(r.record.externalReferences[0].version, k.version);
  assert.equal(r.record.occurrences.length, 4);
});

test("over-cap record is partial, fits the cap, keeps document order, memberships stay full", async () => {
  const count = 6000;
  const body = Array.from({ length: count }, (_, i) => `[[./n${i}]]`).join(" ");
  const r = await build(FROM, body);
  assert.equal(r.record.coverage, "partial");
  const text = serializeNode(r.record);
  assert.ok(new TextEncoder().encode(text).length <= GRAPH_RECORD_BYTE_CAP);
  assert.ok(parseNode(text, FROM));
  assert.ok(r.record.occurrences.length > 0 && r.record.occurrences.length < count);
  r.record.occurrences.forEach((o, i) => assert.equal(o.target, `./n${i}`));
  assert.equal([...r.memberships].filter((m) => m.startsWith("incoming:")).length, count);
});

test("urlKey rules", () => {
  assert.deepEqual(urlKey("https://Example.COM:443/A/b?z=1&a=2#Frag"), {
    key: "https://example.com/A/b?z=1&a=2#Frag",
    version: urlKey("https://x.test/").version,
  });
  assert.equal(urlKey("http://example.com:80/x").key, "http://example.com/x");
  assert.equal(urlKey("https://example.com:8443/x").key, "https://example.com:8443/x");
  assert.notEqual(urlKey("http://example.com/").key, urlKey("https://example.com/").key);
  assert.equal(typeof urlKey("https://x.test/").version, "number");
  assert.equal(urlKey("https://user:pw@host.test/"), null);
  assert.equal(urlKey("https://user@host.test/"), null);
  assert.equal(urlKey("https://x.test/?token=abc"), null);
  assert.equal(urlKey("https://x.test/?a=1&X-Amz-Signature=abc"), null);
  assert.equal(urlKey("https://x.test/?Access_Token=abc"), null);
  assert.equal(urlKey("https://x.test/?sig=abc"), null);
  assert.equal(urlKey("https://x.test/?key=abc"), null);
  assert.ok(urlKey("https://x.test/?keyword=abc"));
  assert.equal(urlKey("mailto:a@b.test"), null);
  assert.equal(urlKey("not a url"), null);
  assert.equal(urlKey("//cdn.test/x"), null);
});

test("urlKey: secrets in the fragment and extra signed-URL markers are excluded", () => {
  assert.equal(urlKey("https://e.test/#access_token=abc"), null);
  assert.equal(urlKey("https://e.test/#state=x&ID_TOKEN=abc"), null);
  assert.equal(urlKey("https://e.test/?X-Goog-Signature=abc"), null);
  assert.equal(urlKey("https://e.test/?Policy=abc&Key-Pair-Id=K"), null);
  assert.equal(urlKey("https://e.test/?jwt=abc"), null);
  assert.equal(urlKey("https://e.test/#section-2").key, "https://e.test/#section-2");
  assert.ok(urlKey("https://e.test/?code=python"));
});

test("a single occurrence over the cap yields partial, zero occurrences, full memberships", async () => {
  const r = await build(FROM, `[x](./${"a".repeat(GRAPH_RECORD_BYTE_CAP + 10)}.md)`);
  assert.equal(r.record.coverage, "partial");
  assert.equal(r.record.occurrences.length, 0);
  assert.equal(r.memberships.size, 2);
  assert.deepEqual(parseNode(serializeNode(r.record), FROM), r.record);
});
