/**
 * HOUSEKEEPING MOVES MANY NOTES BY NAME, AND SAYS WHAT REALLY HAPPENED (2026-10-26).
 *
 * @seyi's 9:03 run changed nothing: it wrote 100 moves out by hand, sent them
 * as a dry run (a keyed workspace's applied batch asked for every note's
 * version), the dry run read every note's body one after another and was cut
 * at 60 s, and the run's clock was gone. Its log then called the move a dry
 * run while its own thinking said it skipped one, and the cut-off arguments
 * could not show which.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-26).
 *
 *  1. `moveMatching` not filtering by folder (nested notes match too).
 *     → "move_notes by name moves only the notes directly in the folder…" fails.
 *  2. The etag fallback removed from `moveMatching`.
 *     → "a batch that asks for versions is planned first…" fails.
 *  3. `planKeyedBatchMove` not wired in `toolMoveNotes` (the old preflight).
 *     → "a keyed dry run plans from each row's version…" fails (bodies read).
 *  4. `inLanes` taking one item at a time.
 *     → "a keyed batch looks its notes up several at a time" fails.
 *  5. `argsLine` without the long-list cut.
 *     → "a long batch's line still shows dry_run" fails.
 *  6. `housekeepingEntry` ignoring `running`.
 *     → "the log says a change still running…" fails.
 *  7. stopping at a batch the control plane could not start, rather than halving it.
 *     → "a batch the control plane could not start goes again in halves…" fails.
 *  8. planning each batch as it goes (`PLAN_BATCH` at the batch size).
 *     → "once a batch asks for versions, the notes are planned a hundred at a time…" fails.
 *  9. `leftHint` keyed on the stem before the first digit (500s and 600s one family).
 *     → "a move by name names the families still loose…" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { housekeepingCallTool, housekeepingTools, namePattern } from "../src/agent/housekeepingGuard.js";
import { housekeepingEntry } from "../src/agent/housekeeping.js";
import { argsLine } from "../src/agent/transcript.js";
import { toolMoveNotes } from "../src/tools/moves/notes.js";
import { withServedTree } from "./servedTree.mjs";

const FOLDER = "2-areas/apps/context";

/** A session dispatcher over a listing, recording every call. `move_notes` answers as `answer` says. */
function sessionOver(paths, answer = () => ({ content: [{ type: "text", text: "moved" }] })) {
  const calls = [];
  const dispatch = async (name, args) => {
    calls.push({ name, args });
    if (name === "list_notes") {
      const listed = paths.filter((path) => path.startsWith(args.prefix));
      return { content: [{ type: "text", text: listed.map((path) => `${path} (10 bytes)`).join("\n") }] };
    }
    if (name === "move_notes") return answer(args);
    return { content: [{ type: "text", text: "ok" }] };
  };
  return { calls, dispatch, moves: () => calls.filter((call) => call.name === "move_notes") };
}

const coverage = (i) => `${FOLDER}/security-review-log-coverage-2026-09-${String(i).padStart(3, "0")}.md`;
const PATHS = [
  ...Array.from({ length: 230 }, (_, i) => coverage(i)),
  `${FOLDER}/about.md`,
  `${FOLDER}/security-review-log-0001.md`,
  `${FOLDER}/old/security-review-log-coverage-2026-08-01.md`,
  "2-areas/apps/context-other/security-review-log-coverage-2026-09-01.md",
];

test("the pattern is a whole-name match: * any run, ? one character, no folders", () => {
  assert.ok(namePattern("security-review-log-coverage-*").test("security-review-log-coverage-2026-09-18b.md"));
  assert.ok(!namePattern("security-review-log-coverage-*").test("security-review-log-0001.md"));
  assert.ok(namePattern("a.b?md").test("a.bxmd") && !namePattern("a.b?md").test("aXbxmd"));
  assert.equal(namePattern("x/*"), null);
  assert.equal(namePattern(""), null);
});

test("the pattern takes sets and alternatives, so a quarter of dated notes is one pattern", () => {
  const quarter = namePattern("run-log-2026-{01,02,03}-*");
  assert.ok(quarter.test("run-log-2026-02-14-17.md") && !quarter.test("run-log-2026-04-01-30.md"));
  assert.ok(namePattern("run-log-2026-0[1-3]-*").test("run-log-2026-03-31.md"));
  assert.ok(!namePattern("run-log-2026-0[!1-3]-*").test("run-log-2026-03-31.md"));
  assert.ok(namePattern("a(b)+c.md").test("a(b)+c.md"), "regex characters outside a set or alternative are literal");
  assert.equal(namePattern("run-{01,02"), null);
  assert.equal(namePattern("run-[01"), null);
});

test("a bare into is a subfolder of the folder the notes are in", async () => {
  const session = sessionOver(PATHS.slice(0, 3));
  const guard = housekeepingCallTool(session.dispatch);

  const result = await guard.callTool("move_notes", { folder: FOLDER, match: "*", into: "coverage" });

  assert.notEqual(result.isError, true, result.content[0].text);
  assert.ok(session.moves()[0].args.moves.every((move) => move.destination.startsWith(`${FOLDER}/coverage/`)));
});

test("move_notes by name moves only the notes directly in the folder whose names match, 50 a batch, each logged", async () => {
  const session = sessionOver(PATHS);
  const guard = housekeepingCallTool(session.dispatch);
  const into = `${FOLDER}/security-review-coverage`;

  const result = await guard.callTool("move_notes", { folder: FOLDER, match: "security-review-log-coverage-*", into });

  assert.notEqual(result.isError, true, result.content[0].text);
  assert.match(result.content[0].text, /moved 230 notes/);
  assert.deepEqual(session.moves().map((call) => call.args.moves.length), [50, 50, 50, 50, 30]);
  const sources = session.moves().flatMap((call) => call.args.moves.map((move) => move.source));
  assert.deepEqual(sources, Array.from({ length: 230 }, (_, i) => coverage(i)));
  assert.ok(session.moves().every((call) => call.args.moves.every((move) => move.destination === `${into}/${move.source.split("/").pop()}`)));
  assert.equal(guard.changes.length, 230);
});

test("a long move by name starts no batch the slowest so far would not finish in time, says what moved, and the same call carries on", async () => {
  const session = sessionOver(PATHS);
  let clock = 0;
  const slow = async (name, args) => {
    const result = await session.dispatch(name, args);
    if (name === "move_notes") clock += 20_000;
    return result;
  };
  const guard = housekeepingCallTool(slow, [], { now: () => clock, matchBudgetMs: 55_000 });

  // 20 s a batch: a third would end at 60 s, past the 55 s budget, so two go.
  const first = await guard.callTool("move_notes", { folder: FOLDER, match: "security-review-log-coverage-*", into: `${FOLDER}/c` });
  assert.notEqual(first.isError, true);
  assert.match(first.content[0].text, /^moved 100 of 230 notes .* the other 130 are still in .* Send the same move again/);
  assert.deepEqual(session.moves().map((call) => call.args.moves.length), [50, 50]);
});

test("a batch the control plane could not start goes again in halves, and the rest at the size that moved", async () => {
  const unstarted = { isError: true, content: [{ type: "text", text: "could not start the moves right now; try again in a moment" }] };
  const session = sessionOver(PATHS, (args) => (args.moves.length > 7 ? unstarted : { content: [{ type: "text", text: "moved" }] }));
  const guard = housekeepingCallTool(session.dispatch);

  const result = await guard.callTool("move_notes", { folder: FOLDER, match: "security-review-log-coverage-*", into: `${FOLDER}/c` });

  assert.notEqual(result.isError, true, result.content[0].text);
  assert.match(result.content[0].text, /moved 230 notes/);
  assert.deepEqual(session.moves().map((call) => call.args.moves.length), [50, 25, 13, ...Array(32).fill(7), 6]);
  assert.equal(guard.changes.length, 230);

  const never = sessionOver(PATHS, () => unstarted);
  const stopped = await housekeepingCallTool(never.dispatch).callTool("move_notes", { folder: FOLDER, match: "security-review-log-coverage-*", into: `${FOLDER}/c` });
  assert.equal(stopped.isError, true);
  assert.match(stopped.content[0].text, /^moved 0 of 230 notes .* then stopped: could not start the moves/);
  assert.deepEqual(never.moves().map((call) => call.args.moves.length), [50, 25, 13, 7, 5]);
});

test("a batch that asks for versions is planned first and sent again with the versions its plan names", async () => {
  const session = sessionOver(PATHS.slice(0, 3), (args) => {
    if (args.dry_run === true) {
      return { content: [{ type: "text", text: `preflight ok: ${args.moves.length} moves\n` + args.moves.map((move, i) => `- ${move.source} (etag v${i}) → ${move.destination} [team]`).join("\n") }] };
    }
    if (args.moves.some((move) => !move.expected_source_etag)) {
      return { isError: true, content: [{ type: "text", text: "expected_source_etag is required for every applied batch move." }] };
    }
    return { content: [{ type: "text", text: "moved" }] };
  });
  const guard = housekeepingCallTool(session.dispatch);

  const result = await guard.callTool("move_notes", { folder: FOLDER, match: "*", into: `${FOLDER}/coverage` });

  assert.notEqual(result.isError, true, result.content[0].text);
  assert.deepEqual(session.moves().map((call) => call.args.dry_run === true), [false, true, false]);
  assert.deepEqual(session.moves()[2].args.moves.map((move) => move.expected_source_etag), ["v0", "v1", "v2"]);
  assert.equal(guard.changes.length, 3);
  assert.equal(guard.dryRuns, 1);
});

test("once a batch asks for versions, the notes are planned a hundred at a time and every later batch carries them", async () => {
  const session = sessionOver(PATHS, (args) => {
    if (args.dry_run === true) {
      return { content: [{ type: "text", text: `preflight ok: ${args.moves.length} moves\n` + args.moves.map((move) => `- ${move.source} (etag v-${move.source.split("/").pop()}) → ${move.destination} [team]`).join("\n") }] };
    }
    if (args.moves.some((move) => move.expected_source_etag !== `v-${move.source.split("/").pop()}`)) {
      return { isError: true, content: [{ type: "text", text: "expected_source_etag is required for every applied batch move." }] };
    }
    return { content: [{ type: "text", text: "moved" }] };
  });
  const guard = housekeepingCallTool(session.dispatch);

  const result = await guard.callTool("move_notes", { folder: FOLDER, match: "security-review-log-coverage-*", into: `${FOLDER}/c` });

  assert.notEqual(result.isError, true, result.content[0].text);
  assert.match(result.content[0].text, /moved 230 notes/);
  // One bare batch asks, then three plans of up to 100 between five applied batches: not a plan and a resend for each.
  assert.deepEqual(
    session.moves().map((call) => `${call.args.dry_run === true ? "plan" : "move"} ${call.args.moves.length}`),
    ["move 50", "plan 100", "move 50", "move 50", "plan 100", "move 50", "move 50", "plan 30", "move 30"],
  );
  assert.equal(guard.changes.length, 230);
  assert.equal(guard.dryRuns, 3);
});

test("a dry run by name moves nothing and says so; a protected folder, a bad pattern or the same folder is refused", async () => {
  const session = sessionOver([...PATHS, "tex/housekeeping/2026-10-26.md"]);
  const guard = housekeepingCallTool(session.dispatch);

  const dry = await guard.callTool("move_notes", { folder: FOLDER, match: "security-review-log-coverage-*", into: `${FOLDER}/c`, dry_run: true });
  assert.match(dry.content[0].text, /^dry run, nothing moved: 230 notes match/);
  assert.deepEqual(session.moves(), []);

  const refused = await Promise.all([
    guard.callTool("move_notes", { folder: "tex/housekeeping", match: "*", into: "2-areas/h" }),
    guard.callTool("move_notes", { folder: FOLDER, match: "*", into: "tex/x" }),
    guard.callTool("move_notes", { folder: FOLDER, match: "a/*", into: `${FOLDER}/c` }),
    guard.callTool("move_notes", { folder: FOLDER, match: "*", into: FOLDER }),
    guard.callTool("move_notes", { folder: FOLDER, match: "*", into: `${FOLDER}/c`, context: "@other" }),
    guard.callTool("move_notes", { folder: FOLDER, match: "nothing-like-this-*", into: `${FOLDER}/c` }),
  ]);
  assert.ok(refused.every((result) => result.isError === true));
  assert.deepEqual(session.moves(), []);
  assert.equal(guard.changes.length, 0);
});

test("housekeeping's move_notes offers folder, match and into beside the written-out batch", () => {
  const [tool] = housekeepingTools([{ name: "move_notes", description: "Move.", inputSchema: { type: "object", properties: { moves: {}, dry_run: {} }, required: ["moves"] } }]);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["moves", "dry_run", "folder", "match", "into"]);
  assert.deepEqual(tool.inputSchema.required, []);
});

test("the log says a change still running when the run ended, and a dry run, from what the gateway saw", async () => {
  let release;
  const session = sessionOver(PATHS.slice(0, 1), () => new Promise((resolve) => (release = resolve)));
  const guard = housekeepingCallTool(session.dispatch);
  const pending = guard.callTool("move_notes", { moves: [{ source: coverage(0), destination: `${FOLDER}/c/a.md`, expected_source_etag: "e" }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(guard.running, 1);

  const entry = housekeepingEntry({ now: 0, timeZone: "UTC", model: null, changes: [], before: 65, after: 65, why: "", events: [], dryRuns: 1, running: guard.running });
  assert.match(entry, /_Nothing changed\._/);
  assert.match(entry, /One change was still running when this run ended/);
  assert.match(entry, /One dry run, which moved nothing/);

  release({ content: [{ type: "text", text: "moved" }] });
  await pending;
  assert.equal(guard.running, 0);
  assert.equal(guard.changes.length, 1);
});

test("a long batch's line still shows dry_run", () => {
  const moves = Array.from({ length: 100 }, (_, i) => ({ source: `${FOLDER}/a-${i}-${"x".repeat(60)}.md`, destination: `${FOLDER}/c/a-${i}.md` }));
  const line = argsLine({ moves, dry_run: true });
  assert.match(line, /"dry_run":true/);
  assert.match(line, /98 more/);
});

/** A keyed store whose every lookup is counted: bodies read, and lookups in flight at once. */
function keyedStore(files) {
  const objects = new Map(Object.entries(files));
  const seen = { gets: 0, inFlight: 0, most: 0, batches: [] };
  const slow = async (value) => {
    seen.inFlight += 1;
    seen.most = Math.max(seen.most, seen.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    seen.inFlight -= 1;
    return value;
  };
  const store = {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    async head(key) {
      const value = objects.get(key);
      return slow(value === undefined ? null : { etag: value.etag, size: value.body.length });
    },
    async get(key) {
      seen.gets += 1;
      const value = objects.get(key);
      return value ? { etag: value.etag, httpMetadata: {}, text: async () => value.body, arrayBuffer: async () => new TextEncoder().encode(value.body).buffer } : null;
    },
    async put() {
      return { etag: "new" };
    },
    async delete() {},
    async list({ prefix = "" } = {}) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().map((key) => ({ key })), truncated: false };
    },
  };
  const served = withServedTree(store);
  served.keyedLayout = true;
  served.startMoveBatch = async (moves) => {
    seen.batches.push(moves);
    return { ok: true, moves: moves.map(({ from, to }) => ({ from, to })) };
  };
  return { store: served, seen };
}

const FORTY = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`1-projects/n${i}.md`, { body: `# N${i}\n`, etag: `e${i}` }]));
const FORTY_MOVES = Object.keys(FORTY).map((source) => ({ source, destination: source.replace("1-projects/", "2-areas/") }));

test("a keyed dry run plans from each row's version, reads no note's body, and asks the control plane nothing", async () => {
  const { store, seen } = keyedStore(FORTY);

  const plan = await toolMoveNotes(store, "private", [], new Map(), FORTY_MOVES, true);

  assert.match(plan.content[0].text, /^preflight ok: 40 moves/);
  assert.match(plan.content[0].text, /- 1-projects\/n7\.md \(etag e7\) → 2-areas\/n7\.md \[private\]/);
  assert.equal(seen.gets, 0);
  assert.deepEqual(seen.batches, []);

  const taken = keyedStore({ ...FORTY, "2-areas/n3.md": { body: "x", etag: "z" } });
  const refused = await toolMoveNotes(taken.store, "private", [], new Map(), FORTY_MOVES, true);
  assert.match(refused.content[0].text, /^conflict: destination already exists: 2-areas\/n3\.md/);
});

test("a keyed batch looks its notes up several at a time, and still moves them in one call", async () => {
  const { store, seen } = keyedStore(FORTY);
  const versioned = FORTY_MOVES.map((move, i) => ({ ...move, expected_source_etag: `e${i}` }));

  const moved = await toolMoveNotes(store, "private", [], new Map(), versioned, false);

  assert.match(moved.content[0].text, /^moved notes: 40/);
  assert.equal(seen.batches.length, 1);
  assert.ok(seen.most > 1, `lookups in flight at once: ${seen.most}`);
});

test("a move by name names the families still loose in the folder, so the next call takes a whole one", async () => {
  const loose = [
    ...Array.from({ length: 12 }, (_, i) => `${FOLDER}/log-${581 + i}.md`),
    ...Array.from({ length: 6 }, (_, i) => `${FOLDER}/log-${613 + i}.md`),
    ...Array.from({ length: 19 }, (_, i) => `${FOLDER}/passes-2026-09-${21 + (i % 4)}${"abcde"[i % 5]}-${i}.md`),
    `${FOLDER}/readme-notes.md`,
    `${FOLDER}/x1.md`,
    `${FOLDER}/x2.md`,
  ];
  const session = sessionOver([...PATHS, ...loose]);
  const guard = housekeepingCallTool(session.dispatch);

  const result = await guard.callTool("move_notes", { folder: FOLDER, match: "security-review-log-coverage-*", into: `${FOLDER}/c` });
  const text = result.content[0].text;
  assert.match(text, /moved 230 notes/);
  assert.match(text, /41 other notes are still directly in 2-areas\/apps\/context\//);
  assert.match(text, /passes-2\* \(19\), log-5\* \(12\), log-6\* \(6\)/);
  assert.doesNotMatch(text, /x\*|readme/, "a family under three, or a name with no number, is not named");
  assert.equal(guard.changes.length, 230, "nothing outside the pattern moves");

  const dry = await guard.callTool("move_notes", { folder: FOLDER, match: "log-5*", into: `${FOLDER}/500s`, dry_run: true });
  assert.match(dry.content[0].text, /passes-2\* \(19\)/);
  const none = await guard.callTool("move_notes", { folder: FOLDER, match: "nothing-*", into: `${FOLDER}/c` });
  assert.match(none.content[0].text, /Nothing moved\. .*log-5\* \(12\)/);
});
