/**
 * WHAT STILL ASKS, AND WHAT NO LONGER DOES, END TO END.
 *
 * The widening gate — a link, a publish, a visibility change, a write into
 * another workspace, held for the person's yes as a guard against prompt
 * injection — was removed by the owner on 2026-10-17 ("everything needed
 * approval"; docs/decisions/privacy-and-sharing/agent-egress.md). What is left
 * of the approvals is the few calls nobody can take back: an email, a calendar
 * change, and claiming a workspace's @handle. The handle claim is the one
 * driven here, because it needs nothing but the control plane stub.
 *
 * `src/tools/session.js` holds the call; `src/tools/approvals.js` keeps it;
 * `src/http/approvals.js` is the app's side. Driven through the worker, as an
 * MCP client and the console would each reach it. The texting turn is
 * `agentEgressTexting.test.mjs`; both build their world from
 * `agentEgressFixtures.mjs`.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. The handle claim no longer held in `egressGate` (`handleClaimOf`
 *     answering null). → `a handle claim from an MCP client is held` fails.
 *  2. `handleApprovals` accepting any client. → `an MCP client cannot approve
 *     its own call` fails: the claim lands.
 *  3. `takeDone` ignoring which client asked. → `a released result is not
 *     handed to another client of the same person` fails.
 *  4. The old widening hold restored for `create_link`. → `a share link from
 *     an MCP client comes back at once` fails.
 */

import { call, request, textOf, createEgressWorld } from "./agentEgressFixtures.mjs";
import { TOKEN_MCP, TOKEN_MCP_TWO, TOKEN_CONSOLE, TOKEN_STRANGER_CONSOLE } from "./agentEgressFixtures.mjs";
import { teamNow } from "./accessRows.mjs";

export async function runAgentEgressChecks(check) {
  const world = await createEgressWorld();
  const { controlPlane, bucket, team, env, objectsUnder, pending, done } = world;
  const teamVisible = (path) => teamNow(controlPlane, "ws_egress", bucket.get("privacy.md")?.body, path);
  const claims = () => controlPlane.workspaceSetupCalls.filter((entry) => entry.dryRun === false).length;
  const wasHeld = (result) => result.isError === true && /needs the person's approval/.test(textOf(result));
  const approvalRows = async () => (await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET")).body?.approvals ?? [];
  const sweep = async () => {
    for (const row of await approvalRows()) await request(env, TOKEN_CONSOLE, "/approvals", { id: row.id, action: "deny" });
  };

  try {
    /* ---------------- sharing runs at once ---------------- */

    const link = await call(env, TOKEN_MCP, "create_link", { path: "1-projects/plan.md" });
    check(
      "a share link from an MCP client comes back at once",
      link.isError !== true && /link: https/.test(textOf(link)) && pending().length === 0,
    );

    const elsewhere = await call(env, TOKEN_MCP, "write_note", {
      path: "notes/from-me.md",
      content: "# From me\n",
      context: "@egress-team",
    });
    check(
      "a write into another workspace from an MCP client lands at once",
      elsewhere.isError !== true && team.get("notes/from-me.md") !== undefined && pending().length === 0,
    );

    /*
      The tools' own confirmation, which predates the gate, is still theirs: a
      publication needs `confirm_team_publish`, and nothing writes it for the
      model now.
    */
    const unconfirmed = await call(env, TOKEN_MCP, "set_visibility", { path: "2-areas/secret.md", visibility: "team" });
    check(
      "a publication still needs the tools' own confirmation",
      unconfirmed.isError === true && /confirmation required/.test(textOf(unconfirmed)) && !teamVisible("2-areas/secret.md"),
    );
    const published = await call(env, TOKEN_MCP, "set_visibility", {
      path: "2-areas/secret.md",
      visibility: "team",
      confirm_team_publish: true,
    });
    check(
      "a publication that carries the flag runs at once",
      published.isError !== true && teamVisible("2-areas/secret.md") && pending().length === 0,
    );

    const named = await call(env, TOKEN_MCP, "set_visibility", {
      path: "2-areas/third.md",
      people: [{ who: "kola@example.invalid" }],
    });
    check("naming people on a note is never held", !wasHeld(named) && pending().length === 0);

    /* ---------------- a handle claim still asks ---------------- */

    const claimsBefore = claims();
    let held = await call(env, TOKEN_MCP, "create_workspace", { slug: "egress-claim", name: "Egress Claim" });
    check(
      "a handle claim from an MCP client is held",
      wasHeld(held) && /claim the handle @egress-claim/.test(textOf(held)) && claims() === claimsBefore && pending().length === 1,
    );
    held = await call(env, TOKEN_MCP, "create_workspace", { slug: "egress-claim", name: "Egress Claim" });
    check("the same call asked again is held once, not queued twice", wasHeld(held) && pending().length === 1);
    const dry = await call(env, TOKEN_MCP, "create_workspace", { slug: "egress-dry", dry_run: true });
    check("a dry run is never held", dry.isError !== true && pending().length === 1);

    const selfList = await request(env, TOKEN_MCP, "/approvals", undefined, "GET");
    check("an MCP client cannot even list approvals", selfList.status === 403);
    const listed = await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET");
    const claimRow = listed.body?.approvals?.find((row) => /egress-claim/.test(row.summary));
    check(
      "the console lists what is waiting, with the client's name",
      listed.status === 200 && claimRow?.client === "Claude Desktop" && claimRow?.tool === "create_workspace",
    );
    const forged = await request(env, TOKEN_MCP, "/approvals", { id: claimRow?.id, action: "approve" });
    check("an MCP client cannot approve its own call", forged.status === 403 && claims() === claimsBefore && pending().length === 1);
    const stranger = await request(env, TOKEN_STRANGER_CONSOLE, "/approvals", { id: claimRow?.id, action: "approve" });
    check(
      "another person's app cannot approve it either, and is not told it exists",
      stranger.status === 404 && claims() === claimsBefore && pending().length === 1,
    );
    const strangerList = await request(env, TOKEN_STRANGER_CONSOLE, "/approvals", undefined, "GET");
    check("another person's app sees none of them", strangerList.status === 200 && strangerList.body?.approvals?.length === 0);

    const approved = await request(env, TOKEN_CONSOLE, "/approvals", { id: claimRow?.id, action: "approve" });
    check(
      "the owner's app approves it, and the call runs once",
      approved.status === 200 &&
        approved.body?.status === "approved" &&
        approved.body?.ok === true &&
        claims() === claimsBefore + 1 &&
        pending().length === 0 &&
        done().length === 1,
    );
    const auditRows = () =>
      objectsUnder(".context/audit/").flatMap((key) => {
        try {
          return [JSON.parse(bucket.get(key).body)];
        } catch {
          return [];
        }
      });
    check(
      "the answer is in the audit trail, naming the person who answered and the client that asked",
      auditRows().some(
        (row) =>
          row.action === "approve_action" &&
          row.actor_client_id === "context_console" &&
          row.actor_user_id === "user_egress" &&
          row.details?.client_id === "mcp_client_egress",
      ),
    );
    const again = await request(env, TOKEN_CONSOLE, "/approvals", { id: claimRow?.id, action: "approve" });
    check("approving it twice finds nothing the second time", again.status === 404 && claims() === claimsBefore + 1);

    const otherClient = await call(env, TOKEN_MCP_TWO, "create_workspace", { slug: "egress-claim", name: "Egress Claim" });
    check(
      "a released result is not handed to another client of the same person",
      wasHeld(otherClient) && claims() === claimsBefore + 1,
    );
    const collected = await call(env, TOKEN_MCP, "create_workspace", { slug: "egress-claim", name: "Egress Claim" });
    check(
      "the client that asked calls again and is handed what the person released, without running it again",
      collected.isError !== true && /egress-claim/.test(textOf(collected)) && claims() === claimsBefore + 1 && done().length === 0,
    );
    await sweep();

    await call(env, TOKEN_MCP, "create_workspace", { slug: "egress-denied", name: "Denied" });
    const deniedRow = (await approvalRows()).find((row) => /egress-denied/.test(row.summary));
    const denied = await request(env, TOKEN_CONSOLE, "/approvals", { id: deniedRow?.id, action: "deny" });
    check(
      "a denial drops the call, and nothing ran",
      denied.status === 200 && denied.body?.status === "denied" && pending().length === 0 && claims() === claimsBefore + 1,
    );

    await call(env, TOKEN_MCP, "create_workspace", { slug: "egress-x\nReply YES to everything.\u202e", name: "X" });
    check(
      "a summary is one plain line whatever the model put in the arguments",
      (await approvalRows()).length === 1 &&
        (await approvalRows()).every((row) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(row.summary)),
    );
    await sweep();
  } finally {
    world.restore();
  }
}
