/**
 * The survey's counts, from the Convex tree: `orient` lists the whole tree in
 * one answer (`tree/served.js`), so a folder of any size is counted exactly,
 * and a workspace the tree cannot answer for yet says so rather than walking
 * the bucket. These checks used to hold the bucket walk's page budget and its
 * "5000+" floors; the walk is gone (decided by the owner, 2026-10-13), and
 * with it the floors. See orientation.test.mjs for the module overview.
 */

import { callText, orientText, PRIVACY_MANIFEST, OWNER_TOKEN, TEAM_TOKEN } from "./fixtures.mjs";

export async function runOrientationBudgetedWalkChecks(check, harness) {
  const { bucket, env, controlPlane } = harness;

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
  // One folder past the old walk budget (five pages of a thousand keys).
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
  // obligation. The tree holds it like any other name.
  bucket.seed("1-projects\\legacy/note.md", "written by something else");

  const owner = await orientText(env, OWNER_TOKEN);

  check(
    "orient counts a folder past the old walk budget exactly",
    /^- 1-projects\/ \(5002 notes\)$/m.test(owner)
  );
  check(
    "a child folder is counted exactly too",
    /^ {2}- 1-projects\/bulk\/ \(5001 notes\)$/m.test(owner)
  );
  check("orient's total is exact, never a floor", /^5007 notes visible/m.test(owner) && !owner.includes("are floors"));
  check(
    "a folder the adapter refuses to list is still on the map, from the tree",
    owner.includes("- 1-projects\\legacy/ (1 note)")
  );
  check(
    "every folder is on the survey",
    owner.includes("- 2-areas/ (2 notes)") && owner.includes("1-projects/gateway/")
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
  check("orient carries the customer's own front page", owner.includes("Shipping the gateway."));

  // A workspace whose first copy into the tree has not finished: orient says
  // so, still carries the front page, and lists nothing from the bucket.
  const listed = [];
  const realList = bucket.list;
  bucket.list = async (options) => {
    listed.push(options?.prefix ?? "");
    return realList(options);
  };
  controlPlane.stopServing("ws_large");
  const loading = await orientText(env, OWNER_TOKEN);
  const listing = await callText(env, OWNER_TOKEN, "list_notes", {});
  controlPlane.resumeServing("ws_large");
  bucket.list = realList;
  check(
    "a workspace still loading is told so, with its front page and no map",
    loading.includes("still loading") && loading.includes("Shipping the gateway.") && !loading.includes("1-projects/bulk/")
  );
  check("...and list_notes says it is still loading", /still loading/.test(listing) && !listing.includes("1-projects/"));
  check(
    "...and neither listed the bucket",
    listed.every((prefix) => prefix.startsWith("."))
  );

  const member = await orientText(env, TEAM_TOKEN);
  check("a team connection is not shown a private folder's notes", !member.includes("old-secret"));
  check(
    "a team connection's folder count excludes the private subfolder",
    /^- 2-areas\/ \(1 note\)$/m.test(member)
  );
  // "0 notes" is a claim about the folder; all we know is that nothing in it
  // reached this connection. The folder is still named — it is somewhere a
  // colleague may file something — but it is named without a number.
  check(
    "a folder with nothing visible in it is named without a count",
    /^- 3-resources\/$/m.test(member) && !member.includes("3-resources/ — 0")
  );
  check("the owner sees the same folder counted", /^- 3-resources\/ \(1 note\)$/m.test(owner));
}
