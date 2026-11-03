/**
 * A search across every workspace fuses the lists by evidence
 * (`tools/search.js` `fuseEverywhere`): the word rank in the hit's own
 * workspace, a loose any-word hit counted ten places lower, and one meaning
 * ranking across every workspace, since one model scored them all.
 *
 * Sabotage record (temporary local edits, reverted):
 *   a link-only hit not counted as loose               → "a hit whose words are only inside a link's address…" fails
 *   code passages kept for a prose question             → "a code passage found only by meaning is left out…" fails
 *   meaning ranked per workspace instead of across them → "a note the query is about outranks another workspace's first word hit" fails
 *   the loose penalty dropped                           → "a loose any-word hit never outranks a real match" fails
 *   loose word evidence counted beside a real match     → "a note holding every word outranks another workspace's loose hit that meaning also found" fails
 *   the path prior dropped from the fused score         → "an archived or log note ranks below a live note…" and "a workspace prefix is read through…" fail
 *   the meaning-only budget removed                     → "meaning-only extras are three across every workspace…" fails
 *   the 0.5 floor removed from the strict-hit case      → "…under the 0.5 floor is left out even when the budget has room" fails
 *   the no-strict budget replaced by `extraNotes`       → "with no strict word hit anywhere, six…" fails
 *   the median meaning rank for an unfingerprinted hit removed → "a fresh strict word hit with no meaning score…" fails
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fuseEverywhere, toolSearchNotes } from "../src/tools/search.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { withServedTree } from "./servedTree.mjs";

const hit = (key, { wordRank = null, loose = false, meaningScore = null } = {}) => ({ key, title: key, snippets: [], wordRank, loose, meaningScore });

test("a note the query is about outranks another workspace's first word hit", () => {
  // The person's own workspace has a weak first word hit; the wedding
  // workspace's caterer note matches by word and by meaning.
  const own = [hit("todo.md", { wordRank: 0 })];
  const wedding = [hit("@wedding/vendors/caterer.md", { wordRank: 0, meaningScore: 0.62 }), hit("@wedding/budget.md", { wordRank: 1 })];
  const band = [hit("@band/index.md", { wordRank: 0, meaningScore: 0.41 })];
  const fused = fuseEverywhere([own, wedding, band]).map((entry) => entry.key);
  // The caterer note is still first. A strict word hit with no meaning score
  // now takes the median meaning rank (the fresh-note rule, see the test below),
  // so todo.md places between the caterer and the band note, not below the
  // band note. Changed on 2026-11-03 by that rule; the cost is noted there.
  assert.deepEqual(fused, ["@wedding/vendors/caterer.md", "todo.md", "@band/index.md", "@wedding/budget.md"]);
});

test("a loose any-word hit never outranks a real match, and ties keep this workspace first", () => {
  const own = [hit("notes/team-lunch.md", { wordRank: 0, loose: true })];
  const work = [hit("@work/people/team.md", { wordRank: 0 })];
  assert.deepEqual(fuseEverywhere([own, work]).map((entry) => entry.key), ["@work/people/team.md", "notes/team-lunch.md"]);
  const tied = fuseEverywhere([[hit("a.md", { wordRank: 0 })], [hit("@x/b.md", { wordRank: 0 })]]).map((entry) => entry.key);
  assert.deepEqual(tied, ["a.md", "@x/b.md"]);
});

test("a meaning-only note ranks by its closeness against every workspace's, and the list is bounded", () => {
  const lists = [
    [hit("m1.md", { meaningScore: 0.5 })],
    [hit("@x/m2.md", { meaningScore: 0.7 })],
    [hit("@y/m3.md", { meaningScore: 0.6 })],
  ];
  assert.deepEqual(fuseEverywhere(lists).map((entry) => entry.key), ["@x/m2.md", "@y/m3.md", "m1.md"]);
  const many = Array.from({ length: 30 }, (_, i) => [hit(`@w${i}/n.md`, { wordRank: 0 })]);
  assert.equal(fuseEverywhere(many).length, 12);
  assert.equal(fuseEverywhere(many, 3).length, 3);
});

test("a note holding every word outranks another workspace's loose hit that meaning also found", () => {
  // Production, 2026-11-03, "speed benchmark test note": the person's own note
  // holding all four words placed tenth, below other workspaces' index pages
  // that held one word and that meaning ranked low.
  const own = [hit("archive/chat-history/log.md", { wordRank: 0 }), hit("inbox/bench/single-4.md", { wordRank: 1 })];
  const other = [
    hit("@x/projects/benchmarks.md", { wordRank: 0, meaningScore: 0.6 }),
    hit("@x/a.md", { meaningScore: 0.55 }),
    hit("@x/b.md", { meaningScore: 0.5 }),
  ];
  const care = [hit("@care/index.md", { wordRank: 0, loose: true, meaningScore: 0.41 })];
  const fused = fuseEverywhere([own, other, care]).map((entry) => entry.key);
  assert.ok(fused.indexOf("inbox/bench/single-4.md") < fused.indexOf("@care/index.md"), fused.join(", "));
  // With no note holding every word anywhere, loose hits still rank by their words.
  const allLoose = fuseEverywhere([[hit("a.md", { wordRank: 0, loose: true })], [hit("@x/b.md", { wordRank: 1, loose: true })]]).map((entry) => entry.key);
  assert.deepEqual(allLoose, ["a.md", "@x/b.md"]);
});

/**
 * Meaning-only extras are one budget for the whole search, not one per
 * workspace: five workspaces used to show up to fifteen "Same topic" rows
 * beside the word hits. Production, 2026-11-03: the wanted note sat below
 * filler of exactly this kind.
 */
test("meaning-only extras are three across every workspace, at the 0.5 floor, once any word hit is strict", () => {
  const lists = [
    [hit("todo.md", { wordRank: 0 })],
    [hit("@a/m1.md", { meaningScore: 0.7 }), hit("@a/m2.md", { meaningScore: 0.45 })],
    [hit("@b/m3.md", { meaningScore: 0.65 }), hit("@b/m4.md", { meaningScore: 0.6 })],
    [hit("@c/m5.md", { meaningScore: 0.55 })],
    [hit("@d/m6.md", { meaningScore: 0.52 }), hit("@d/m7.md", { meaningScore: 0.51 })],
  ];
  const kept = fuseEverywhere(lists).map((entry) => entry.key);
  // The three closest above the floor; m2 is under it and the word hit stays.
  assert.deepEqual(kept, ["todo.md", "@a/m1.md", "@b/m3.md", "@b/m4.md"]);
});

test("with a strict word hit, a meaning-only hit under the 0.5 floor is left out even when the budget has room", () => {
  const lists = [[hit("todo.md", { wordRank: 0 })], [hit("@a/loose-meaning.md", { meaningScore: 0.45 })], [hit("@b/close.md", { meaningScore: 0.52 })]];
  assert.deepEqual(fuseEverywhere(lists).map((entry) => entry.key), ["todo.md", "@b/close.md"]);
});

test("with no strict word hit anywhere, six meaning-only extras at the old floor", () => {
  const scores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.44, 0.43];
  const lists = [
    [hit("team.md", { wordRank: 0, loose: true })],
    ...scores.map((score, i) => [hit(`@w${i % 4}/n${i}.md`, { meaningScore: score })]),
  ];
  const kept = fuseEverywhere(lists).map((entry) => entry.key);
  assert.equal(kept.filter((key) => key !== "team.md").length, 6);
  // 0.45 is kept here: the 0.5 floor is for a search where the words found a note.
  assert.ok(kept.includes("@w1/n5.md"));
  assert.ok(!kept.includes("@w2/n6.md"));
});

test("the extra budget is a setting, and a meaning-only hit in the answer is marked", () => {
  const hits = [hit("@a/m1.md", { meaningScore: 0.7 }), hit("@b/m2.md", { meaningScore: 0.6 })];
  const lists = [[hit("todo.md", { wordRank: 0 })], hits];
  const kept = fuseEverywhere(lists, 12, { extraNotes: 1 });
  assert.deepEqual(kept.map((entry) => entry.key), ["todo.md", "@a/m1.md"]);
  assert.equal(hits[0].meaningOnly, true);
  // Dropped by the budget, so not in the answer and not marked.
  assert.notEqual(hits[1].meaningOnly, true);
});

/**
 * A note not yet fingerprinted. The meaning index builds behind searches, so
 * a fresh note has no meaning score for a while, and it used to count as one
 * word rank and nothing else, below older notes that merely matched weakly
 * (production benchmark, 2026-11-03: fresh test notes ranked below unrelated
 * notes). While any hit has a meaning score, a strict word hit without one
 * takes the median meaning rank among those that have one.
 */
test("a fresh strict word hit with no meaning score is not buried under a weaker older hit", () => {
  const own = [hit("fresh.md", { wordRank: 0 })];
  const other = [
    hit("@x/a.md", { meaningScore: 0.6 }),
    hit("@x/b.md", { meaningScore: 0.55 }),
    hit("@x/weak.md", { wordRank: 1, meaningScore: 0.41 }),
    hit("@x/loose.md", { wordRank: 0, loose: true }),
  ];
  const fused = fuseEverywhere([own, other]).map((entry) => entry.key);
  assert.equal(fused[0], "fresh.md", fused.join(", "));
  assert.ok(fused.indexOf("fresh.md") < fused.indexOf("@x/weak.md"));
  // A loose hit gets no meaning contribution from the rule, so it stays below.
  assert.ok(fused.indexOf("@x/loose.md") > fused.indexOf("fresh.md"));
});

/**
 * The path prior (`search/priors.js`), applied to the fused score: with the
 * same evidence, an archived note or a log places below a live one, whichever
 * workspace it is in. Production, 2026-11-03: "2027 plan objectives owners"
 * put an archived chat log first and the plan's overview eleventh.
 */
test("an archived or log note ranks below a live note with the same evidence", () => {
  // Equal word rank, no meaning: the list order used to decide, and the log was listed first.
  const own = [hit("archive/chat-history/2027-plan.md", { wordRank: 0 }), hit("inbox/email/2026-10.md", { wordRank: 0 })];
  const plans = [hit("@plans/2027/objectives.md", { wordRank: 0 })];
  assert.deepEqual(fuseEverywhere([own, plans]).map((entry) => entry.key), ["@plans/2027/objectives.md", "archive/chat-history/2027-plan.md", "inbox/email/2026-10.md"]);
});

test("meetings and ordinary notes are not demoted", () => {
  const own = [hit("inbox/meetings/2026-10-30 standup.md", { wordRank: 0 })];
  const work = [hit("@work/projects/live.md", { wordRank: 0 })];
  assert.deepEqual(fuseEverywhere([own, work]).map((entry) => entry.key), ["inbox/meetings/2026-10-30 standup.md", "@work/projects/live.md"]);
});

test("a workspace prefix is read through before the prior is decided", () => {
  const old = [hit("@old/archive/a.md", { wordRank: 0 })];
  const live = [hit("@new/projects/b.md", { wordRank: 0 })];
  assert.deepEqual(fuseEverywhere([old, live]).map((entry) => entry.key), ["@new/projects/b.md", "@old/archive/a.md"]);
});

test("a log still shows when nothing else matches", () => {
  const own = [hit("archive/chat-history/only.md", { wordRank: 0 })];
  assert.deepEqual(fuseEverywhere([own]).map((entry) => entry.key), ["archive/chat-history/only.md"]);
});

/**
 * Title and phrase evidence (`search/evidence.js`, decided by the owner,
 * 2026-11-03). Sabotage record (temporary local edits, reverted):
 *   the query not passed from searchEverywhere to fuseEverywhere    → "the query reaches the fusion…" fails (the fusion tests pass their own query, so they stay green)
 *   TITLE_WEIGHT set to 1/61                                        → "a title match alone does not beat a note strong on both…" and "the title weight is a fifth…" fail
 *   the bonus given to a loose hit beside a strict one              → "a loose hit gets no title bonus while a strict hit exists" fails
 *   the bonus added after the path prior instead of before it       → "an archived note with a title match…" fails
 *   the phrase bonus dropped                                        → "the bonus is the title weight times the coverage…" fails (and the phrase test of the file name)
 *   the file name read with its folders, a phrase as a substring,
 *   hyphens kept, and short words counted                           → see `test/searchEvidence.test.mjs`'s record
 */

const seen = (key, { title = key, snippets = [], ...rest } = {}) => ({ ...hit(key, rest), title, snippets });

test("production 2026-11-03 'workers comp renewal': the page whose title holds every word leads a weak link hit", () => {
  // Reconstructed: another workspace's rank-0 hit is a note whose only link is
  // about the renewal (no title match, no phrase), and the real page, titled
  // with every word, has a near-identical meaning score and a word rank one
  // place lower. Without the query the link note led and the page came second.
  const lists = () => [
    [seen("@office/links.md", { title: "Useful links", snippets: ["Renewal quote on the [carrier portal](https://example.com)"], wordRank: 0, meaningScore: 0.4 })],
    [seen("@ops/insurance/workers comp renewal.md", { title: "Workers comp renewal", wordRank: 1, meaningScore: 0.38 })],
  ];
  assert.deepEqual(fuseEverywhere(lists()).map((entry) => entry.key), ["@office/links.md", "@ops/insurance/workers comp renewal.md"]);
  assert.deepEqual(fuseEverywhere(lists(), 12, { query: "workers comp renewal" }).map((entry) => entry.key), [
    "@ops/insurance/workers comp renewal.md",
    "@office/links.md",
  ]);
});

test("production 2026-11-03 '2027 plan objectives owners': the overview titled with every word moves from third to first", () => {
  // Reconstructed: an archived chat log (prior 0.5) and two other workspaces'
  // notes lead on word and meaning ranks, the plan overview is third, and its
  // title and file name hold every word as one phrase.
  const lists = () => [
    [seen("archive/chat-history/2027-plan-chat.md", { title: "2027 plan chat", wordRank: 0, meaningScore: 0.9 })],
    [seen("@x/budget.md", { wordRank: 0, meaningScore: 0.8 }), seen("@x/owners.md", { title: "Owners", wordRank: 1, meaningScore: 0.7 })],
    [seen("@plans/2027-plan-objectives-owners.md", { title: "2027 plan objectives owners", wordRank: 2, meaningScore: 0.2 })],
  ];
  assert.equal(fuseEverywhere(lists()).map((entry) => entry.key).indexOf("@plans/2027-plan-objectives-owners.md"), 2);
  const after = fuseEverywhere(lists(), 12, { query: "2027 plan objectives owners" }).map((entry) => entry.key);
  assert.equal(after[0], "@plans/2027-plan-objectives-owners.md", after.join(", "));
});

/** A workspace's notes as a store the search reads: listed, read and headed, as the search needs (`meetingsAnywhere.test.mjs`). */
function scannedStore(notes, extra = {}) {
  const files = new Map(Object.entries(notes));
  const store = {
    async list({ prefix } = {}) {
      const objects = [...files.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .sort()
        .map((key) => ({ key, size: files.get(key).length, uploaded: new Date(0), etag: `e-${key}` }));
      return { objects, truncated: false };
    },
    async get(key) {
      if (!files.has(key)) return null;
      const body = files.get(key);
      return { etag: `e-${key}`, text: async () => body, size: body.length };
    },
    async head(key) {
      return files.has(key) ? { etag: `e-${key}`, size: files.get(key).length } : null;
    },
    ...extra,
  };
  return "treeManifest" in extra ? store : withServedTree(store);
}

/**
 * The query reaches the fusion through `toolSearchNotes` (the sabotage of
 * dropping it from `searchEverywhere` is caught here, not by the fusion tests
 * above). Two other workspaces, with no notes of this one's own: the body
 * match is first in the context list, so without the title evidence it leads
 * on the tie, and with the query the titled page does.
 */
test("the query reaches the fusion: across workspaces a titled page leads a body match listed before it", async () => {
  const rowsOf = (store) => withPrivacyAuthority(store, { rules: { etag: "rows-v1", accessVersion: 1, folders: [], notes: [] } });
  const others = {
    "@office": scannedStore({ "2-areas/links.md": "# Useful links\n\nWorkers comp renewal quote is on the carrier portal.\n" }),
    "@ops": scannedStore({ "2-areas/insurance/workers comp renewal.md": "# Workers comp renewal\n\nCarrier quote due in March.\n" }),
  };
  const home = scannedStore(
    { "0-inbox/todo.md": "# Todo\n\nCall the dentist.\n" },
    {
      contexts: [{ name: "@office" }, { name: "@ops" }],
      async openContext(name) {
        return { session: { scope: "private" }, store: rowsOf(others[name]) };
      },
    },
  );
  const keys = async (query) =>
    (await toolSearchNotes(home, "private", [], new Map(), query, "")).content[0].text.split("\n").filter((line) => line.endsWith(".md"));
  const withQuery = await keys("workers comp renewal");
  assert.equal(withQuery.length, 2, withQuery.join(" | "));
  assert.equal(withQuery[0], "@ops/2-areas/insurance/workers comp renewal.md", withQuery.join(" | "));
});

test("no query given, or one no title or snippet holds, leaves the order exactly as it was", () => {
  const lists = () => [
    [seen("todo.md", { wordRank: 0, meaningScore: 0.3 }), seen("notes/a.md", { title: "Workers comp", wordRank: 2 })],
    [seen("@x/b.md", { title: "Workers comp renewal", wordRank: 0, meaningScore: 0.5 }), seen("@x/c.md", { wordRank: 1 })],
  ];
  const plain = fuseEverywhere(lists()).map((entry) => entry.key);
  assert.deepEqual(fuseEverywhere(lists(), 12, { query: undefined }).map((entry) => entry.key), plain);
  assert.deepEqual(fuseEverywhere(lists(), 12, { query: "zebra" }).map((entry) => entry.key), plain);
});

test("a title match alone does not beat a note strong on both word rank and meaning", () => {
  // The strong note is first on words and on meaning. The titled hit has a
  // full title match and no phrase, but ranks 20th on words and 8th on meaning:
  // weak on both, so the title is all it has to offer.
  const fillers = [0.8, 0.7, 0.6, 0.55, 0.52, 0.51].map((meaningScore, i) => [seen(`@f${i}/n.md`, { wordRank: 0, meaningScore })]);
  const lists = [
    [seen("@x/strong.md", { title: "Renewal of the policy", wordRank: 0, meaningScore: 0.9 })],
    [seen("@y/titled.md", { title: "Renewal of workers comp", wordRank: 20, meaningScore: 0.1 })],
    ...fillers,
  ];
  const fused = fuseEverywhere(lists, 12, { query: "workers comp renewal" }).map((entry) => entry.key);
  assert.ok(fused.indexOf("@x/strong.md") < fused.indexOf("@y/titled.md"), fused.join(", "));
});

test("the whole query as a phrase in the title outranks the same words scattered in another title", () => {
  // Both titles hold every word, and the scattered one ranks first on words:
  // only the phrase tells them apart.
  const lists = [
    [seen("@x/scattered.md", { title: "Renewal for comp and workers", wordRank: 0, meaningScore: 0.5 })],
    [seen("@y/phrase.md", { title: "Workers comp renewal", wordRank: 3, meaningScore: 0.5 })],
  ];
  assert.deepEqual(fuseEverywhere(lists, 12, { query: "Workers   comp Renewal" }).map((entry) => entry.key), ["@y/phrase.md", "@x/scattered.md"]);
});

test("a loose hit gets no title bonus while a strict hit exists", () => {
  // The loose hit holds every word in its title and a phrase, but another
  // workspace has a strict word hit: the loose hit's words do not count, so
  // the order is the one it had without a query.
  const lists = () => [
    [seen("notes/workers-comp-renewal.md", { title: "Workers comp renewal", wordRank: 0, loose: true, meaningScore: 0.95 })],
    [seen("@x/strict.md", { title: "Insurance", wordRank: 25 })],
    [seen("@z/m1.md", { wordRank: 0, meaningScore: 0.9 }), seen("@z/m2.md", { wordRank: 0, meaningScore: 0.8 }), seen("@z/m3.md", { wordRank: 0, meaningScore: 0.7 })],
  ];
  const plain = fuseEverywhere(lists()).map((entry) => entry.key);
  const withQuery = fuseEverywhere(lists(), 12, { query: "workers comp renewal" }).map((entry) => entry.key);
  assert.deepEqual(withQuery, plain);
  assert.ok(withQuery.indexOf("@x/strict.md") < withQuery.indexOf("notes/workers-comp-renewal.md"), withQuery.join(", "));
});

test("an archived note with a title match does not outrank a live note with a better word rank and no title match", () => {
  // The path prior multiplies the score that includes the bonus, so the
  // archived note's bonus is halved with the rest of it.
  const lists = [
    [seen("archive/old/workers-comp-renewal.md", { title: "Workers comp renewal", wordRank: 0 })],
    [seen("@x/live.md", { title: "Renewal notes", wordRank: 0 })],
  ];
  assert.deepEqual(fuseEverywhere(lists, 12, { query: "workers comp renewal" }).map((entry) => entry.key), ["@x/live.md", "archive/old/workers-comp-renewal.md"]);
});

test("a hit whose words are only inside a link's address ranks as a loose one (production, 2026-11-03)", () => {
  const review = { ...hit("@lc/areas/reviews/goal-4.md", { wordRank: 0 }), title: "Goal 4 review", snippets: ["…https://example.invalid/note/@care/projects/workers-comp-renewal/coverage…"] };
  const page = { ...hit("@care/projects/workers-comp-renewal/coverage.page.md", { wordRank: 0 }), title: "Coverage and call script", snippets: ["…calling about our workers' comp renewal that starts…"] };
  const fused = fuseEverywhere([[review], [page]], 12, { query: "workers comp renewal" });
  assert.deepEqual(fused.map((entry) => entry.key), [page.key, review.key]);
  assert.equal(fused[1].loose, false, "the answer carries the hit as given");
  // Without a query nothing is judged, and the lists' order stands.
  assert.deepEqual(fuseEverywhere([[review], [page]]).map((entry) => entry.key), [review.key, page.key]);
});

test("a code passage found only by meaning is left out of a prose question, kept for a code one", () => {
  const code = { ...hit("@supa/projects/oauth/zap-plan.md", { meaningScore: 0.62 }), snippets: ['ientId || state.tokenUrl) && !canRefresh) { print("refresh settings off"); } function form(value) { return encode(value); }'] };
  const prose = { ...hit("@pw/projects/recruitment.md", { meaningScore: 0.55 }), snippets: ["Outreach, partner vetting, booking, invoicing and renewals."] };
  const page = hit("@care/projects/renewal.md", { wordRank: 0 });
  const asked = (query) => fuseEverywhere([[page], [code], [prose]], 12, { query }).map((entry) => entry.key);
  assert.ok(!asked("workers comp renewal").includes(code.key));
  assert.ok(asked("workers comp renewal").includes(prose.key));
  assert.ok(asked("state.tokenUrl refresh").includes(code.key));
});
