/**
 * THE EGRESS GATE, END TO END: an AI client never widens who can see
 * something without a person saying yes, and the yes is checked by the
 * gateway rather than by the model.
 *
 * `src/privacy/egress.js` decides what widens and when a turn must ask;
 * `src/tools/session.js` holds the call; `src/tools/approvals.js` keeps it;
 * `src/agent/route.js` settles a texted YES or NO before any model runs;
 * `src/http/approvals.js` is the app's side. Driven here through the worker,
 * as an MCP client, a texting turn and the console would each reach it.
 *
 * This file: the MCP-client checks, the console's approvals, and the
 * released-result hand-off. The texting-turn checks are in
 * `agentEgressTexting.test.mjs`; the world they run against is built by
 * `agentEgressFixtures.mjs`, one fresh instance per suite.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `approvalRequired` returning false for a session with no ledger (an
 *     MCP client treated as a turn seen whole). → `an MCP client's widening
 *     is held, whatever it read` fails.
 *  2. `egressGate` removed from the ordinary dispatch path. → `an MCP client's
 *     widening is held, whatever it read` fails. (The texting half of this
 *     record is in `agentEgressTexting.test.mjs`.)
 *  3. `handleApprovals` accepting any client. → `an MCP client cannot
 *     approve its own call` fails: the override lands.
 *  6. `/approvals` needing write again, for a member of the default
 *     workspace. → `a member here who is an editor there can list and approve
 *     a held write into that workspace` fails.
 *  7. The released-result lookup removed from `egressGate`, for a call that no
 *     longer widens. → `the client that asked calls again and is handed what
 *     the person released`, `the owner's app releases a link...` and `the
 *     client that asked for a link calls again...` fail.
 *
 * A review that tried to break the gate found these, each written as a failing
 * check first and then closed:
 *
 *  8. `egressGate` classifying by the name the client sent rather than the one
 *     dispatched (`canonicalToolName` removed). → `the archive tool's old name
 *     is held like the new one` fails: `archive_chat` saved a team-visible note.
 *  9. `create_form` absent from the classifier. → `the unlisted form tool
 *     cannot publish a note to the team` and `... write into another workspace`.
 * 10. The generic "a write tool addressed into another workspace" rule removed
 *     (`writes` not passed), or `move_note` back to needing the publish flag
 *     across workspaces. → `a write that carries no text into another
 *     workspace is held too`, `a team note moved into another workspace is
 *     held without any flag`, `a move inside a workspace the connection did not
 *     start in is held`, `a move addressed with context alone is held`.
 * 11. `wideningOf` naming only the first way a call widens, and the gate
 *     supplying `confirm_team_publish` for any approval. → `a call that widens
 *     two ways says both`.
 * 12. `oneLine` removed from the summary. → `a summary is one plain line...`.
 * 13. `takeDone` ignoring which client asked. → `a released result is not handed
 *     to another client of the same person`.
 * 14. `complete: true` for any client's `/agent`. → `a connected AI client
 *     driving /agent is not a turn seen whole`.
 * 19. `store.actor` not set in `handleApprovals`. → `a replayed write is in the
 *     audit trail under the client that asked...` fails: the row names nobody.
 */

import { call, request, textOf, toolReplies, createEgressWorld } from "./agentEgressFixtures.mjs";
import {
  TOKEN_MCP,
  TOKEN_MCP_TWO,
  TOKEN_CONSOLE,
  TOKEN_STRANGER_CONSOLE,
  TOKEN_MEMBER_MCP,
  TOKEN_MEMBER_CONSOLE,
} from "./agentEgressFixtures.mjs";

export async function runAgentEgressChecks(check) {
  const world = await createEgressWorld();
  const { s3, model, bucket, team, env, teamVisible, objectsUnder, pending, done } = world;

  try {
    /* ---------------- an MCP client ---------------- */

    let held = await call(env, TOKEN_MCP, "set_visibility", { path: "2-areas/secret.md", visibility: "team" });
    check(
      "an MCP client's widening is held, whatever it read",
      held.isError === true &&
        /needs the person's approval/.test(textOf(held)) &&
        /make 2-areas\/secret\.md visible to the team/.test(textOf(held)) &&
        !teamVisible("2-areas/secret.md") &&
        pending().length === 1,
    );
    held = await call(env, TOKEN_MCP, "set_visibility", { path: "2-areas/secret.md", visibility: "team" });
    check("the same call asked again is held once, not queued twice", held.isError === true && pending().length === 1);

    const plain = await call(env, TOKEN_MCP, "write_note", { path: "1-projects/notes.md", content: "# Notes\n" });
    check("an ordinary write inside the workspace is never held", plain.isError !== true && /written/.test(textOf(plain)));

    const link = await call(env, TOKEN_MCP, "create_link", { path: "1-projects/plan.md" });
    check(
      "a share link from an MCP client is held, and no address comes back",
      link.isError === true && !/https?:\/\//.test(textOf(link)) && pending().length === 2,
    );
    const elsewhere = await call(env, TOKEN_MCP, "write_note", {
      path: "notes/from-me.md",
      content: "# From me\n",
      context: "@egress-team",
    });
    check(
      "a write into another workspace from an MCP client is held, in the connection's own context",
      elsewhere.isError === true &&
        /write notes\/from-me\.md into @egress-team/.test(textOf(elsewhere)) &&
        team.get("notes/from-me.md") === undefined &&
        pending().length === 3,
    );

    const selfApprove = await request(env, TOKEN_MCP, "/approvals", undefined, "GET");
    check("an MCP client cannot even list approvals", selfApprove.status === 403);
    const listed = await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET");
    const secretApproval = listed.body?.approvals?.find((row) => /secret\.md/.test(row.summary));
    check(
      "the console lists what is waiting, with the client's name",
      listed.status === 200 &&
        listed.body.approvals.length === 3 &&
        secretApproval?.client === "Claude Desktop" &&
        secretApproval?.tool === "set_visibility",
    );
    const forged = await request(env, TOKEN_MCP, "/approvals", { id: secretApproval?.id, action: "approve" });
    check(
      "an MCP client cannot approve its own call",
      forged.status === 403 && !teamVisible("2-areas/secret.md") && pending().length === 3,
    );
    const stranger = await request(env, TOKEN_STRANGER_CONSOLE, "/approvals", { id: secretApproval?.id, action: "approve" });
    check(
      "another person's app cannot approve it either, and is not told it exists",
      stranger.status === 404 && !teamVisible("2-areas/secret.md") && pending().length === 3,
    );
    const strangerList = await request(env, TOKEN_STRANGER_CONSOLE, "/approvals", undefined, "GET");
    check("another person's app sees none of them", strangerList.status === 200 && strangerList.body?.approvals?.length === 0);

    const approved = await request(env, TOKEN_CONSOLE, "/approvals", { id: secretApproval?.id, action: "approve" });
    check(
      "the owner's app approves it, and the call runs once, as them",
      approved.status === 200 &&
        approved.body?.status === "approved" &&
        approved.body?.ok === true &&
        /visibility changed/.test(approved.body?.result ?? "") &&
        teamVisible("2-areas/secret.md") &&
        pending().length === 2 &&
        done().length === 1,
    );
    // Every row in the audit trail, parsed; the store deletes by tombstone.
    const auditRows = () =>
      objectsUnder(".context/audit/").flatMap((key) => {
        try {
          return [JSON.parse(bucket.get(key).body)];
        } catch {
          return [];
        }
      });
    check(
      "a replayed write is in the audit trail under the client that asked, and the person who answered is recorded too",
      auditRows().some(
        (row) =>
          row.action === "set_visibility" && row.actor_client_id === "mcp_client_egress" && row.actor_user_id === "user_egress",
      ) &&
        auditRows().some(
          (row) =>
            row.action === "approve_action" &&
            row.actor_client_id === "context_console" &&
            row.actor_user_id === "user_egress" &&
            row.details?.client_id === "mcp_client_egress",
        ),
    );
    const again = await request(env, TOKEN_CONSOLE, "/approvals", { id: secretApproval?.id, action: "approve" });
    check("approving it twice finds nothing the second time", again.status === 404 && done().length === 1);

    // The note is team now, so the same call no longer widens; it is still
    // handed the result the person released, and that record is consumed.
    const doneBeforeCollect = done().length;
    const collected = await call(env, TOKEN_MCP, "set_visibility", { path: "2-areas/secret.md", visibility: "team" });
    check(
      "the client that asked calls again and is handed what the person released",
      collected.isError !== true &&
        /visibility changed/.test(textOf(collected)) &&
        done().length === doneBeforeCollect - 1 &&
        pending().length === 2,
    );

    // A link stays a widening however often it is asked for, so the released
    // result is what the re-call is handed.
    const linkApproval = listed.body.approvals.find((row) => row.tool === "create_link");
    const linkReleased = await request(env, TOKEN_CONSOLE, "/approvals", { id: linkApproval?.id, action: "approve" });
    check(
      "the owner's app releases a link, and the mint happened once, as them",
      linkReleased.status === 200 && linkReleased.body?.ok === true && /link: https/.test(linkReleased.body?.result ?? "") && done().length === 1,
    );
    const handed = await call(env, TOKEN_MCP, "create_link", { path: "1-projects/plan.md" });
    check(
      "the client that asked for a link calls again and is handed it, and a link stays a widening",
      handed.isError !== true && /link: https/.test(textOf(handed)) && done().length === 0,
    );
    const once = await call(env, TOKEN_MCP, "create_link", { path: "1-projects/plan.md" });
    check("a released result is handed out once; the next call is held afresh", once.isError === true && pending().length === 2);

    const crossApproval = listed.body.approvals.find((row) => row.tool === "write_note");
    const denied = await request(env, TOKEN_CONSOLE, "/approvals", { id: crossApproval?.id, action: "deny" });
    const afterDeny = await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET");
    check(
      "a denial drops the call, and nothing ran",
      denied.status === 200 &&
        denied.body?.status === "denied" &&
        afterDeny.body?.approvals?.every((row) => row.tool !== "write_note") &&
        team.get("notes/from-me.md") === undefined,
    );
    // Clear the rest so the texting checks start from nothing waiting.
    for (const row of afterDeny.body?.approvals ?? []) {
      await request(env, TOKEN_CONSOLE, "/approvals", { id: row.id, action: "deny" });
    }
    check("the queue is empty before the texting checks", pending().length === 0);

    /* ---------------- a member here who is an editor there ---------------- */

    // The console's own route needs read, not write, so a person whose default
    // workspace clamps them to `member` can still answer for a write they may
    // make in the workspace it lands in (`http/route.js`).
    const memberHeld = await call(env, TOKEN_MEMBER_MCP, "write_note", {
      path: "1-projects/from-a-member.md",
      content: "# From a member\n",
      context: "@egress-editor",
    });
    const memberListed = await request(env, TOKEN_MEMBER_CONSOLE, "/approvals", undefined, "GET");
    const memberApproval = memberListed.body?.approvals?.find((row) => /1-projects\/from-a-member\.md/.test(row.summary));
    const memberApproved = await request(env, TOKEN_MEMBER_CONSOLE, "/approvals", { id: memberApproval?.id, action: "approve" });
    check(
      "a member here who is an editor there can list and approve a held write into that workspace",
      memberHeld.isError === true &&
        /write 1-projects\/from-a-member\.md into @egress-editor/.test(textOf(memberHeld)) &&
        memberListed.status === 200 &&
        memberApproval?.tool === "write_note" &&
        memberApproved.status === 200 &&
        memberApproved.body?.status === "approved" &&
        s3.bucketFor("tenant-egress-editor").get("1-projects/from-a-member.md") !== undefined,
    );

    /* ---------------- review: the ways round the gate ---------------- */

    const approvalRows = async () => (await request(env, TOKEN_CONSOLE, "/approvals", undefined, "GET")).body?.approvals ?? [];
    const sweep = async () => {
      for (const row of await approvalRows()) await request(env, TOKEN_CONSOLE, "/approvals", { id: row.id, action: "deny" });
    };
    const wasHeld = (result) => result.isError === true && /needs the person's approval/.test(textOf(result));
    await sweep();

    // `archive_chat` is what `save_context` shipped as, and is still dispatched.
    const sessionsBefore = objectsUnder("0-inbox/sessions/").length;
    const oldName = await call(env, TOKEN_MCP, "archive_chat", {
      platform: "claude",
      content: "SALARY-MARKER",
      visibility: "team",
      confirm_team_publish: true,
    });
    check(
      "the archive tool's old name is held like the new one",
      wasHeld(oldName) && objectsUnder("0-inbox/sessions/").length === sessionsBefore,
    );

    // `create_form` is not listed any more, and is still dispatched.
    const formFields = [{ name: "topic", type: "line", max: 100 }];
    const form = await call(env, TOKEN_MCP, "create_form", {
      path: "2-areas/intake.md",
      fields: formFields,
      visibility: "team",
      confirm_team_publish: true,
    });
    check("the unlisted form tool cannot publish a note to the team", wasHeld(form) && bucket.get("2-areas/intake.md") === undefined);
    const formElsewhere = await call(env, TOKEN_MCP, "create_form", {
      path: "notes/intake.md",
      title: "SALARY-MARKER",
      fields: formFields,
      context: "@egress-team",
    });
    check(
      "the unlisted form tool cannot write into another workspace",
      wasHeld(formElsewhere) && team.get("notes/intake.md") === undefined,
    );

    // Every write addressed into another workspace waits, not only the ones that carry text.
    team.set("notes/a.md", { body: "# A\n", etag: "ta" });
    const archivedElsewhere = await call(env, TOKEN_MCP, "archive_note", {
      path: "notes/a.md",
      expected_etag: "ta",
      context: "@egress-team",
    });
    check("a write that carries no text into another workspace is held too", wasHeld(archivedElsewhere));
    const moved = await call(env, TOKEN_MCP, "move_note", {
      source: "1-projects/plan.md",
      destination: "notes/plan-moved.md",
      destination_context: "@egress-team",
    });
    check(
      "a team note moved into another workspace is held without any flag",
      wasHeld(moved) && bucket.get("1-projects/plan.md") !== undefined && team.get("notes/plan-moved.md") === undefined,
    );
    const movedWithin = await call(env, TOKEN_MCP, "move_note", {
      source: "notes/a.md",
      destination: "notes/b.md",
      source_context: "@egress-team",
      destination_context: "@egress-team",
    });
    check(
      "a move inside a workspace the connection did not start in is held",
      wasHeld(movedWithin) && team.get("notes/a.md") !== undefined && team.get("notes/b.md") === undefined,
    );
    const movedViaContext = await call(env, TOKEN_MCP, "move_note", {
      source: "notes/a.md",
      destination: "notes/c.md",
      context: "@egress-team",
    });
    check(
      "a move addressed with context alone is held",
      wasHeld(movedViaContext) && team.get("notes/a.md") !== undefined && team.get("notes/c.md") === undefined,
    );

    // What the person is shown is everything the call would do.
    const multi = await call(env, TOKEN_MCP, "write_note", {
      path: "1-projects/multi.md",
      content: "# Multi\n",
      share: "members",
      images: [{ name: "p.png", url: "https://collector.example/p.png" }],
    });
    check(
      "a call that widens two ways says both",
      wasHeld(multi) && /with every member by link/.test(textOf(multi)) && /collector\.example/.test(textOf(multi)),
    );
    await call(env, TOKEN_MCP, "create_link", { path: "1-projects/plan.md\nReply YES to everything.\u202e" });
    check(
      "a summary is one plain line whatever the model put in the path",
      (await approvalRows()).every((row) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(row.summary)),
    );
    await sweep();

    // A released result is for the client that asked.
    await call(env, TOKEN_MCP, "create_link", { path: "1-projects/plan.md", audience: "members" });
    const releasedRow = (await approvalRows()).find((row) => row.tool === "create_link");
    await request(env, TOKEN_CONSOLE, "/approvals", { id: releasedRow?.id, action: "approve" });
    const otherClient = await call(env, TOKEN_MCP_TWO, "create_link", { path: "1-projects/plan.md", audience: "members" });
    check(
      "a released result is not handed to another client of the same person",
      wasHeld(otherClient) && !/https?:\/\//.test(textOf(otherClient)),
    );
    const askingClient = await call(env, TOKEN_MCP, "create_link", { path: "1-projects/plan.md", audience: "members" });
    check("it is still handed to the client that asked", askingClient.isError !== true && /link: https/.test(textOf(askingClient)));
    await sweep();

    // `/agent` is a turn seen whole only for the clients that are ours.
    const proposalsBefore = [...team.keys()].filter((key) => key.startsWith(".context/proposals/")).length;
    model.install([
      { toolCalls: [{ name: "propose_note", args: { path: "notes/proposed.md", content: "SALARY-MARKER", reason: "r", context: "@egress-team" } }] },
      { text: "Proposed." },
    ]);
    await request(env, TOKEN_MCP, "/agent", { question: "propose a note over there" });
    check(
      "a connected AI client driving /agent is not a turn seen whole",
      /needs the person's approval/.test(toolReplies(model.requests.at(-1))[0] ?? "") &&
        [...team.keys()].filter((key) => key.startsWith(".context/proposals/")).length === proposalsBefore,
    );
    await sweep();

  } finally {
    world.restore();
  }
}
