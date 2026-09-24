/**
 * Orient carries the shed signal, and `canSee` still runs on it. See
 * orientation.test.mjs for the module overview.
 *
 * `search_notes` and `orient` must not be able to disagree about which of
 * a caller's own notes have reduced recall — the same "one search path"
 * reasoning CLAUDE.md states for hits, applied to this fact instead. So
 * this drives the same manifest mutation `commsSearchIndex.test.mjs`'s
 * shard-sizing checks drive against a real mailbox — too slow to repeat
 * here — and asks `orient`, the surface that had nothing to say at all
 * before this change.
 */

import { orientText, rpc, createBucket, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./fixtures.mjs";
import { MANIFEST_KEY, loadIndexManifest, serializeManifest } from "../../src/search/shards.js";
import { createSearchBudget } from "../../src/search/maintain.js";

export async function runOrientationShedSignalChecks(check, harness) {
  const { controlPlane } = harness;

  await controlPlane.addWorkspace("ws_shed", "shed", {
    provider: "r2-binding",
    bindingName: "SHED_BUCKET",
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });
  const SHED_OWNER = `cat_orientation_shed_owner_${"0".repeat(9)}`;
  const SHED_TEAM = `cat_orientation_shed_team_${"0".repeat(10)}`;
  await controlPlane.addGrant({
    accessToken: SHED_OWNER,
    workspaceId: "ws_shed",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_shed_owner",
    userId: "user_shed_owner",
  });
  await controlPlane.addGrant({
    accessToken: SHED_TEAM,
    workspaceId: "ws_shed",
    role: "editor",
    scopes: ["context:read"],
    clientId: "mcp_client_shed_member",
    userId: "user_shed_member",
  });

  const shedBucket = createBucket();
  shedBucket.seed(
    "privacy.md",
    "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
      "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
      "folder_defaults:\n  index.md: team\n  1-projects: team\n  2-areas: team\n" +
      "  2-areas/vault: private\n```\n\n" +
      "<!-- END BRAIN PRIVACY RULES -->\n"
  );
  shedBucket.seed("index.md", "# Front page");
  shedBucket.seed("1-projects/shared.md", "# Shared\n\nteamword\n");
  shedBucket.seed("2-areas/vault/secret.md", "# Secret\n\nprivateword\n");
  const shedEnv = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    NATIVE_BINDINGS: "SHED_BUCKET",
    SHED_BUCKET: shedBucket,
  };

  // A real pass, through the real tool, so what gets mutated below is a
  // manifest the gateway actually wrote rather than one this file invented.
  await rpc(shedEnv, SHED_OWNER, "tools/call", {
    name: "search_notes",
    arguments: { query: "teamword" },
  });
  const manifest = await loadIndexManifest(shedBucket, createSearchBudget(10), 0);
  check("the shed fixture converged to one shard, which the injection below assumes", manifest?.shardCount === 1);
  manifest.stats[0] = {
    ...manifest.stats[0],
    shed: 2,
    shedPaths: ["1-projects/shared.md", "2-areas/vault/secret.md"],
  };
  await shedBucket.put(MANIFEST_KEY, serializeManifest(manifest));

  const shedOwnerText = await orientText(shedEnv, SHED_OWNER);
  check(
    "orient tells the owner which of their own notes lost recall, by path",
    shedOwnerText.includes("## Search coverage") &&
      shedOwnerText.includes("1-projects/shared.md") &&
      shedOwnerText.includes("2-areas/vault/secret.md")
  );
  check(
    "...scoped honestly: a reduced note still answers, mail is not reported as gone",
    shedOwnerText.includes("the note itself is unaffected") &&
      shedOwnerText.includes("read_note always returns it whole")
  );

  const shedTeamText = await orientText(shedEnv, SHED_TEAM);
  check(
    "...and a team caller learns about their own shed note but never the private one",
    shedTeamText.includes("## Search coverage") &&
      shedTeamText.includes("1-projects/shared.md") &&
      !shedTeamText.includes("2-areas/vault/secret.md") &&
      !shedTeamText.includes("privateword")
  );

  /*
   * -- and it cannot take the page over -------------------------------
   *
   * Shedding is per note and a mailbox sheds by the day, so "a few paths"
   * is the small case and hundreds is the one that actually happens.
   * Unbounded, this section measured 23,798 characters and pushed every
   * later section — other contexts, pending proposals, the owner's own
   * save procedure — past 400 lines of mail paths. `orient` already
   * collapses automatic captures for exactly this reason ("so they cannot
   * crowd out a note the user actually touched"), and shed notes are the
   * same mail arriving on the same schedule.
   */
  const floodPaths = Array.from(
    { length: 400 },
    (_, i) =>
      `0-inbox/email/name-at-example-com/2026-${String((i % 12) + 1).padStart(2, "0")}-` +
      `${String((i % 28) + 1).padStart(2, "0")}-part-${i}.md`
  ).sort();
  const flooded = await loadIndexManifest(shedBucket, createSearchBudget(10), 0);
  flooded.stats[0] = { ...flooded.stats[0], shed: floodPaths.length, shedPaths: floodPaths };
  await shedBucket.put(MANIFEST_KEY, serializeManifest(flooded));
  const floodedText = await orientText(shedEnv, SHED_OWNER);
  const coverage = floodedText
    .slice(floodedText.indexOf("## Search coverage"))
    .split("\n\n")[0];
  check(
    "a context with hundreds of shed notes names some of them and counts the rest",
    coverage.includes("- (+390 more notes in the same state)") && coverage.split("\n").length < 20
  );
  check(
    "...so the page stays a page rather than a list of mail paths",
    floodedText.length < shedOwnerText.length + 1_500 &&
      floodedText.includes("## Front page") &&
      floodedText.includes("## Structure")
  );
}
