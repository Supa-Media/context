/**
 * One connection, several contexts — and the clamps that make that safe.
 *
 * A grant covers every context its person is a live member of, so a client
 * connected once can address a brain shared with its owner by passing
 * `context: "@name"` on a tool call. This suite is the half that says what that
 * must **not** buy, because reach and permission are different questions and
 * the widening only moved the first one.
 *
 * The arrangement is the one where a mistake actually leaks: two S3 tenants on
 * the same endpoint with adjacent bucket names, holding **identically named
 * notes**, one person who owns the first and is a plain `member` of the second,
 * and a third tenant they belong to not at all.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, with the counts as measured rather
 * than as expected:
 *
 * 1. **`sessionForContext` re-clamps the connection's already-clamped scopes**
 *    instead of the grant's own — 1 check failed, and it is the one the guest
 *    fixture exists for: a person who is a `member` where they connected lost
 *    the write they hold where they are an `editor`.
 * 2. **`sessionForContext` keeps the caller's `scope`** rather than re-reading
 *    the tier for the target's role — 2 checks failed, both of them a private
 *    note in somebody else's context reaching a member.
 * 3. **The binding answers with the session's default `workspaceId`** instead
 *    of the selected one — 8 checks failed, all on the gateway's "workspace
 *    mismatch" refusal, which is the direction that fault must fail in.
 * 4. **`sessionForContext` accepts a name outside the covered set**, forging an
 *    entry for it — only the two *shape* checks failed. The interesting half is
 *    why the rest did not: the control plane refuses to open a binding for a
 *    context that token's person is not a member of, so the gateway alone
 *    cannot reach one. Two-party, working.
 * 5. **The "present but unusable" guard is dropped**, so a `context` that is
 *    not a usable name falls through to the default — 6 checks failed, one per
 *    shape. That is the quiet version of writing into the wrong brain.
 *
 * 6. **`surveyOtherContexts` reads each front page at the caller's own
 *    clearance** rather than at the one the addressed context's role earns —
 *    1 check failed, and it is the one that matters: a note its owner kept
 *    private appeared in somebody else's orientation. (The first attempt at
 *    this sabotage passed a `scope` that is not in that function's scope at
 *    all, so it threw and both checks failed for the wrong reason. Worth
 *    recording: a sabotage that breaks the code rather than the invariant
 *    proves nothing.)
 * 7. **The fan-out bound is raised to 50** — 2 checks failed: seven contexts
 *    were opened and the tail that says the list is short went missing.
 *
 * One thing is asserted structurally rather than behaviourally, and the reason
 * is that sabotaging it changes nothing observable: **the `context` argument is
 * stripped before the tool sees the arguments.** No tool reads it today, so a
 * leak would be invisible until one did.
 */

import { readFile } from "node:fs/promises";

import worker from "../src/index.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-cross-context.test";

const TOKEN_OWNER = `cat_cross_owner_${"0".repeat(24)}`;
const TOKEN_EDITOR = `cat_cross_editor_${"0".repeat(24)}`;
/**
 * Somebody whose *home* context is the one they were invited into.
 *
 * They connected their client to a brain shared with them, so the grant's own
 * context is one they are only a `member` of — and they are an `editor`
 * somewhere else. This is the fixture that catches re-clamping an
 * already-clamped scope set: the intersection of two roles takes write away
 * from a context where they really have it, which fails closed and looks
 * exactly like a permission bug in the other direction.
 */
const TOKEN_GUEST = `cat_cross_guest_${"0".repeat(24)}`;
/** A grant that was never given write, anywhere. */
const TOKEN_READ_ONLY = `cat_cross_readonly_${"0".repeat(22)}`;
/** Somebody in more contexts than one orientation is willing to open. */
const TOKEN_MANY = `cat_cross_many_${"0".repeat(26)}`;

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * The same, with the front page published to the team.
 *
 * The scaffolded manifest starts everything private, `index.md` included — so a
 * context whose owner has not shared it shows a member no front page at all,
 * which is the correct answer and the boring one. This is the manifest of a
 * context whose owner did share it.
 */
const PRIVACY_MANIFEST_SHARED_INDEX =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  index.md: team\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function s3Binding(bucket, key) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`,
    secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`,
    forcePathStyle: true,
    capabilities: { conditionalWrite: true },
    status: "active",
  };
}

async function callTool(env, tokenValue, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return body?.result;
}

const textOf = (result) => result?.content?.[0]?.text || "";

/** The tool names one connection is offered. */
async function toolNamesFor(env, tokenValue) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    }),
    env,
    ctx
  );
  const names = (JSON.parse(await response.text())?.result?.tools || []).map((tool) => tool.name);
  await settle();
  return names;
}

export async function runCrossContextChecks(check) {
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();

  controlPlane.addWorkspace("ws_own", "mine", s3Binding("cross-mine", "AA"));
  controlPlane.addWorkspace("ws_shared", "theirs", s3Binding("cross-theirs", "BB"));
  controlPlane.addWorkspace("ws_stranger", "stranger", s3Binding("cross-stranger", "CC"));
  // A context this person is a member of whose owner never shared its front
  // page — the common case for a freshly scaffolded brain.
  controlPlane.addWorkspace("ws_quiet", "quiet", s3Binding("cross-quiet", "DD"));
  // Seven more, all pointing at one bucket: this test is about how many
  // contexts orientation opens, not about what is in them.
  for (let n = 1; n <= 7; n += 1) {
    controlPlane.addWorkspace(`ws_extra_${n}`, `extra-${n}`, s3Binding("cross-extra", "EE"));
  }

  // One person, two memberships: owner of their own brain, plain `member` of
  // somebody else's. The third context exists and is nothing to do with them.
  await controlPlane.addGrant({
    accessToken: TOKEN_OWNER,
    workspaceId: "ws_own",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_cross",
    userId: "user_cross",
    alsoMemberOf: [
      { workspaceId: "ws_shared", role: "member" },
      { workspaceId: "ws_quiet", role: "member" },
    ],
  });
  // The same shape one rung up, for the write half.
  await controlPlane.addGrant({
    accessToken: TOKEN_EDITOR,
    workspaceId: "ws_own",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_cross_editor",
    userId: "user_cross_editor",
    alsoMemberOf: [{ workspaceId: "ws_shared", role: "editor" }],
  });
  // A stranger to `user_cross` is not a stranger to everybody: this person is
  // an editor there, and a plain member of the context they connected from.
  await controlPlane.addGrant({
    accessToken: TOKEN_GUEST,
    workspaceId: "ws_shared",
    role: "member",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_cross_guest",
    userId: "user_cross_guest",
    alsoMemberOf: [{ workspaceId: "ws_stranger", role: "editor" }],
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_READ_ONLY,
    workspaceId: "ws_own",
    role: "owner",
    scopes: ["context:read"],
    clientId: "mcp_client_cross_readonly",
    userId: "user_cross",
    alsoMemberOf: [{ workspaceId: "ws_shared", role: "member" }],
  });

  // Somebody in more contexts than one orientation opens.
  const EXTRA = Array.from({ length: 7 }, (_, n) => ({
    workspaceId: `ws_extra_${n + 1}`,
    role: "member",
  }));
  await controlPlane.addGrant({
    accessToken: TOKEN_MANY,
    workspaceId: "ws_own",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_cross_many",
    userId: "user_cross_many",
    alsoMemberOf: EXTRA,
  });

  const mine = s3.bucketFor("cross-mine");
  const theirs = s3.bucketFor("cross-theirs");
  const stranger = s3.bucketFor("cross-stranger");
  mine.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "m0" });
  mine.set("index.md", { body: "MINE-INDEX-MARKER", etag: "mi" });
  mine.set("1-projects/shared-name.md", { body: "MINE-MARKER", etag: "m1" });
  theirs.set("privacy.md", { body: PRIVACY_MANIFEST_SHARED_INDEX, etag: "t0" });
  theirs.set("index.md", { body: "THEIRS-INDEX-MARKER", etag: "ti" });
  theirs.set("1-projects/shared-name.md", { body: "THEIRS-MARKER", etag: "t1" });
  theirs.set("2-areas/kept-private.md", { body: "THEIRS-PRIVATE-MARKER", etag: "t2" });
  // A plugin in somebody else's brain. `.obsidian/` sits outside the privacy
  // manifest's reach entirely — `isPlumbing` hides it from `read_note`,
  // `list_notes` and search for every role — so `list_plugins` is the only read
  // path into it, and the question is who may take it.
  theirs.set(
    ".obsidian/plugins/theirs-only/manifest.json",
    {
      body: JSON.stringify({
        id: "theirs-only",
        name: "THEIRS-PLUGIN-MARKER",
        version: "1.0.0",
        author: "their-owner",
      }),
      etag: "tp0",
    }
  );

  const quiet = s3.bucketFor("cross-quiet");
  quiet.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "q0" });
  quiet.set("index.md", { body: "QUIET-PRIVATE-INDEX-MARKER", etag: "q1" });
  const extra = s3.bucketFor("cross-extra");
  extra.set("privacy.md", { body: PRIVACY_MANIFEST_SHARED_INDEX, etag: "e0" });
  extra.set("index.md", { body: "EXTRA-INDEX-MARKER", etag: "e1" });
  stranger.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "s0" });
  stranger.set("1-projects/shared-name.md", { body: "STRANGER-MARKER", etag: "s1" });

  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
  };

  /* ------------------------- reach, which is the feature ------------------- */

  const here = textOf(await callTool(env, TOKEN_OWNER, "read_note", { path: "1-projects/shared-name.md" }));
  check("with no context named, a call still acts on the connection's own", here.includes("MINE-MARKER"));

  const there = textOf(
    await callTool(env, TOKEN_OWNER, "read_note", {
      path: "1-projects/shared-name.md",
      context: "@theirs",
    })
  );
  check("a note in a context shared with this person is readable by name", there.includes("THEIRS-MARKER"));
  check("and it is that context's file, not the identically named one here", !there.includes("MINE-MARKER"));

  const bare = textOf(
    await callTool(env, TOKEN_OWNER, "read_note", {
      path: "1-projects/shared-name.md",
      context: "theirs",
    })
  );
  check("the @ is decoration, as it is in the URL form", bare.includes("THEIRS-MARKER"));

  const listed = textOf(await callTool(env, TOKEN_OWNER, "list_notes", { context: "@theirs" }));
  check("a listing is the addressed context's", listed.includes("1-projects/shared-name.md"));

  /* ------------------- permission, which did not widen with it ------------- */

  check(
    "a member does not see the other context's private notes",
    !textOf(await callTool(env, TOKEN_OWNER, "list_notes", { context: "@theirs" })).includes(
      "kept-private"
    )
  );
  check(
    "and cannot read one by naming it",
    !textOf(
      await callTool(env, TOKEN_OWNER, "read_note", {
        path: "2-areas/kept-private.md",
        context: "@theirs",
      })
    ).includes("THEIRS-PRIVATE-MARKER")
  );
  check(
    "while the same connection still reads its own private notes",
    !textOf(await callTool(env, TOKEN_OWNER, "list_notes")).includes("THEIRS")
  );

  const refusedWrite = textOf(
    await callTool(env, TOKEN_OWNER, "write_note", {
      path: "1-projects/intruder.md",
      content: "should never be written",
      context: "@theirs",
    })
  );
  check("a member's write into somebody else's brain is refused", /permission denied/i.test(refusedWrite));
  check("and names the context it was refused in", refusedWrite.includes("@theirs"));
  check(
    "and nothing was written",
    !theirs.has("1-projects/intruder.md")
  );

  const allowedWrite = await callTool(env, TOKEN_EDITOR, "write_note", {
    path: "1-projects/from-an-editor.md",
    content: "an editor may write here",
    context: "@theirs",
  });
  check("an editor's write into the same context lands", theirs.has("1-projects/from-an-editor.md"));
  check("and it landed in that bucket rather than this one", !mine.has("1-projects/from-an-editor.md"));
  check("and the tool reported it rather than a refusal", !/permission denied/i.test(textOf(allowedWrite)));

  /*
    The clamp is against the *target's* role, from the grant's own scopes —
    never against what the connection's own context already narrowed them to.
    This person is a `member` where they connected and an `editor` where they
    are writing, so an implementation that re-clamps an already-clamped set
    intersects the two roles and refuses a write they genuinely have.
  */
  const guestWrite = await callTool(env, TOKEN_GUEST, "write_note", {
    path: "1-projects/from-a-guest.md",
    content: "an editor there, a member here",
    context: "@stranger",
  });
  check(
    "a member here who is an editor there may write there",
    stranger.has("1-projects/from-a-guest.md") && !/permission denied/i.test(textOf(guestWrite))
  );
  const guestRefusedHere = textOf(
    await callTool(env, TOKEN_GUEST, "write_note", {
      path: "1-projects/from-a-guest-here.md",
      content: "should never be written",
    })
  );
  check(
    "and is still refused a write in the context they connected from",
    /permission denied/i.test(guestRefusedHere) && !theirs.has("1-projects/from-a-guest-here.md")
  );
  check(
    "and that refusal names the role rather than telling them to reconnect",
    guestRefusedHere.includes("@theirs") && !/Reconnect the client/i.test(guestRefusedHere)
  );

  /* --------------------- a context this person does not have --------------- */

  const strangerRefusal = textOf(
    await callTool(env, TOKEN_OWNER, "read_note", {
      path: "1-projects/shared-name.md",
      context: "@stranger",
    })
  );
  const inventedRefusal = textOf(
    await callTool(env, TOKEN_OWNER, "read_note", {
      path: "1-projects/shared-name.md",
      context: "@no-such-context-anywhere",
    })
  );
  check("a context this person is not in is refused", !strangerRefusal.includes("STRANGER-MARKER"));
  check(
    "and refused identically to a name nobody has registered",
    strangerRefusal === inventedRefusal && strangerRefusal.length > 0
  );
  check(
    "a malformed name is the same refusal again, with no round trip to spend",
    textOf(
      await callTool(env, TOKEN_OWNER, "read_note", {
        path: "1-projects/shared-name.md",
        context: "@not a slug",
      })
    ) === inventedRefusal
  );
  check(
    "and so is a route name, which the URL form also refuses",
    textOf(
      await callTool(env, TOKEN_OWNER, "read_note", {
        path: "1-projects/shared-name.md",
        context: "@oauth",
      })
    ) === inventedRefusal
  );

  /*
    An argument that is present and unusable is refused rather than ignored. A
    client that sent `context: 123` meant somewhere else and failed to say
    where; serving the default is the quiet version of writing into the wrong
    brain, which is the whole failure this feature is built around.
  */
  for (const nonsense of [123, "", "   ", { slug: "theirs" }, ["theirs"], true]) {
    const answer = textOf(
      await callTool(env, TOKEN_OWNER, "read_note", {
        path: "1-projects/shared-name.md",
        context: nonsense,
      })
    );
    check(
      `a context of ${JSON.stringify(nonsense)} is refused rather than falling through to here`,
      !answer.includes("MINE-MARKER") && answer === inventedRefusal
    );
  }

  /* ------------------------------ orientation ------------------------------ */

  const orientation = textOf(await callTool(env, TOKEN_OWNER, "orient"));
  check("orientation names the other contexts this connection reaches", orientation.includes("@theirs"));
  check("and says how to address them", orientation.includes("`context`"));
  check("and does not name a context this person is not in", !orientation.includes("@stranger"));
  check(
    "and does not list the context it is orienting in as somewhere else to go",
    !orientation.includes("### @mine")
  );

  /*
    The front page of each of them, which is what makes the list worth having.
    A name an agent cannot judge is a name it never follows; `index.md` is the
    one file that says what a context is for.
  */
  check("orientation reads the other context's front page", orientation.includes("THEIRS-INDEX-MARKER"));
  check(
    "a front page its owner has not shared is absent, and said to be",
    !orientation.includes("QUIET-PRIVATE-INDEX-MARKER") &&
      orientation.includes("@quiet") &&
      orientation.includes("No front page visible to you there yet")
  );

  /*
    And the bound. Each context costs a control-plane round trip and two reads,
    so a person in a dozen would otherwise turn orientation into the subrequest
    failure it exists to answer. Past the cap they are still named — a name is
    free — and the sentence says the list is short rather than letting it read
    as complete.
  */
  const manyOrientation = textOf(await callTool(env, TOKEN_MANY, "orient"));
  const headingCount = manyOrientation.split("### @extra-").length - 1;
  check(
    `orientation opens at most six other contexts (opened ${headingCount})`,
    headingCount === 6
  );
  check(
    "and names the seventh rather than dropping it",
    manyOrientation.includes("Also reachable, not read here") &&
      /@extra-[1-7]/.test(manyOrientation.split("Also reachable, not read here")[1] || "")
  );

  /*
    THE TAIL NAMES WHAT WAS CAPPED, AND NOTHING ELSE.

    Its documented job is "past the cap they are still named". An orient that
    was itself addressed into another context gets no `openContext` — the
    no-chaining rule — so `readable` is empty, and `others.slice(0)` made the
    tail every sibling while the body was already listing every sibling as
    bullets. Both halves of the section, over the same names.

    Nothing was capped there, so the tail has nothing to add and should be
    absent. Measured before the fix: `@home`, `@broken-manifest` and
    `@no-storage` each appeared twice in one section.
  */
  const addressed = textOf(
    await callTool(env, TOKEN_OWNER, "orient", { context: "@theirs" })
  );
  check(
    "an addressed orient still names the siblings it cannot open",
    addressed.includes("@mine")
  );
  check(
    "and does not also list them under the capped tail",
    !addressed.includes("Also reachable, not read here")
  );

  /*
    Connect time, which is the surface that reaches a model before it has
    decided anything. An agent will not go looking for a second context, so the
    handshake says there is one — and says it without opening a bucket, since
    these are names the session already carried.
  */
  const { ctx: handshakeCtx, settle: settleHandshake } = createWorkerCtx();
  const handshake = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN_OWNER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      }),
    }),
    env,
    handshakeCtx
  );
  const instructions = JSON.parse(await handshake.text())?.result?.instructions || "";
  await settleHandshake();
  check("the handshake says another context is reachable", instructions.includes("@theirs"));
  check("and names the argument that reaches it", instructions.includes("`context`"));
  check("and still names no context this person is not in", !instructions.includes("@stranger"));

  const orientedThere = textOf(await callTool(env, TOKEN_OWNER, "orient", { context: "@theirs" }));
  check(
    "orienting into another context surveys that one",
    orientedThere.includes("1-projects") && !orientedThere.includes("MINE-MARKER")
  );
  check(
    "and names the rest without opening them — one call opens one context, never a chain",
    orientedThere.includes("@mine") && !orientedThere.includes("MINE-INDEX-MARKER")
  );

  /* --------------------- the same answer in the modern era ----------------- */

  /*
    Authority is decided once, never per protocol era, and cross-context reach
    is authority. Both eras call `callToolForSession`, so this is one assertion
    rather than a second suite — but it is the assertion that says so, and the
    era that added a header would otherwise be the era that routes differently.
  */
  const { ctx: modernCtx, settle: settleModern } = createWorkerCtx();
  const modern = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN_OWNER}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "read_note",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "read_note",
          arguments: { path: "1-projects/shared-name.md", context: "@theirs" },
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      }),
    }),
    env,
    modernCtx
  );
  const modernText = JSON.parse(await modern.text())?.result?.content?.[0]?.text || "";
  await settleModern();
  check("a modern-era call addresses the same context the legacy one does", modernText.includes("THEIRS-MARKER"));
  check(
    "and a modern-era write is refused by the same role clamp",
    /permission denied/i.test(
      (
        await (async () => {
          const { ctx: c, settle: s } = createWorkerCtx();
          const response = await worker.fetch(
            new Request("https://mcp.context.test/mcp", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${TOKEN_OWNER}`,
                "Content-Type": "application/json",
                "MCP-Protocol-Version": "2026-07-28",
                "Mcp-Method": "tools/call",
                "Mcp-Name": "write_note",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 8,
                method: "tools/call",
                params: {
                  name: "write_note",
                  arguments: {
                    path: "1-projects/modern-intruder.md",
                    content: "should never be written",
                    context: "@theirs",
                  },
                  _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
                },
              }),
            }),
            env,
            c
          );
          const text = JSON.parse(await response.text())?.result?.content?.[0]?.text || "";
          await s();
          return text;
        })()
      )
    ) && !theirs.has("1-projects/modern-intruder.md")
  );

  /* ---------------------- the argument is not a tool input ----------------- */

  // `context` addresses the call and is never an input. No tool reads it today,
  // so no behaviour changes if it leaks through — which is exactly why this is
  // asserted where it is decided. Read off disk rather than fetched: `fetch` is
  // the stub's, and a suite that asks its own fixtures about the source is
  // asking the wrong thing.
  check(
    "the addressing argument is stripped before the tool sees the arguments",
    /delete args\.context;/.test(
      await readFile(new URL("../src/index.js", import.meta.url), "utf8")
    )
  );

  /* -------------------------- the tools advertise it ----------------------- */

  const { ctx, settle } = createWorkerCtx();
  const listResponse = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN_OWNER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    }),
    env,
    ctx
  );
  const tools = JSON.parse(await listResponse.text())?.result?.tools || [];
  await settle();
  const addressable = tools.filter((tool) => tool.inputSchema?.properties?.context);
  check("every tool but the two foreign-contract ones advertises the argument", addressable.length === tools.length - 2);
  check(
    "and the two that do not are ChatGPT's search and fetch",
    tools
      .filter((tool) => !tool.inputSchema?.properties?.context)
      .map((tool) => tool.name)
      .sort()
      .join(",") === "fetch,search"
  );
  check(
    "orient advertises it too, since orientation is per context",
    Boolean(tools.find((tool) => tool.name === "orient")?.inputSchema?.properties?.context)
  );

  /*
    The listing follows the connection, not the context it happens to be in.

    This person is a `member` where they connected and an `editor` elsewhere. A
    listing filtered by the current context would show them no write tools at
    all — and an agent cannot ask for a tool it was never told about, so the
    capability would be gone rather than merely refused in one place. Compare
    with a grant that genuinely holds no write scope, where hiding them is
    right.
  */
  const guestTools = await toolNamesFor(env, TOKEN_GUEST);
  check("a connection that can write somewhere is offered the write tools", guestTools.includes("write_note"));
  const readOnlyTools = await toolNamesFor(env, TOKEN_READ_ONLY);
  check(
    "a connection whose grant holds no write scope is not",
    !readOnlyTools.includes("write_note") && readOnlyTools.includes("read_note")
  );

  /*
    `.obsidian/` IS THE OWNER'S, AND `list_plugins` WAS THE ONE DOOR WITHOUT A
    LOCK ON IT.

    `isPlumbing` hides every dot-segment from `read_note`, `list_notes` and
    search — for every role, including the owner's. So this prefix has exactly
    one read path, and it was offered to any grant holding `context:read`,
    because `toolListPlugins` took the store and not the scope.

    `TOKEN_READ_ONLY` is the owner of `@mine` and a plain `member` of `@theirs`.
    Addressing `@theirs`, the same call that returns `not found` from
    `read_note` on any `.obsidian/` key was returning that owner's whole plugin
    inventory: every plugin's id, name, version and author, which blocked
    internals each bundle names, and up to twelve hostnames pulled out of the
    bundle text — internal endpoints included.

    The repo decided this class once already and in the other direction: the
    note census is owner-only precisely because it is a count taken over what a
    member cannot see, and this both counts and then enumerates. #201 widened
    who can ask, by making one connection reach every context its person
    belongs to.
  */
  const memberPlugins = textOf(
    await callTool(env, TOKEN_READ_ONLY, "list_plugins", { context: "@theirs" })
  );
  check(
    "a member cannot read the plugin inventory of somebody else's context",
    !memberPlugins.includes("THEIRS-PLUGIN-MARKER")
  );
  check(
    "and is not offered the tool at all",
    !readOnlyTools.includes("list_plugins")
  );

  const ownerPlugins = textOf(await callTool(env, TOKEN_OWNER, "list_plugins", {}));
  check(
    "while the owner of a context still reads its own",
    !ownerPlugins.includes("no access") && !ownerPlugins.includes("unknown tool")
  );

  /*
    THE STORE-IDENTITY CHECK FAILS CLOSED ON A MISSING FIELD.

    `storeForSession` compares the binding's own `workspaceId` against the one
    this request resolved to, and its comment calls a disagreement about which
    tenant this is "the one bug that must never be papered over". The comparison
    was guarded by `typeof binding.workspaceId === "string"`, so a control plane
    that stopped sending the field skipped the check rather than failing it.

    That was defensible while a grant covered one context: the field confirmed
    something the grant had already fixed. It is not defensible now. This is the
    gateway's only local confirmation of *which of N* covered contexts the store
    it just built belongs to, and a check that a missing field turns off is a
    check an upstream change can remove without touching this file.

    Measured before the fix, with the stub handing back the wrong context's
    binding: with the field present, 13 checks fail and every cross-context call
    is refused; with it omitted, 9 fail and all nine are *content* assertions —
    "it is that context's file", "it landed in that bucket rather than this one".
    The guard never fired.
  */
  /*
    `1-projects/shared-name.md` exists in both buckets with different bodies,
    which is what makes this readable as a cross-wiring probe rather than as a
    refusal that could have come from anywhere: MINE-MARKER coming back for
    `@theirs` is the store belonging to the wrong tenant.
  */
  const readTheirs = async () =>
    textOf(
      await callTool(env, TOKEN_OWNER, "read_note", {
        context: "@theirs",
        path: "1-projects/shared-name.md",
      })
    );

  // The control plane has resolved the WRONG tenant. This is the only shape in
  // which the identity check does any work; a test of that check that does not
  // set this watches a correct binding go past and calls it a pass. (It did:
  // the first version of this test passed against the fail-open guard.)
  controlPlane.flags.bindingWorkspaceId = "ws_own";

  controlPlane.flags.omitBindingWorkspaceId = false;
  const wrongWithId = await readTheirs();
  check(
    "a binding for the wrong workspace is refused when it names itself",
    !wrongWithId.includes("MINE-MARKER")
  );

  controlPlane.flags.omitBindingWorkspaceId = true;
  const wrongWithoutId = await readTheirs();
  check(
    "and refused just the same when it names nothing at all",
    !wrongWithoutId.includes("MINE-MARKER")
  );

  /*
    AND THE REFUSAL DOES NOT NAME THE GATEWAY'S OWN REASON.

    `StorageUnavailable`'s doc comment says `reason` "is for this gateway's own
    structured logs. It never reaches a caller: `index.js` answers every one of
    these with the same 503." The cross-context tool path interpolated
    `error.message`, which is `storage unavailable: ${reason}` — the doubled
    phrase in the output was the tell.

    `workspace mismatch` is the reason that matters: it is the two-party
    disagreement signal, exactly what somebody probing for a tenancy bug would
    poll for. The others are plumbing state a member has no business reading —
    `no proof of authorization`, `refresh token in binding`,
    `cross-provider credential`, `binding not allowed`, `unknown provider`.
  */
  // Field back, wrong workspace still served: the refusal now happens on the
  // cross-context hop, where `callToolForSession` catches it, rather than at
  // session setup, where the whole request 503s before any tool runs.
  controlPlane.flags.omitBindingWorkspaceId = false;
  const mismatched = await readTheirs();
  check(
    "a storage refusal does not name the gateway's internal reason",
    !mismatched.includes("workspace mismatch") && !mismatched.includes("storage unavailable")
  );
  check(
    "and still says the one thing the person can act on",
    /no reachable storage/i.test(mismatched)
  );

  controlPlane.flags.bindingWorkspaceId = null;
  controlPlane.flags.omitBindingWorkspaceId = false;
  check("and the right binding still serves its own context", (await readTheirs()).includes("THEIRS-MARKER"));

  restoreControlPlane();
  restoreS3();
}
