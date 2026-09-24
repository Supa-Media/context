/**
 * (i) the index path fails outright and the capped scan catches the call,
 * and the reduced-recall note in the rendered tool text — a shed mailbox's
 * note names bounded to a limit and then counted, never all listed. See
 * searchIntegration.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import {
  BROKEN_TOKEN,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  MANIFEST_KEY,
  PRIVACY_MANIFEST,
  SEARCH_INDEX_KEY,
  SUBREQUEST_LIMIT,
  createBucket,
  createSearchBudget,
  loadIndexManifest,
  searchText,
  serializeManifest,
} from "./fixtures.mjs";

export async function runSearchIntegrationBrokenAndRecallChecks(check, harness) {
  const { broken, controlPlane, env } = harness;

    // -- (i) the index path fails outright, and the scan catches the call ----
    broken.seed("privacy.md", PRIVACY_MANIFEST);
    for (let n = 0; n < 40; n += 1) {
      broken.seed(
        `1-projects/fallback/note-${String(n).padStart(3, "0")}.md`,
        `# Fallback ${n}\n\nThis one mentions the LIGHTHOUSE marker.\n`
      );
    }
    // The manifest is unreadable: a storage error on the very first call of the
    // sync — which is what a revoked key or a 500 looks like here, and it is the
    // *first* op v2 spends, so nothing downstream of it gets a chance to paper
    // over the failure.
    broken.failGetKeys.add(MANIFEST_KEY);
    broken.resetCounts();
    const fallback = await searchText(env, BROKEN_TOKEN, { query: "lighthouse" });
    check(
      "a search whose index is unreachable answers from the capped scan instead of throwing",
      typeof fallback === "string" && fallback.includes("1-projects/fallback/note-")
    );
    check(
      "the capped scan says what it scanned rather than implying it saw everything",
      /scanned \d+ of \d+\+? notes/.test(fallback)
    );
    check(
      "and the recovery path is bounded too — this is where the original bug lived",
      broken.ops < SUBREQUEST_LIMIT
    );

    // A wide bucket, not just a deep one. The scan's listing walks every
    // top-level folder, and listings are store ops like any other: enough
    // folders is enough subrequests before the first note is read, so an
    // un-counted listing re-creates the original failure through the recovery
    // route. The budget has to cut the walk, and the cut has to surface as a
    // floor, not as a precise-looking total.
    for (let n = 0; n < 45; n += 1) {
      broken.seed(`area-${String(n).padStart(2, "0")}/note.md`, "# Wide\n\nLIGHTHOUSE here too.\n");
    }
    broken.resetCounts();
    const wide = await searchText(env, BROKEN_TOKEN, { query: "lighthouse" });
    check(
      "a wide bucket cannot spend the recovery path past the budget on listings alone",
      typeof wide === "string" && broken.ops < SUBREQUEST_LIMIT
    );
    check(
      "and a budget-cut walk reports its total as a floor",
      /of \d+\+ notes/.test(wide)
    );
    broken.failGetKeys.delete(SEARCH_INDEX_KEY);

    /*
     * -- the reduced-recall note, in the RENDERED tool text --------------
     *
     * Everything above proves the object `searchIndexedNotes` hands back.
     * `toolSearchNotes` is a second, hand-written step from that object to
     * the string an agent actually reads, and CLAUDE.md's own rule —
     * "change the test in the same commit as the behavior" — applies to
     * that step too: a field nobody renders is a field nobody acted on.
     * Its own bucket and tokens, so a bulk fixture elsewhere in this file
     * changing shape does not change what shard this mutation lands on.
     */
    controlPlane.addWorkspace("ws_search_recall", "searchrecall", {
      provider: "r2-binding",
      bindingName: "RECALL_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    const RECALL_OWNER = `cat_searchidx_recall_owner_${"0".repeat(9)}`;
    const RECALL_TEAM = `cat_searchidx_recall_team_${"0".repeat(10)}`;
    await controlPlane.addGrant({
      accessToken: RECALL_OWNER,
      workspaceId: "ws_search_recall",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_searchidx_recall_owner",
      userId: "u_recall_owner",
    });
    await controlPlane.addGrant({
      accessToken: RECALL_TEAM,
      workspaceId: "ws_search_recall",
      role: "editor",
      scopes: ["context:read"],
      clientId: "mcp_client_searchidx_recall_member",
      userId: "u_recall_member",
    });
    const recall = createBucket();
    recall.seed(
      "privacy.md",
      "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
        "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
        "folder_defaults:\n  index.md: team\n  1-projects: team\n  2-areas: team\n" +
        "  2-areas/vault: private\n```\n\n" +
        "<!-- END BRAIN PRIVACY RULES -->\n"
    );
    recall.seed("index.md", "# Front page");
    recall.seed("1-projects/shared.md", "# Shared\n\nteamword here.\n");
    recall.seed("2-areas/vault/secret.md", "# Secret\n\nprivateword here.\n");
    const recallEnv = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "RECALL_BUCKET",
      RECALL_BUCKET: recall,
    };

    await searchText(recallEnv, RECALL_OWNER, { query: "teamword" });
    const recallManifest = await loadIndexManifest(recall, createSearchBudget(10), 0);
    check(
      "the fixture converged to one shard, which the injection below assumes",
      recallManifest?.shardCount === 1
    );
    recallManifest.stats[0] = {
      ...recallManifest.stats[0],
      shed: 2,
      shedPaths: ["1-projects/shared.md", "2-areas/vault/secret.md"],
    };
    await recall.put(MANIFEST_KEY, serializeManifest(recallManifest));

    const ownerHitText = await searchText(recallEnv, RECALL_OWNER, { query: "teamword" });
    check(
      "the rendered miss-or-hit text names the reduced note and reads as an actionable claim, not a flag",
      ownerHitText.includes("1-projects/shared.md") &&
        ownerHitText.includes("2-areas/vault/secret.md") &&
        ownerHitText.includes("more messages than the search index can keep in full") &&
        ownerHitText.includes("the note itself still exists and read_note always returns it whole")
    );
    check(
      "...and it is never confused with the 'run me again' banner",
      !ownerHitText.includes("still catching up on this context")
    );

    const teamHitText = await searchText(recallEnv, RECALL_TEAM, { query: "teamword" });
    check(
      "a team caller reads the same claim about their own note and never the private one",
      teamHitText.includes("1-projects/shared.md") && !teamHitText.includes("2-areas/vault/secret.md")
    );

    /*
     * -- the banner is bounded, because a shed mailbox sheds by the day ---
     *
     * Unbounded, 400 shed days made a one-hit answer 23,482 characters long,
     * of which 23,430 were the warning: the hits this search *did* find,
     * buried under the notice about the ones it could not. That is the same
     * defect as the silence this signal replaces, pointing the other way.
     * Named to the limit, then counted — never truncated silently.
     */
    const floodPaths = Array.from(
      { length: 400 },
      (_, i) =>
        `0-inbox/email/name-at-example-com/2026-${String((i % 12) + 1).padStart(2, "0")}-` +
        `${String((i % 28) + 1).padStart(2, "0")}-part-${i}.md`
    ).sort();
    const floodedManifest = await loadIndexManifest(recall, createSearchBudget(10), 0);
    floodedManifest.stats[0] = {
      ...floodedManifest.stats[0],
      shed: floodPaths.length,
      shedPaths: floodPaths,
    };
    await recall.put(MANIFEST_KEY, serializeManifest(floodedManifest));
    const floodedText = await searchText(recallEnv, RECALL_OWNER, { query: "teamword" });
    check(
      "hundreds of shed notes are named to a limit and then counted, not all listed",
      floodedText.includes("(+390 more)") && floodedText.length < 2_000
    );
    check(
      "...and the hit the search actually found is still readable above it",
      floodedText.includes("1-projects/shared.md") &&
        floodedText.indexOf("[note: these notes hold") > floodedText.indexOf("teamword") - 1
    );
}
