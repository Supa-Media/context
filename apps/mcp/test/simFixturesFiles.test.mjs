/**
 * The committed simulated-world fixtures (`bench/sets/sim/<conversation>.json`, `bench/simFixtures.mjs`) are well-formed
 * and safe to publish: each file is valid JSON whose `conversation` is the id of one of the repo's own Training or Dev
 * conversations (read from their `id` fields and nothing else; the sealed Test set is never read), every answer's key is
 * its call's `worldKey`, answers are sorted with no duplicates, and no file holds a credential or a real-looking address.
 * The directory may be missing or empty: the test then checks nothing and still passes.
 *
 * Sabotage: a fixture keyed by something other than `worldKey`, an unsorted or duplicated answer, a Test-set id, or a
 * token-shaped string in a file each fails these.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { FIXTURES_DIR, worldKey } from "../bench/simFixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETS = join(ROOT, "apps", "mcp", "bench", "sets");
const SIM = join(ROOT, FIXTURES_DIR);

/** Secret shapes no fixture may hold (a token, a key, a bearer header). */
const SECRET_PATTERNS = [/sk-ant-/, /ghp_/, /github_pat_/, /AKIA[0-9A-Z]{16}/, /xox[bp]-/, /Bearer [A-Za-z0-9._-]{20,}/];

/** Addresses a fixture may hold: only these example domains and suffixes, never a real one. */
const EXAMPLE_DOMAINS = ["example.com", "example.org", "example.net"];
const EXAMPLE_SUFFIXES = [".example", ".test", ".example.com", ".example.org", ".example.net"];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const jsonFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : []);

/** The ids of the repo's own Training and Dev conversations: their `id` fields, read from their files and nothing else. */
function repoConversationIds() {
  const ids = new Set();
  for (const set of ["training", "dev"]) {
    for (const name of jsonFiles(join(SETS, set))) {
      const conversation = JSON.parse(readFileSync(join(SETS, set, name), "utf8"));
      if (typeof conversation.id === "string") ids.add(conversation.id);
    }
  }
  return ids;
}

const isExampleAddress = (domain) => {
  const d = domain.toLowerCase();
  return EXAMPLE_DOMAINS.includes(d) || EXAMPLE_SUFFIXES.some((suffix) => d.endsWith(suffix));
};

/** Every problem a fixture file has, as text; an empty list is a well-formed file. */
function fixtureProblems(name, text, ids) {
  const problems = [];
  const id = name.replace(/\.json$/, "");
  let file;
  try {
    file = JSON.parse(text);
  } catch (error) {
    return [`${name}: not valid JSON (${error.message})`];
  }
  if (file === null || typeof file !== "object" || Array.isArray(file)) return [`${name}: not an object`];
  const extra = Object.keys(file).filter((k) => k !== "conversation" && k !== "answers");
  if (extra.length > 0) problems.push(`${name}: extra top-level keys ${extra.join(", ")}`);
  if (file.conversation !== id) problems.push(`${name}: conversation is ${JSON.stringify(file.conversation)}, not the file's id`);
  if (!ids.has(id)) problems.push(`${name}: ${id} is not a Training or Dev conversation`);
  if (!Array.isArray(file.answers)) problems.push(`${name}: answers is not a list`);
  const answers = Array.isArray(file.answers) ? file.answers : [];
  answers.forEach((entry, i) => {
    const where = `${name} answers[${i}]`;
    if (entry === null || typeof entry !== "object") return problems.push(`${where}: not an object`);
    if (typeof entry.key !== "string") problems.push(`${where}: key is not a string`);
    if (typeof entry.kind !== "string") problems.push(`${where}: kind is not a string`);
    if (entry.request === null || typeof entry.request !== "object" || Array.isArray(entry.request)) problems.push(`${where}: request is not an object`);
    if (!("answer" in entry)) problems.push(`${where}: no answer`);
    if (typeof entry.key === "string" && typeof entry.kind === "string" && entry.request && typeof entry.request === "object" && entry.key !== worldKey(entry.kind, entry.request)) {
      problems.push(`${where}: key is not the worldKey of its kind and request`);
    }
    if (i > 0 && typeof entry.key === "string" && typeof answers[i - 1]?.key === "string") {
      if (entry.key === answers[i - 1].key) problems.push(`${where}: duplicate key`);
      else if (entry.key < answers[i - 1].key) problems.push(`${where}: keys are not sorted`);
    }
  });
  for (const pattern of SECRET_PATTERNS) if (pattern.test(text)) problems.push(`${name}: matches a secret shape (${pattern})`);
  for (const [address] of text.matchAll(EMAIL)) {
    const domain = address.slice(address.lastIndexOf("@") + 1);
    if (!isExampleAddress(domain)) problems.push(`${name}: a real-looking address on ${domain}`);
  }
  return problems;
}

test("the committed simulated-world fixtures are well-formed, keyed by worldKey, of the repo's own conversations, and hold no secrets", () => {
  const ids = repoConversationIds();
  const problems = jsonFiles(SIM).flatMap((name) => fixtureProblems(name, readFileSync(join(SIM, name), "utf8"), ids));
  assert.deepEqual(problems, [], "every fixture file is well-formed");
});

test("a file of the wrong shape is reported, each problem by name", () => {
  const ids = new Set(["dev-one"]);
  const good = JSON.stringify({ conversation: "dev-one", answers: [{ key: worldKey("web search", { query: "a" }), kind: "web search", request: { query: "a" }, answer: { ok: true } }] });
  assert.deepEqual(fixtureProblems("dev-one.json", good, ids), []);
  assert.match(fixtureProblems("dev-one.json", "{", ids)[0], /not valid JSON/);
  assert.match(fixtureProblems("other.json", good, ids).join("\n"), /other.json: conversation is "dev-one", not the file's id/);
  assert.match(fixtureProblems("test-one.json", JSON.stringify({ conversation: "test-one", answers: [] }), ids).join("\n"), /not a Training or Dev conversation/);
  const badKey = JSON.stringify({ conversation: "dev-one", answers: [{ key: "x", kind: "web search", request: { query: "a" }, answer: 1 }] });
  assert.match(fixtureProblems("dev-one.json", badKey, ids).join("\n"), /not the worldKey/);
  const unsorted = JSON.stringify({ conversation: "dev-one", answers: ["b", "a"].map((q) => ({ key: worldKey("web search", { query: q }), kind: "web search", request: { query: q }, answer: 1 })) });
  assert.match(fixtureProblems("dev-one.json", unsorted, ids).join("\n"), /not sorted|worldKey/);
  const extra = JSON.stringify({ conversation: "dev-one", answers: [], note: "x" });
  assert.match(fixtureProblems("dev-one.json", extra, ids).join("\n"), /extra top-level keys note/);
  assert.match(fixtureProblems("dev-one.json", good.replace("ok", "sk-ant-api03-abcdefghijklmnop"), ids).join("\n"), /secret shape/);
  assert.match(fixtureProblems("dev-one.json", good.replace("ok", "ops@acme-corp.io"), ids).join("\n"), /real-looking address on acme-corp.io/);
  assert.deepEqual(fixtureProblems("dev-one.json", good.replace("ok", "ops@billing.example"), ids), [], "an example address is fine");
});
