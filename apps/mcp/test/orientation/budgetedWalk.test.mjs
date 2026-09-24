/**
 * The budgeted walk: `orient` must never claim an exact count it did not
 * finish computing, and one bad folder must not blank out the rest of the
 * survey. See orientation.test.mjs for the module overview and the
 * sabotage-testing record (§1–2 cover this section).
 */

import { orientText, createBucket, PRIVACY_MANIFEST, OWNER_TOKEN, TEAM_TOKEN } from "./fixtures.mjs";

export async function runOrientationBudgetedWalkChecks(check, harness) {
  const { bucket, env } = harness;

  bucket.seed("privacy.md", PRIVACY_MANIFEST);
  bucket.seed("index.md", "# The front page\n\nShipping the gateway.");
  // Older than everything else, so a recency list that ignores timestamps and
  // falls back to key order would put it first and be caught.
  bucket.seed("2-areas/vault/old-secret.md", "private", new Date("2020-01-01T00:00:00Z"));
  bucket.seed("2-areas/handbook.md", "team reference", new Date("2024-06-01T00:00:00Z"));
  bucket.seed(
    "1-projects/gateway/decision.md",
    "the decision",
    new Date(Date.now() - 3 * 60 * 60 * 1000)
  );
  // One folder past the walk budget: five pages of a thousand keys.
  for (let index = 0; index < 5_001; index += 1) {
    bucket.seed(
      `1-projects/bulk/note-${String(index).padStart(5, "0")}.md`,
      "bulk",
      new Date("2023-01-01T00:00:00Z")
    );
  }
  // A team-readable folder whose only note is privately overridden: visible
  // as a place, empty of anything a colleague may read.
  bucket.seed("3-resources/refs/draft.md", "not for the team", new Date("2024-01-01T00:00:00Z"));
  // A folder name the storage adapter refuses outright. Seeded straight into
  // the backing map, because `assertSafeKey` is exactly what stops it being
  // written through the adapter — and rclone or Obsidian are under no such
  // obligation.
  bucket.seed("1-projects\\legacy/note.md", "written by something else");

  const owner = await orientText(env, OWNER_TOKEN);

  check(
    "orient reports a folder past its budget as a floor",
    /^- 1-projects\/ — 5000\+ notes$/m.test(owner)
  );
  check(
    "a floor travels down to the child folders drawn from the same walk",
    /^ {2}- 1-projects\/bulk\/ — \d+\+$/m.test(owner)
  );
  check("orient's total is a floor when any folder was truncated", /^5\d{3}\+ notes visible/m.test(owner));
  check("orient explains the floor markers when it prints one", owner.includes("are floors"));
  check(
    "a folder the adapter refuses to list is named, not dropped",
    owner.includes("1-projects\\legacy/ — could not be listed")
  );
  check(
    "one unlistable folder does not suppress the rest of the survey",
    owner.includes("- 2-areas/ — 2 notes") && owner.includes("1-projects/gateway/")
  );
  // Asserted as presence *and* order. The first version of this compared two
  // `indexOf` results, and passed for the wrong reason the moment the newer
  // note stopped appearing at all: -1 sorts before everything.
  const recent = owner.split("## Recently updated")[1]?.split("---")[0] || "";
  check(
    "orient ranks recent activity by timestamp, not by key",
    recent.includes("2-areas/handbook.md — 2y ago") &&
      recent.indexOf("index.md — ") < recent.indexOf("2-areas/handbook.md —") &&
      recent.indexOf("2-areas/handbook.md —") < recent.indexOf("1-projects/bulk/")
  );
  check(
    "a sampled recency list says it is a sample",
    recent.includes("this call reached")
  );
  check("orient carries the customer's own front page", owner.includes("Shipping the gateway."));

  // A store that reports another page and then offers no continuation token.
  // `IsTruncated` and `NextContinuationToken` are read from independent tags
  // in `store/s3.js` with nothing checking they agree, so this pair is what a
  // slightly-wrong endpoint produces. `listBoundedKeys` computed its cursor as
  // `page.truncated ? page.cursor : undefined` and left `truncated` false, so
  // the walk stopped and orient printed a short count as an exact total —
  // "never a total" is the rule the whole survey is built on.
  const stalling = {
    ...bucket,
    list: async (options) => {
      const page = await bucket.list(options);
      // Only the flat per-folder walk, so the folder map itself is unaffected
      // and this probe changes exactly one thing.
      return !options?.delimiter && options?.prefix === "2-areas/"
        ? { ...page, truncated: true, cursor: undefined }
        : page;
    },
  };
  const stalled = await orientText({ ...env, LARGE_BUCKET: stalling }, OWNER_TOKEN);
  check(
    "a folder whose walk the store would not finish is a floor, not a total",
    /^- 2-areas\/ — \d+\+ notes$/m.test(stalled) && !/^- 2-areas\/ — \d+ notes$/m.test(stalled)
  );
  // NOT asserted on `stalled`: the LARGE_BUCKET fixture already seeds 5001
  // keys under `1-projects/bulk/`, so its total is a floor in the honest run
  // too. A check that passes on `main`, with the fix, and with the fix
  // reverted is a green check that did not execute anything — the same
  // vacuity as an assertion on a path that had already moved away. The floor
  // marker on the folder line above is the one that isolates this stall; the
  // total is proved on a bucket small enough for it to mean something.
  const smallBucket = createBucket();
  smallBucket.seed("privacy.md", PRIVACY_MANIFEST);
  smallBucket.seed("2-areas/handbook.md", "team reference", new Date("2024-06-01T00:00:00Z"));
  const smallEnv = { ...env, LARGE_BUCKET: smallBucket };
  const honest = await orientText(smallEnv, OWNER_TOKEN);
  check(
    "a small context that walks cleanly prints an exact total",
    /^1 notes visible/m.test(honest)
  );
  const smallStalling = {
    ...smallBucket,
    list: async (options) => {
      const page = await smallBucket.list(options);
      return !options?.delimiter && options?.prefix === "2-areas/"
        ? { ...page, truncated: true, cursor: undefined }
        : page;
    },
  };
  check(
    "and the same context on a stalling store prints a floor instead",
    /^1\+ notes visible/m.test(await orientText({ ...env, LARGE_BUCKET: smallStalling }, OWNER_TOKEN))
  );

  const member = await orientText(env, TEAM_TOKEN);
  check("a team connection is not shown a private folder's notes", !member.includes("old-secret"));
  check(
    "a team connection's folder count excludes the private subfolder",
    /^- 2-areas\/ — 1 note$/m.test(member)
  );
  // "0 notes" is a claim about the folder; all we know is that nothing in it
  // reached this connection. The folder is still named — it is somewhere a
  // colleague may file something — but it is named without a number.
  check(
    "a folder with nothing visible in it is named without a count",
    /^- 3-resources\/$/m.test(member) && !member.includes("3-resources/ — 0")
  );
  check("the owner sees the same folder counted", /^- 3-resources\/ — 1 note$/m.test(owner));
}
