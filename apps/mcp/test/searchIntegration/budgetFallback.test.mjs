/**
 * The subrequest budget as a deployment setting, and a backend whose
 * listings carry no etag at all. See searchIntegration.test.mjs for the
 * module overview and the sabotage-testing record.
 */

import {
  BIG_TOKEN,
  PRIVACY_MANIFEST,
  PRIVACY_MANIFEST_READ,
  R2Store,
  SEARCH_SUBREQUEST_BUDGET,
  createBucket,
  createSearchBudget,
  indexedPaths,
  removeV2Index,
  searchIndex,
  searchText,
  syncIndex,
} from "./fixtures.mjs";

export async function runSearchIntegrationBudgetFallbackChecks(check, harness) {
  const { big, env } = harness;

    // -- the budget is a deployment setting, bounded ------------------------
    //
    // The default assumes the free tier's 50-subrequest ceiling; a paid-plan
    // worker gets 1000, and holding it to 40 there stretches a real workspace's
    // first index across dozens of searches. `SEARCH_SUBREQUEST_BUDGET` in the
    // environment raises it; garbage must fall back to the default rather than
    // take search down.
    removeV2Index(big);
    big.resetCounts();
    const bigBudget = await searchText(
      { ...env, SEARCH_SUBREQUEST_BUDGET: "200" },
      BIG_TOKEN,
      { query: "widget" }
    );
    // One *request*, not one answer, and the difference is the point. The
    // search itself reads a ready index and there was none, so it answered from
    // the bounded scan — and the whole of the raised budget went on the pass
    // behind the response, which is where every note read in this system now
    // happens. The index is whole by the time the invocation ends, which is
    // what the next search reads.
    check(
      "a raised deployment budget indexes a 65-note context in one request",
      typeof bigBudget === "string" &&
        big.ops > SEARCH_SUBREQUEST_BUDGET &&
        indexedPaths(big)?.length === 65
    );
    const bigSettled = await searchText(
      { ...env, SEARCH_SUBREQUEST_BUDGET: "200" },
      BIG_TOKEN,
      { query: "widget" }
    );
    check(
      "and the next search over it says nothing about catching up",
      typeof bigSettled === "string" && !bigSettled.includes("still catching up")
    );
    removeV2Index(big);
    big.resetCounts();
    const bigGarbage = await searchText(
      { ...env, SEARCH_SUBREQUEST_BUDGET: "not-a-number" },
      BIG_TOKEN,
      { query: "widget" }
    );
    const bigGarbageOps = big.ops;
    big.resetCounts();
    // The second one, because the first faced no index and answered from the
    // scan: what a garbage budget must not do is take search down or run
    // unbounded, and both requests are held to the default here.
    const bigGarbageAgain = await searchText(
      { ...env, SEARCH_SUBREQUEST_BUDGET: "not-a-number" },
      BIG_TOKEN,
      { query: "widget" }
    );
    check(
      "an unparseable budget var is the default, never a throw and never unbounded",
      typeof bigGarbage === "string" &&
        bigGarbageAgain.includes("still catching up") &&
        bigGarbageOps - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET &&
        big.ops - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET
    );

    // A backend whose listings carry no etag at all — Dropbox lists
    // `server_modified` and `size` and nothing else. The diff has to converge
    // on those two or the index is rebuilt from scratch on every single search,
    // which is the failure this whole module exists to remove wearing a
    // different hat.
    const dropboxish = createBucket();
    dropboxish.listEtags = false;
    dropboxish.seed("privacy.md", PRIVACY_MANIFEST);
    dropboxish.seed("1-projects/one.md", "# One\n\nA NARWHAL swims past.\n");
    dropboxish.seed("1-projects/two.md", "# Two\n\nAnother NARWHAL entirely.\n");
    const dropboxStore = new R2Store(dropboxish);
    const firstPass = await syncIndex(dropboxStore, { budget: createSearchBudget(50) });
    dropboxish.resetCounts();
    const secondPass = await syncIndex(dropboxStore, { budget: createSearchBudget(50) });
    check(
      "a listing with no etag still converges, on the timestamp and size it does report",
      firstPass.index.docs.size === 2 &&
        secondPass.pending === 0 &&
        dropboxish.counts.noteGets.length === 0 &&
        dropboxish.counts.put === 0 &&
        searchIndex(secondPass.index, "narwhal").length === 2
    );

}
