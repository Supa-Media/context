/**
 * A MOVE THAT PARTLY APPLIED IS A CHANGE, AND A CHANGE IS A ROW.
 *
 * CLAUDE.md: *"Audit records the acting identity, not just the scope."* The
 * point of the trail is that a person can account for what happened in their
 * own bucket, and this gateway already states the principle at a system path:
 * without an audit line for the capability re-probe, *"the owner would find
 * probe objects appearing and disappearing under `.context/` in a bucket they
 * are told they own, with nothing in their trail that accounts for it."*
 *
 * The batch doors break that, and only on the path where it matters most.
 * `move_notes` and `move_folder` copy every destination first and then retire
 * the sources one at a time. If a retire fails partway — a concurrent write
 * changes a source's etag, which any member with write access can cause — the
 * tool returns `partially applied`, and it returns **before `recordChange`**.
 * So the bucket has changed (every destination written, some sources gone) and
 * the trail says nothing happened at all.
 *
 * The single-note door is the contrast that makes this a defect rather than a
 * design: every post-mutation failure in `toolMoveNote` *rolls back* — it
 * deletes the destination it created and returns — so the bucket is unchanged
 * and no row is owed. The batch doors cannot roll back, and then do not record.
 *
 * Driven, not argued: the fixture lets the first source's conditional
 * tombstone through and races the second with a 412, which is exactly what a
 * concurrent writer produces.
 */

import worker from "../src/index.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { isLogicalDeleteMarker } from "../src/store/logicalDelete.js";

const S3_ENDPOINT = "https://s3.example-audit-partial.test";
const TOKEN_OWNER = `cat_auditpart_own_${"0".repeat(22)}`;
const TOKEN_TEAM = `cat_auditpart_team_${"0".repeat(21)}`;

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n  3-resources: team\n  2-areas: private\n\n" +
  "note_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function binding(bucket) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLEAP",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAP",
    forcePathStyle: true,
    capabilities: {
      conditionalWrite: true,
      conditionalCreate: true,
      // Verified write/create stores expose conditional retirement through the
      // logical-delete wrapper, even when the physical provider has DELETE.
      conditionalDelete: true,
      serverSideCopy: false,
    },
    status: "active",
  };
}

async function callTool(env, name, args = {}, token = TOKEN_OWNER) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return body?.result?.content?.[0]?.text || "";
}

export async function runAuditPartialMoveChecks(check) {
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();

  controlPlane.addWorkspace("ws_auditpart", "auditpart", binding("audit-partial"));
  await controlPlane.addGrant({
    accessToken: TOKEN_OWNER,
    workspaceId: "ws_auditpart",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_auditpart",
    userId: "user_auditpart",
  });
  // A team connection, for the half of this that is about who may READ the row
  // the fix adds. No `context:private`.
  await controlPlane.addGrant({
    accessToken: TOKEN_TEAM,
    workspaceId: "ws_auditpart",
    role: "member",
    scopes: ["context:read"],
    clientId: "mcp_client_auditpart_team",
    userId: "user_auditpart_team",
  });

  const bucket = s3.bucketFor("audit-partial");
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

  /*
    Refuse ONE conditional tombstone write, the second source's, exactly as a
    racing writer would: the etag it was copied under is no longer the etag on
    the key. Installed over the S3 fake's own fetch, the way the projection
    suite layers its counters.
  */
  const refuse = { key: null, seen: 0 };
  const beneath = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method || "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    if (
      refuse.key !== null &&
      refuse.seen === 0 &&
      method === "PUT" &&
      headers.get("content-type") === "application/x-context-logical-tombstone" &&
      url.startsWith(S3_ENDPOINT) &&
      decodeURIComponent(new URL(url).pathname).endsWith(refuse.key)
    ) {
      refuse.seen += 1;
      const current = s3.bucketFor("audit-partial").get(refuse.key);
      s3.bucketFor("audit-partial").set(refuse.key, {
        body: `${current?.body || ""}\nConcurrent edit\n`,
        etag: `${current?.etag || "race"}-edited`,
        contentType: current?.contentType,
      });
      return new Response("", { status: 412 });
    }
    return beneath(input, init);
  };

  /*
    A known etag per seeded note, because `move_notes` requires
    `expected_source_etag` on every applied move — a batch without one never
    opens the door at all, which is the vacuity this suite would otherwise
    measure instead of the audit row.
  */
  const etagOf = (path) => `seed-${path}`;
  const seed = (path, body) => bucket.set(path, { body, etag: etagOf(path) });
  const move = (source, destination) => ({
    source,
    destination,
    expected_source_etag: etagOf(source),
  });
  const auditKeys = () => [...bucket.keys()].filter((key) => key.startsWith(".context/audit/"));
  // The gateway puts the row as a JSON string; the fake keeps whatever it was
  // given, so read both shapes rather than assuming one.
  const bodyText = (body) =>
    typeof body === "string" ? body : new TextDecoder().decode(body);
  const auditRows = () =>
    auditKeys()
      .sort()
      .map((key) => JSON.parse(bodyText(bucket.get(key).body)));
  const since = (before) => auditRows().slice(before);

  try {
    seed("privacy.md", PRIVACY_MANIFEST);
    seed("1-projects/alpha.md", "# Alpha\n");
    seed("1-projects/beta.md", "# Beta\n");

    /* -- 1. the control: a batch that fully applies records one row --------- */
    const beforeWhole = auditRows().length;
    const whole = await callTool(env, "move_notes", {
      moves: [
        move("1-projects/alpha.md", "3-resources/alpha.md"),
        move("1-projects/beta.md", "3-resources/beta.md"),
      ],
    });
    check("a batch move that applies in full is reported as moved", /moved notes: 2/.test(whole));
    const wholeRows = since(beforeWhole).filter((row) => row.action === "move_notes");
    check("...and writes exactly one audit row", wholeRows.length === 1);
    check(
      "...naming the acting identity, not only the tier",
      wholeRows[0]?.actor_user_id === "user_auditpart" &&
        wholeRows[0]?.actor_client_id === "mcp_client_auditpart",
    );

    /* -- 2. the partial apply ---------------------------------------------- */
    seed("1-projects/gamma.md", "# Gamma\n");
    seed("1-projects/delta.md", "# Delta\n");
    refuse.key = "1-projects/delta.md";
    refuse.seen = 0;
    const beforePartial = auditRows().length;
    const partial = await callTool(env, "move_notes", {
      moves: [
        move("1-projects/gamma.md", "3-resources/gamma.md"),
        move("1-projects/delta.md", "3-resources/delta.md"),
      ],
    });
    refuse.key = null;
    check(
      "a batch whose source cleanup stops says so",
      /partially applied/.test(partial) && refuse.seen > 0,
    );
    // The bucket really did change: the first move completed, while the failed
    // second destination was rolled back. Tombstones remain physical protocol
    // records, so observe note visibility through the gateway and assert the
    // first source's exact marker separately.
    const gammaDestination = await callTool(env, "read_note", {
      path: "3-resources/gamma.md",
    });
    const deltaDestination = await callTool(env, "read_note", {
      path: "3-resources/delta.md",
    });
    check(
      "...and only the completed first move is visible after rollback",
      gammaDestination.includes("# Gamma") &&
        /not found/.test(deltaDestination) &&
        isLogicalDeleteMarker(bucket.get("1-projects/gamma.md")?.body) &&
        bucket.has("1-projects/delta.md"),
    );
    const partialRows = since(beforePartial).filter((row) => row.action === "move_notes");
    check("...and the change that happened is in the audit trail", partialRows.length === 1);
    check(
      "...marked partial, with what applied and what was planned",
      partialRows[0]?.details?.partial === true &&
        partialRows[0]?.details?.moved === 1 &&
        partialRows[0]?.details?.planned === 2 &&
        partialRows[0]?.details?.copies_without_source_removed === 0,
    );
    check(
      "...naming only the move that changed durable note paths",
      (partialRows[0]?.paths || []).includes("1-projects/gamma.md") &&
        (partialRows[0]?.paths || []).includes("3-resources/gamma.md") &&
        !(partialRows[0]?.paths || []).includes("1-projects/delta.md") &&
        !(partialRows[0]?.paths || []).includes("3-resources/delta.md"),
    );
    check(
      "...and the acting identity, which is the whole point of the row",
      partialRows[0]?.actor_user_id === "user_auditpart",
    );

    /* -- 3. the same door, one folder at a time ---------------------------- */
    seed("1-projects/team/one.md", "# One\n");
    seed("1-projects/team/two.md", "# Two\n");
    refuse.key = "1-projects/team/two.md";
    refuse.seen = 0;
    const beforeFolder = auditRows().length;
    const folder = await callTool(env, "move_folder", {
      source: "1-projects/team",
      destination: "3-resources/team",
    });
    refuse.key = null;
    check("a folder move whose cleanup stops says so", /partially applied/.test(folder));
    check(
      "...and the bucket changed",
      bucket.has("3-resources/team/one.md") &&
        isLogicalDeleteMarker(bucket.get("1-projects/team/one.md")?.body),
    );
    const folderRows = since(beforeFolder).filter((row) => row.action === "move_folder");
    check("...and there is a row for it", folderRows.length === 1);
    check(
      "...marked partial, with the acting identity",
      folderRows[0]?.details?.partial === true &&
        folderRows[0]?.actor_user_id === "user_auditpart",
    );

    /* -- 5. the row the fix adds is itself a disclosure surface ------------ */
    //
    // `list_changes` shows a team connection only the rows whose
    // `team_visible` was TRUE when they were written, and anything without the
    // flag fails closed. A new row that omitted the flag would be safe and
    // wrong in a quieter way — a partly-applied move of team notes would
    // vanish from the trail of the people it affected — and a new row that set
    // it carelessly would publish a private path. Both directions, measured.
    const teamSees = await callTool(env, "list_changes", { limit: 50 }, TOKEN_TEAM);
    check(
      "a team connection sees the partial move of team notes",
      teamSees.includes("3-resources/gamma.md"),
    );

    seed("1-projects/zeta.md", "# Zeta\n");
    seed("1-projects/eta.md", "# Eta\n");
    refuse.key = "1-projects/eta.md";
    refuse.seen = 0;
    await callTool(env, "move_notes", {
      moves: [
        move("1-projects/zeta.md", "2-areas/zeta.md"),
        move("1-projects/eta.md", "2-areas/eta.md"),
      ],
    });
    refuse.key = null;
    const afterPrivate = await callTool(env, "list_changes", { limit: 50 }, TOKEN_TEAM);
    check(
      "...and never the one whose destinations are private",
      !afterPrivate.includes("2-areas/zeta.md") && !afterPrivate.includes("2-areas/eta.md"),
    );
    check(
      "...while the owner sees both",
      (await callTool(env, "list_changes", { limit: 50 })).includes("2-areas/zeta.md"),
    );

    /* -- 6. the two standing rules about the trail itself ------------------ */
    //
    // Leakage, and integrity. Both are one line of code away from being false
    // and neither had a check of its own at this door.
    const SECRET_LINE = "quokka-ledger-0000-not-a-real-secret";
    await callTool(env, "write_note", {
      path: "1-projects/ledger.md",
      content: `# Ledger\n\n${SECRET_LINE}\n`,
      summary: "recorded the quarter",
    });
    const everyRow = JSON.stringify(auditRows());
    check(
      "no audit row carries the note's text — paths and counts, never content",
      !everyRow.includes(SECRET_LINE),
    );
    check(
      // The one caller-authored string that IS in the row, said out loud: the
      // summary is the client's own sentence for the activity feed, so it is
      // the caller's words rather than the note's, and it is bounded by the
      // same `team_visible` gate as everything else in the row.
      "...while the summary the caller wrote is there, which is what it is for",
      everyRow.includes("recorded the quarter"),
    );

    const intoTheTrail = await callTool(env, "write_note", {
      path: ".context/audit/2026-01-01T00-00-00-000Z-forged.json",
      content: "{}",
    });
    check("a caller cannot write into the audit prefix", /error|invalid|not allowed|refus/i.test(intoTheTrail));
    const viaTraversal = await callTool(env, "write_note", {
      path: "1-projects/../.context/audit/forged.json",
      content: "{}",
    });
    check("...nor reach it by traversing", /error|invalid|not allowed|refus/i.test(viaTraversal));
    check(
      "...and neither attempt landed an object there",
      !auditKeys().some((key) => key.includes("forged")),
    );

    /* -- 4. the contrast: a rollback owes no row --------------------------- */
    //
    // `move_notes` refuses a destination that already exists with different
    // content, before anything is written. Nothing changed, so nothing is
    // recorded — which is what makes the checks above about the CHANGE rather
    // than about "every error writes a row".
    seed("1-projects/epsilon.md", "# Epsilon\n");
    seed("3-resources/epsilon.md", "# Something else\n");
    const beforeRefused = auditRows().length;
    const refused = await callTool(env, "move_notes", {
      moves: [move("1-projects/epsilon.md", "3-resources/epsilon.md")],
    });
    check("a batch refused before it writes anything is an error", /conflict/.test(refused));
    check(
      "...and writes no audit row, because nothing changed",
      since(beforeRefused).filter((row) => row.action === "move_notes").length === 0,
    );
    check(
      "...and left the source where it was",
      bucket.has("1-projects/epsilon.md"),
    );
  } finally {
    globalThis.fetch = beneath;
    restoreControlPlane();
    restoreS3();
  }
}
