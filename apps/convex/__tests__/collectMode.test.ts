/**
 * COLLECT MODE — the first write in this product with no account behind it.
 *
 * Every other write resolves a grant or a session to a person with a handle.
 * This one takes an answer through a URL its owner published, from a stranger
 * who will never have an account. So the tests are about the narrowing rather
 * than the happy path, and they vary the one dimension the rest of the share
 * fixtures hold constant: **who the caller is**.
 *
 *  1. **It fails closed.** No secret configured, a challenge that did not
 *     pass, and a verifier that could not be reached all refuse. A route whose
 *     defence disappears when its key goes missing is a route with no defence.
 *  2. **One refusal for everything about the link.** Unknown, revoked, a read
 *     link, a folder link, a members link: one sentence, so a stranger cannot
 *     tell a link that was taken back from one that never existed.
 *  3. **What it writes cannot authorise anything.** The stamp is the link, it
 *     is not a handle, and no stranger can act on another stranger's answer
 *     through it — the collision #748 closed for `by: null`, which is this
 *     one with a different constant.
 *  4. **It serves one note.** Not the note's links, which every read link
 *     gets — because the note a form sits on is exactly the note whose links
 *     most often include the answers file it collects into.
 *  5. **A context that stopped taking writes stops taking these.**
 */

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { MANAGED_BUCKET_PREFIX } from "../functions/lib/managedStorage";
import { TURNSTILE_SECRET_ENV_VAR } from "../functions/lib/turnstile";
import { isLinkStamp, linkStamp } from "../functions/lib/formOps";
import { validateName } from "../functions/lib/names";
import { collectCapFrom } from "../functions/lib/collectLimits";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[TURNSTILE_SECRET_ENV_VAR];
});

const FORM_NOTE = "1-projects/intake/overview.md";
const RESPONSES = "1-projects/intake/overview-responses.md";
const LINKED = "1-projects/intake/rates.md";

const FORM_BODY = [
  "# New project intake",
  "",
  "What I need before a first call. See [the rates](rates.md).",
  "",
  "```form",
  "id: intake",
  `responses: ${RESPONSES}`,
  "layout: table",
  "submit: member",
  "edit_own: true",
  "votes: off",
  "fields:",
  "  - { name: who, type: line, max: 120, required: true }",
  "  - { name: brief, type: text, max: 2000 }",
  "```",
  "",
].join("\n");

const EDITOR_ONLY_NOTE = "1-projects/intake/staff.md";
const EDITOR_ONLY_BODY = [
  "# Staff only",
  "",
  "```form",
  "id: staff",
  "responses: 1-projects/intake/staff-responses.md",
  "layout: table",
  "submit: editor",
  "votes: off",
  "fields:",
  "  - { name: note, type: line, max: 80 }",
  "```",
  "",
].join("\n");

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  member: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
  /** What the stubbed Turnstile endpoint answers next. */
  challenge: { verdict: "pass" | "fail" | "down"; calls: number };
}

/**
 * The S3 stub, with Cloudflare's verify endpoint answered beside it.
 *
 * One `fetch` stub for both, because the action reaches for the global and a
 * second stub would replace the first. The verdict is a knob rather than a
 * fixed answer: the three outcomes this route must refuse on are the point.
 */
function stubFetch(backend: MemoryS3, challenge: Fixture["challenge"]) {
  const s3 = backend.fetchImpl;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://challenges.cloudflare.com/")) {
      challenge.calls += 1;
      if (challenge.verdict === "down") throw new Error("network");
      return new Response(JSON.stringify({ success: challenge.verdict === "pass" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return await (s3 as (i: RequestInfo | URL, x?: RequestInit) => Promise<Response>)(input, init);
  };
}

async function fixture(options: { managed?: boolean } = {}): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const member = await createUser(t, "member@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "seyi");
  // A personal context, so the member has a username to be recorded under —
  // without one `formActor` refuses before any of this file's rules run.
  await createWorkspace(t, member, "dan");
  await t.run(async (ctx) => {
    await ctx.db.insert("workspaceMembers", {
      workspaceId,
      userId: member,
      role: "member" as const,
      joinedAt: Date.now(),
    });
  });

  const bucket = options.managed
    ? `${MANAGED_BUCKET_PREFIX}${String(workspaceId)}`
    : FAKE_STORAGE.bucket;
  const backend = memoryS3(bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  // `FORM_NOTE` is deliberately NOT seeded: the author's own `writeNote` is
  // what creates the empty answers file, and seeding it into the bucket would
  // skip the step the feature depends on.
  backend.seed(EDITOR_ONLY_NOTE, EDITOR_ONLY_BODY);
  backend.seed(LINKED, "# Rates\n\nThe numbers.\n");

  const challenge: Fixture["challenge"] = { verdict: "pass", calls: 0 };
  vi.stubGlobal("fetch", stubFetch(backend, challenge));

  const encryptedSecretAccessKey = await encryptSecret(
    FAKE_STORAGE.secretAccessKey,
    requireKeyset(),
    { workspaceId },
  );
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "1-projects",
    visibility: "team",
  });
  // The author's own save is what creates the empty answers file.
  await asUser(t, owner).action(api.functions.files.writeNote, {
    workspaceId,
    path: FORM_NOTE,
    text: FORM_BODY,
  });

  process.env[TURNSTILE_SECRET_ENV_VAR] = "test-secret-not-a-real-key";
  return { t, owner, member, workspaceId, backend, challenge };
}

/** Mint a link over `path`, in `mode`. */
async function link(
  f: Fixture,
  mode: "read" | "collect",
  path: string = FORM_NOTE,
): Promise<{ token: string; shareId: Id<"noteShares"> }> {
  const { token } = await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
    workspaceId: f.workspaceId,
    path,
    mode,
  });
  const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
    workspaceId: f.workspaceId,
  });
  const row = rows.find((candidate) => candidate.token === token);
  return { token, shareId: row!.shareId };
}

/** Answer the form as a stranger with no session at all. */
function answer(
  f: Fixture,
  token: string,
  values: { field: string; value: string }[] = [{ field: "who", value: "Jordan" }],
) {
  return f.t.action(api.functions.collect.submitThroughLink, {
    token,
    values,
    challenge: "widget-token",
  });
}

/** What the answers file holds now. */
async function responsesFile(f: Fixture): Promise<string> {
  const file = await asUser(f.t, f.owner).action(api.functions.files.readNote, {
    workspaceId: f.workspaceId,
    path: RESPONSES,
  });
  return (file as { text: string }).text;
}

/* ------------------------------ failing closed ---------------------------- */

describe("the human check", () => {
  test("an answer lands when the challenge passes", async () => {
    const f = await fixture();
    const { token } = await link(f, "collect");
    await answer(f, token);
    expect(f.challenge.calls).toBe(1);
  });

  test("with no secret configured, the answer is refused", async () => {
    const f = await fixture();
    delete process.env[TURNSTILE_SECRET_ENV_VAR];
    const { token } = await link(f, "collect");

    const failure = await captureError(() => answer(f, token));
    expect(errorCode(failure)).toBe("CHALLENGE_REFUSED");
    // Not a crash, and not a silent acceptance. Cloudflare is never called.
    expect(f.challenge.calls).toBe(0);
  });

  test("a challenge that did not pass is refused", async () => {
    const f = await fixture();
    f.challenge.verdict = "fail";
    const { token } = await link(f, "collect");
    expect(errorCode(await captureError(() => answer(f, token)))).toBe("CHALLENGE_REFUSED");
  });

  test("a verifier that cannot be reached is refused, not waved through", async () => {
    const f = await fixture();
    f.challenge.verdict = "down";
    const { token } = await link(f, "collect");
    expect(errorCode(await captureError(() => answer(f, token)))).toBe("CHALLENGE_REFUSED");
  });
});

/* --------------------------- one refusal for the link --------------------- */

describe("what the link has to be", () => {
  test("a read link does not collect", async () => {
    const f = await fixture();
    const { token } = await link(f, "read");
    expect(errorCode(await captureError(() => answer(f, token)))).toBe("LINK_NOT_COLLECTING");
  });

  test("a revoked collect link, an unknown token and a read link refuse identically", async () => {
    const f = await fixture();
    const collect = await link(f, "collect");
    const read = await link(f, "read", EDITOR_ONLY_NOTE);

    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId: collect.shareId,
    });

    const revoked = await captureError(() => answer(f, collect.token));
    const unknown = await captureError(() => answer(f, "a".repeat(64)));
    const readLink = await captureError(() => answer(f, read.token));

    expect(JSON.stringify(revoked)).toBe(JSON.stringify(unknown));
    expect(JSON.stringify(revoked)).toBe(JSON.stringify(readLink));
  });

  test("a members-only link cannot collect, whatever its mode says", async () => {
    // `createTeamShare` is the members door, and it takes no mode at all —
    // proven by writing one onto the row directly, which is the only way this
    // state can exist.
    const f = await fixture();
    const { token } = await asUser(f.t, f.owner).mutation(
      api.functions.shares.createTeamShare,
      { workspaceId: f.workspaceId, path: FORM_NOTE },
    );
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      await ctx.db.patch(row!._id, { mode: "collect" });
    });
    expect(errorCode(await captureError(() => answer(f, token)))).toBe("LINK_NOT_COLLECTING");
  });

  test("a folder cannot collect, and the owner is told at the mint", async () => {
    // Said twice on purpose. `collectTarget` refuses a folder row because that
    // is what an already-written row has to be judged by; the mint refuses it
    // as well so the answer is "a folder cannot collect" rather than a link
    // that looks minted and turns every stranger away.
    const f = await fixture();
    const failure = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
        workspaceId: f.workspaceId,
        path: "1-projects/intake",
        kind: "folder" as const,
        mode: "collect" as const,
      }),
    );
    expect(errorCode(failure)).toBe("COLLECT_NEEDS_A_NOTE");

    // And nothing was minted — a refusal that left a live row behind would be
    // the worse half of both answers.
    const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    expect(rows.length).toBe(0);
  });

  test("and pressing Copy link on a live folder link is untouched by that", async () => {
    // The re-mint path: no mode named, so the refusal above must not fire on
    // it. This is the case `linkShareKind` exists for, and the one a naive
    // `kind === "folder"` refusal would have broken.
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
      workspaceId: f.workspaceId,
      path: "1-projects/intake",
      kind: "folder" as const,
    });
    await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
      workspaceId: f.workspaceId,
      path: "1-projects/intake",
    });
    const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    expect(rows.length).toBe(1);
  });
});

/* ------------------------- turning it on and off -------------------------- */

describe("the owner's own switch", () => {
  /** The one live `anyone` row over `path`, as `listShares` reports it. */
  async function row(f: Fixture, path: string = FORM_NOTE) {
    const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    return rows.find((candidate) => candidate.entryPath === path && candidate.audience === "anyone");
  }

  test("an owner can turn answer-taking on and off without re-minting the link", async () => {
    // The whole reason this is its own mutation: a toggle routed through a
    // creation path is how a press of "off" hands somebody a new token for a
    // link they had already sent.
    const f = await fixture();
    const { token } = await link(f, "read");
    const before = await row(f);
    expect(before?.collecting).toBe(false);

    await asUser(f.t, f.owner).mutation(api.functions.shares.setShareCollecting, {
      shareId: before!.shareId,
      collecting: true,
    });
    const on = await row(f);
    expect([on?.collecting, on?.token]).toEqual([true, token]);
    // And it really collects now, rather than merely saying so.
    await answer(f, token);
    expect(await responsesFile(f)).toContain("Jordan");

    await asUser(f.t, f.owner).mutation(api.functions.shares.setShareCollecting, {
      shareId: before!.shareId,
      collecting: false,
    });
    const off = await row(f);
    expect([off?.collecting, off?.token]).toEqual([false, token]);
    expect(errorCode(await captureError(() => answer(f, token)))).toBe("LINK_NOT_COLLECTING");
  });

  test("a folder link cannot be switched on, which is the third door on that rule", async () => {
    // `collect.ts` refuses a folder row and `mintUnlistedLink` refuses one at
    // the mint. A rule enforced at two of the three places a row can be
    // written is a rule with one way around it.
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
      workspaceId: f.workspaceId,
      path: "1-projects/intake",
      kind: "folder" as const,
    });
    const folder = await row(f, "1-projects/intake");
    const failure = await captureError(() =>
      asUser(f.t, f.owner).mutation(api.functions.shares.setShareCollecting, {
        shareId: folder!.shareId,
        collecting: true,
      }),
    );
    expect(errorCode(failure)).toBe("COLLECT_NEEDS_A_NOTE");
    expect((await row(f, "1-projects/intake"))?.collecting).toBe(false);
  });

  test("a members link cannot be switched on either", async () => {
    const f = await fixture();
    const { token } = await asUser(f.t, f.owner).mutation(
      api.functions.shares.createTeamShare,
      { workspaceId: f.workspaceId, path: FORM_NOTE },
    );
    const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    const members = rows.find((candidate) => candidate.token === token);
    const failure = await captureError(() =>
      asUser(f.t, f.owner).mutation(api.functions.shares.setShareCollecting, {
        shareId: members!.shareId,
        collecting: true,
      }),
    );
    expect(errorCode(failure)).toBe("COLLECT_NEEDS_A_LINK");
  });

  test("a member of the context cannot open one, and is not told it exists", async () => {
    // `revokeShare`'s refusal order: somebody who is in the context but not
    // its owner learns nothing about the row beyond what they could guess.
    const f = await fixture();
    await link(f, "read");
    const live = await row(f);
    const failure = await captureError(() =>
      asUser(f.t, f.member).mutation(api.functions.shares.setShareCollecting, {
        shareId: live!.shareId,
        collecting: true,
      }),
    );
    expect(failure).not.toBeNull();
    expect((await row(f))?.collecting).toBe(false);
  });

  test("turning it on is its own line in the audit trail", async () => {
    // A publication decision, so it does not ride on `share.link.created` —
    // the trail has to be able to answer "when did this start taking answers".
    const f = await fixture();
    await link(f, "read");
    const live = await row(f);
    await asUser(f.t, f.owner).mutation(api.functions.shares.setShareCollecting, {
      shareId: live!.shareId,
      collecting: true,
    });
    const events = await f.t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(events.map((event) => event.action)).toContain("share.collect.opened");
  });
});

/* ------------------------------ what it writes ---------------------------- */

describe("what an answer through a link is stamped with", () => {
  /**
   * The shape, pinned — because one rule now rests on it.
   *
   * `assertMayChange` refuses any change to a row whose `by` is a link stamp,
   * and it recognises one by its shape alone (the flag that used to say so was
   * removed after sabotage showed it caught nothing). That is only safe while
   * a stamp is something no person can ever be called, in **both** directions:
   * a stamp is never a valid handle, and a valid handle never reads as a
   * stamp. A change to `linkStamp` that dropped the space — `via-@seyi`, say —
   * breaks the first and this test, and nothing else in the suite would.
   */
  test("a stamp is not a name, and a name is not a stamp", () => {
    // Both shapes, and the edges of what a handle is allowed to be.
    const stamps = [
      linkStamp("seyi", "intake"),
      linkStamp("seyi", null),
      linkStamp("ab", "a"),
      linkStamp("a".repeat(32), "b".repeat(48)),
    ];
    for (const stamp of stamps) {
      expect([stamp, isLinkStamp(stamp)]).toStrictEqual([stamp, true]);
      // Not a handle. Not after normalisation either — that is what
      // `validateName` does to its input before judging it.
      expect([stamp, validateName(stamp).ok]).toStrictEqual([stamp, false]);
    }

    // And the other direction: what a *person's* row carries never reads as a
    // stamp, including the handles that try hardest to.
    for (const handle of ["via", "via-link", "seyi", "a".repeat(32)]) {
      expect([handle, validateName(handle).ok]).toStrictEqual([handle, true]);
      expect([handle, isLinkStamp(`@${handle}`)]).toStrictEqual([handle, false]);
    }
  });

  test("the link, never a handle", async () => {
    const f = await fixture();
    const { token } = await link(f, "collect");
    await answer(f, token);

    const file = await responsesFile(f);
    expect(file).toContain("Jordan");
    // Not a username, and recognisably not one: the stamp opens with a word a
    // handle cannot contain, and `names.ts` forbids the space in it.
    expect(/\|\s*via [^|]*\|/.test(file)).toBe(true);
    // And never a bare handle in the `by` cell, which is what a person's row
    // carries and what an equality test would match.
    expect(/\|\s*@seyi\s*\|/.test(file)).toBe(false);
  });

  test("and two strangers through one link cannot act on each other's answers", async () => {
    // The collision #748 closed for `by: null`, which a shared link stamp
    // reproduces exactly. The public surface offers no edit at all, so this
    // goes at it through a member of the context — somebody with a real handle
    // and a real session — reaching for a stranger's row. Two lines refuse
    // that, and sabotage says it is the *second* one here: a member's name is
    // their handle, so the `by !== actor.name` comparison answers first and
    // the stamp rule never gets the case. That is the right order and worth
    // writing down, because it means this test does not cover the stamp rule
    // — the two below do.
    const f = await fixture();
    const { token } = await link(f, "collect");
    await answer(f, token);

    const file = await responsesFile(f);
    const responseId = /r-[0-9a-f]{8}/.exec(file)?.[0];
    expect(responseId).toBeDefined();

    const failure = await captureError(() =>
      asUser(f.t, f.member).action(api.functions.forms.retractSubmission, {
        workspaceId: f.workspaceId,
        path: FORM_NOTE,
        responseId: responseId!,
      }),
    );
    expect(errorCode(failure)).toBe("FORM_FORBIDDEN");
    expect(await responsesFile(f)).toContain("Jordan");
  });

  /**
   * The rule itself, at the surface a bug would come through.
   *
   * The public collect action offers submission and nothing else, so
   * `assertMayChange`'s link rule is not reachable from outside — which is
   * exactly how a guard ends up unproven. The *file operation* is reachable,
   * is what every form caller goes through, and is the shape any future "let a
   * link edit its own answer" would take. So it is driven directly, for both
   * of the verbs an owner could reach for.
   *
   * The rule reads one thing: the *stamp already on the row*. An earlier
   * version also carried an `actorViaLink` flag on the operation and checked
   * it, and sabotage showed that half caught nothing — a link actor's name is
   * always a link stamp, so the flag never decided a case the stamp had not
   * already decided. It was removed rather than left as an unproven second
   * condition, which makes the *shape* of `linkStamp` load-bearing: it holds a
   * space, so no username can ever collide with it. That shape has its own
   * test above.
   */
  test("a link actor cannot edit an answer, even its own", async () => {
    const f = await fixture();
    const { token } = await link(f, "collect");
    await answer(f, token);
    const responseId = /r-[0-9a-f]{8}/.exec(await responsesFile(f))?.[0];

    const failure = await captureError(() =>
      f.t.action(internal.functions.files.runFileOperation, {
        workspaceId: f.workspaceId,
        scope: "team" as const,
        operation: {
          kind: "form" as const,
          path: FORM_NOTE,
          actorName: "via a link to @seyi",
          actorRole: "member" as const,
          action: {
            kind: "update" as const,
            responseId: responseId!,
            values: [{ field: "who", value: "Someone else" }],
          },
        },
      }),
    );
    expect(errorCode(failure)).toBe("FORM_FORBIDDEN");
    expect(await responsesFile(f)).toContain("Jordan");
  });

  test("and it cannot retract one either", async () => {
    // The other verb. Retraction is the one a caller could argue for — "it is
    // my own answer" — and it is refused for the same reason: the row is
    // addressed by a stamp shared with every other stranger who used this
    // link, so honouring it would let any of them delete any other's.
    const f = await fixture();
    const { token } = await link(f, "collect");
    await answer(f, token);
    const responseId = /r-[0-9a-f]{8}/.exec(await responsesFile(f))?.[0];

    const failure = await captureError(() =>
      f.t.action(internal.functions.files.runFileOperation, {
        workspaceId: f.workspaceId,
        scope: "team" as const,
        operation: {
          kind: "form" as const,
          path: FORM_NOTE,
          actorName: "via a link to @seyi",
          actorRole: "member" as const,
          action: { kind: "retract" as const, responseId: responseId! },
        },
      }),
    );
    expect(errorCode(failure)).toBe("FORM_FORBIDDEN");
    expect(await responsesFile(f)).toContain("Jordan");
  });

  test("but an editor can remove one, because they could rewrite the file anyway", async () => {
    const f = await fixture();
    const { token } = await link(f, "collect");
    await answer(f, token);
    const responseId = /r-[0-9a-f]{8}/.exec(await responsesFile(f))?.[0];

    await asUser(f.t, f.owner).action(api.functions.forms.retractSubmission, {
      workspaceId: f.workspaceId,
      path: FORM_NOTE,
      responseId: responseId!,
    });
    expect(await responsesFile(f)).not.toContain("Jordan");
  });

  test("a form that takes editor answers refuses through a link", async () => {
    const f = await fixture();
    const { token } = await link(f, "collect", EDITOR_ONLY_NOTE);
    const failure = await captureError(() =>
      f.t.action(api.functions.collect.submitThroughLink, {
        token,
        values: [{ field: "note", value: "hello" }],
        challenge: "widget-token",
      }),
    );
    expect(failure).not.toBeNull();
    expect(errorCode(failure)).not.toBe("LINK_NOT_COLLECTING");
  });

  test("answers that do not fit the form are refused", async () => {
    const f = await fixture();
    const { token } = await link(f, "collect");
    const failure = await captureError(() =>
      answer(f, token, [{ field: "not_a_field", value: "x" }]),
    );
    expect(failure).not.toBeNull();
  });
});

/* ------------------------------ the bound --------------------------------- */

describe("what a collect link serves", () => {
  test("its own note, with the form the viewer has to draw", async () => {
    const f = await fixture();
    const { token } = await link(f, "collect");
    const view = await f.t.action(api.functions.shares.readSharedNote, { token });
    expect(view.path).toBe(FORM_NOTE);
    expect(view.collecting).toBe(true);
  });

  test("and not the notes it links to, which a read link over the same note does", async () => {
    // Both links are over the SAME note, one at a time: `mintLinkShare`
    // supersedes by (workspace, path, anyone), so two live links over one note
    // cannot exist and the comparison has to be sequential.
    const f = await fixture();

    const readLink = await link(f, "read");
    const viaRead = await f.t.action(api.functions.shares.readSharedNote, {
      token: readLink.token,
      path: LINKED,
    });
    expect(viaRead.path).toBe(LINKED);

    const collect = await link(f, "collect");
    const followed = await captureError(() =>
      f.t.action(api.functions.shares.readSharedNote, { token: collect.token, path: LINKED }),
    );
    expect(followed).not.toBeNull();
  });

  test("a read link reports that it is not collecting", async () => {
    const f = await fixture();
    const { token } = await link(f, "read");
    const view = await f.t.action(api.functions.shares.readSharedNote, { token });
    expect(view.collecting).toBe(false);
  });
});

/* ------------------------------- the ceilings ----------------------------- */

describe("what stops a flood", () => {
  test("a link stops at its cap", async () => {
    const f = await fixture();
    const { token, shareId } = await link(f, "collect");
    await f.t.run((ctx) => ctx.db.patch(shareId, { collectCap: 1 }));

    await answer(f, token);
    const failure = await captureError(() =>
      answer(f, token, [{ field: "who", value: "Second" }]),
    );
    expect(errorCode(failure)).toBe("COLLECT_CAP_REACHED");
    expect(await responsesFile(f)).not.toContain("Second");
  });

  test("an owner's own cap is what stops it, and a silly one is not honoured", async () => {
    // The cap reaches the row through the mint rather than a patch, which is
    // the path a real owner and a real agent take.
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
      workspaceId: f.workspaceId,
      path: FORM_NOTE,
      mode: "collect" as const,
      collectCap: 2,
    });
    const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    expect(await f.t.run((ctx) => ctx.db.get(rows[0]!.shareId))).toMatchObject({
      collectCap: 2,
    });

    // And out of range is the DEFAULT, never "unlimited" — the one reading
    // that would turn a typo into an open door.
    await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
      workspaceId: f.workspaceId,
      path: FORM_NOTE,
      mode: "collect" as const,
      collectCap: 5_000_000,
    });
    const after = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    const row = await f.t.run((ctx) => ctx.db.get(after[0]!.shareId));
    // Still 2: the live row preserves what it had when the caller said nothing
    // usable, rather than being reset or widened.
    expect(row?.collectCap).toBe(2);
    expect(collectCapFrom(5_000_000)).toBe(null);
    expect(collectCapFrom(0)).toBe(null);
    expect(collectCapFrom(1.5)).toBe(null);
    expect(collectCapFrom(2000)).toBe(2000);
  });

  test("a cancelled managed context stops taking answers", async () => {
    const f = await fixture({ managed: true });
    const { token } = await link(f, "collect");
    await f.t.run((ctx) =>
      ctx.db.insert("workspacePlans", {
        workspaceId: f.workspaceId,
        status: "canceled" as const,
        managedStorage: true,
        fastSearch: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect(errorCode(await captureError(() => answer(f, token)))).toBe("CONTEXT_READ_ONLY");
  });

  test("a cancelled context on the customer's OWN bucket keeps taking them", async () => {
    // Only managed storage can be made read-only by a lapse: a bucket the
    // customer owns keeps working with their own credentials whatever we think
    // of their card.
    const f = await fixture();
    const { token } = await link(f, "collect");
    await f.t.run((ctx) =>
      ctx.db.insert("workspacePlans", {
        workspaceId: f.workspaceId,
        status: "canceled" as const,
        managedStorage: true,
        fastSearch: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await answer(f, token);
    expect(await responsesFile(f)).toContain("Jordan");
  });
});

/* ------------------------------ internals --------------------------------- */

describe("the resolution itself", () => {
  test("is internal — a stranger cannot turn a name into a token", () => {
    const source = readFileSync(
      new URL("../functions/collect.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("export const collectTarget = internalQuery({");
    expect(source).not.toContain("export const collectTarget = query({");
    expect(internal.functions.collect.collectTarget).toBeDefined();
  });
});
