/**
 * FORM NOTIFICATIONS — the first thing in this product that mails somebody
 * about content a stranger wrote.
 *
 * Every other outbound message here is about an offer one account made to one
 * address. This one is triggered by a submission that may have come through a
 * published link from a person with no account, and it carries their words.
 * So these tests vary the two dimensions that decide whether that is safe:
 * **who a form may name**, and **what that person is allowed to be told**.
 *
 *  1. **A block names a person, never a destination.** `apps/mcp`'s grammar
 *     refuses an address, and this file proves the control plane refuses one
 *     too — because a bucket is a file somebody can hand-edit in Obsidian, and
 *     a grammar is not a guard on the far side of that.
 *  2. **A named person who is not a member here gets nothing.** Naming is not
 *     granting. This is the whole anti-relay rule, and it is the one a
 *     "simplification" removes first.
 *  3. **The answers are fetched as the recipient.** A person the manifest
 *     holds back from the responses note is not mailed — and the read that
 *     would have produced the mail is the read that refuses.
 *  4. **Only a submission.** An edit, a retraction and a vote announce
 *     nothing; a vote in particular is a button every member has.
 *  5. **A burst is counted, not dropped, and not mailed one by one.**
 *  6. **The submitter is never told who was told.**
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Numbers are what actually failed,
 * not what was expected to.
 *
 * | edit | FAIL |
 * |---|---|
 * | `resolveRecipient` drops the `invitee.kind !== "name"` test | 1 |
 * | `resolveRecipient` drops the membership lookup | 1 |
 * | `readResponseForNotification` skips `canSee` | **2** |
 * | `notifyMaterialFor` tests truthiness instead of `kind === "submit"` | 1 |
 * | `claimSlot` returns `true` unconditionally | **2** |
 * | `readResponseForNotification` stops checking `to` against the block | 1 |
 * | a separate `privacy.md` refusal in the same function | **0** |
 *
 * Two of those came back **1** and that was the finding rather than the
 * result. The anti-relay rule — a form names a person, an address never
 * resolves — had one assertion behind it, on the resolver, and the resolver is
 * the *inner* of two guards. The outer one is that a block holding an address
 * does not parse at all, which no test touched: an owner who hand-edits one
 * into their bucket gets a form that refuses submissions, and nothing was
 * checking that rather than "takes the answer, mails nobody". There is now a
 * fixture that writes that block straight into the bucket, past every tool.
 *
 * The third came back 2 across both paths, which is what it should be: the
 * notification and the digest are gated by the same read, and a test that only
 * covered the first would have left the digest free to announce a burst on a
 * file the manifest had since closed.
 *
 * The last came back **0** and was removed. It refused a `responses:` pointing
 * at `privacy.md`, which looked like a way to mail somebody their own access
 * map — and is unreachable from both ends: nothing can write a response into
 * that file and nothing can read one back out of it, both because of the
 * marker check. A guard that cannot be reached is not a guard, so the
 * reasoning stays as a comment where somebody will look for it and the line is
 * gone.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { escapeHtml, sanitizeHeaderText } from "../functions/lib/invitationEmail";
import { renderFormDigest, renderFormNotification } from "../functions/lib/formNotifyEmail";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  asUser,
  createUser,
  createWorkspace,
  drainScheduled,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RESEND_API_KEY;
  delete process.env.FORM_NOTIFY_EMAIL_FROM;
});

const NOTE = "1-projects/intake/overview.md";
const RESPONSES = "1-projects/intake/overview-responses.md";

/** The form, with whoever it names. `null` names nobody. */
function formBody(notify: string | null): string {
  return [
    "# New project intake",
    "",
    "```form",
    "id: intake",
    `responses: ${RESPONSES}`,
    "layout: sections",
    "submit: member",
    "edit_own: true",
    "votes: named",
    ...(notify === null ? [] : [`notify: ${notify}`]),
    "fields:",
    "  - { name: who, type: line, max: 120, required: true }",
    "  - { name: brief, type: text, max: 2000 }",
    "```",
    "",
  ].join("\n");
}

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  member: Id<"users">;
  /** An account with a verified address and NO membership here. */
  outsider: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
  /** Every message the stubbed Resend endpoint was asked to send. */
  sent: Array<{ to: string; subject: string; html: string; text: string }>;
}

function stubFetch(backend: MemoryS3, sent: Fixture["sent"]) {
  const s3 = backend.fetchImpl;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.resend.com/")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Fixture["sent"][number];
      sent.push(body);
      return new Response(JSON.stringify({ id: "msg" }), { status: 200 });
    }
    return await (s3 as (i: RequestInfo | URL, x?: RequestInit) => Promise<Response>)(input, init);
  };
}

async function fixture(notify: string | null = "owner"): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const outsider = await createUser(t, "outsider@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "seyi");
  // Personal contexts, so each has a username to be recorded under and a
  // handle that `notify: @name` can resolve.
  await createWorkspace(t, member, "dan");
  await createWorkspace(t, outsider, "mara");
  await t.run(async (ctx) => {
    await ctx.db.insert("workspaceMembers", {
      workspaceId,
      userId: member,
      role: "member" as const,
      joinedAt: Date.now(),
    });
  });

  const backend = memoryS3("fake-bucket");
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");

  const sent: Fixture["sent"] = [];
  vi.stubGlobal("fetch", stubFetch(backend, sent));
  process.env.RESEND_API_KEY = "test-resend-key-not-a-real-one";

  await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: "fake-bucket" });
  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "1-projects",
    visibility: "team",
  });
  // The author's own save is what creates the empty answers file.
  await asUser(t, owner).action(api.functions.files.writeNote, {
    workspaceId,
    path: NOTE,
    text: formBody(notify),
  });

  return { t, owner, member, outsider, workspaceId, backend, sent };
}

/**
 * Run the scheduled jobs that are actually due, and leave the future alone.
 *
 * `drainScheduled` waits for the queue to empty, which never happens once a
 * digest is queued: it is scheduled at the end of the rate limiter's window, an
 * hour out, and stays `pending` until then. A test about a burst has to be able
 * to say "every notification has run" without also saying "and an hour passed".
 */
async function drainDue(t: TestConvex): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const due = jobs.filter(
      (job) =>
        (job.state.kind === "pending" && job.scheduledTime <= Date.now()) ||
        job.state.kind === "inProgress",
    );
    if (due.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
    await t.finishInProgressScheduledFunctions();
  }
  throw new Error("due scheduled functions never drained");
}

/** One answer, from the context's ordinary member. */
async function submit(
  f: Fixture,
  values: Array<{ field: string; value: string }> = [
    { field: "who", value: "Ada" },
    { field: "brief", value: "A small thing." },
  ],
): Promise<{ responseId: string }> {
  const result = await asUser(f.t, f.member).action(api.functions.forms.submitForm, {
    workspaceId: f.workspaceId,
    path: NOTE,
    values,
  });
  await drainScheduled(f.t);
  return result;
}

describe("a form names a person, never a destination", () => {
  test("an address in the block is refused by the control plane too", async () => {
    const f = await fixture();
    /*
      Called directly, which is the point. The gateway's grammar refuses this
      value, so the only way it reaches a bucket is somebody editing the note
      in Obsidian — and the control plane is the side of that boundary where a
      guard actually holds. `parseInvitee` accepts an address happily; the
      `kind` test beside it is the whole refusal.
    */
    const recipient = await f.t.query(internal.functions.formNotify.resolveRecipient, {
      workspaceId: f.workspaceId,
      // The owner's own verified address. If an address could ever resolve,
      // this is the one that would — which is what makes it the right fixture.
      notify: "owner@example.invalid",
    });
    expect(recipient).toBeNull();
  });

  test("a handle belonging to somebody who is not a member here resolves to nobody", async () => {
    const f = await fixture();
    const recipient = await f.t.query(internal.functions.formNotify.resolveRecipient, {
      workspaceId: f.workspaceId,
      notify: "@mara",
    });
    // Naming is not granting. `@mara` is a real account with a real verified
    // address; what she is not is a member of this context.
    expect(recipient).toBeNull();
  });

  test("a block hand-edited to hold an address makes the form inert, not a relay", async () => {
    const f = await fixture("owner");
    /*
      Written straight into the bucket, past every tool — which is the only way
      this value can exist, and exactly what an owner with Obsidian open can
      do. Two guards stand behind it and this checks the outer one: the block
      does not parse, so the form refuses submissions altogether rather than
      taking an answer and mailing it somewhere a code fence chose.
    */
    f.backend.seed(NOTE, formBody("dev@example.invalid"));
    await expect(
      asUser(f.t, f.member).action(api.functions.forms.submitForm, {
        workspaceId: f.workspaceId,
        path: NOTE,
        values: [{ field: "who", value: "Ada" }],
      }),
    ).rejects.toThrow();
    await drainDue(f.t);
    expect(f.sent).toHaveLength(0);
  });

  test("a member's handle does resolve, so the refusal above is not vacuous", async () => {
    const f = await fixture();
    const recipient = await f.t.query(internal.functions.formNotify.resolveRecipient, {
      workspaceId: f.workspaceId,
      notify: "@dan",
    });
    expect(recipient?.email).toBe("member@example.invalid");
  });

  test("an account with no verified address is not mailed", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.owner, { emailVerificationTime: undefined });
    });
    const recipient = await f.t.query(internal.functions.formNotify.resolveRecipient, {
      workspaceId: f.workspaceId,
      notify: "owner",
    });
    expect(recipient).toBeNull();
  });
});

describe("what a submission sends", () => {
  test("an answer to a form naming the owner is mailed to them, with the answers in it", async () => {
    const f = await fixture("owner");
    await submit(f);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].to).toBe("owner@example.invalid");
    expect(f.sent[0].subject).toContain("intake");
    expect(f.sent[0].text).toContain("Ada");
    expect(f.sent[0].text).toContain("A small thing.");
  });

  test("a form that names nobody mails nobody", async () => {
    const f = await fixture(null);
    await submit(f);
    expect(f.sent).toHaveLength(0);
  });

  test("the submitter is never told who was told", async () => {
    const f = await fixture("owner");
    const result = await asUser(f.t, f.member).action(api.functions.forms.submitForm, {
      workspaceId: f.workspaceId,
      path: NOTE,
      values: [{ field: "who", value: "Ada" }],
    });
    // `notify` is stripped before `runFileOperation` returns, and the result
    // validator would refuse it if it were not. A submitter learning that a
    // form mails an address, or which one, is a fact about somebody else.
    expect(Object.keys(result).sort()).toEqual(
      ["formId", "responseId", "responsesPath", "votes"].sort(),
    );
  });

  test("an edit, a retraction and a vote announce nothing", async () => {
    const f = await fixture("owner");
    const { responseId } = await submit(f);
    expect(f.sent).toHaveLength(1);

    await asUser(f.t, f.member).action(api.functions.forms.updateSubmission, {
      workspaceId: f.workspaceId,
      path: NOTE,
      responseId,
      values: [{ field: "who", value: "Ada" }, { field: "brief", value: "Changed." }],
    });
    await asUser(f.t, f.member).action(api.functions.forms.voteForm, {
      workspaceId: f.workspaceId,
      path: NOTE,
      responseId,
    });
    await asUser(f.t, f.member).action(api.functions.forms.retractSubmission, {
      workspaceId: f.workspaceId,
      path: NOTE,
      responseId,
    });
    await drainScheduled(f.t);

    // Still one. Each of these is a change to an answer already announced, and
    // a vote is a button every member of a context has.
    expect(f.sent).toHaveLength(1);
  });

  test("a deployment with no Resend key sends nothing and does not fail the submission", async () => {
    const f = await fixture("owner");
    delete process.env.RESEND_API_KEY;
    const { responseId } = await submit(f);
    expect(f.sent).toHaveLength(0);
    // The answer is in the bucket regardless. Mail is a derivative of it.
    expect(responseId).toMatch(/^r-[0-9a-f]{8}$/);
    expect(f.backend.snapshot()[RESPONSES] ?? "").toContain("Ada");
  });
});

describe("who a form tells is read out of the block, never from the caller", () => {
  test("a delivery naming somebody the block does not name sends nothing", async () => {
    const f = await fixture("owner");
    const { responseId } = await submit(f);
    const before = f.sent.length;
    /*
      `deliver` driven directly with a `to` that disagrees with the note. This
      is what a leaked gateway secret reaches — `/gateway/forms/notify` takes
      `to` as an argument — and without the check in
      `readResponseForNotification` that argument would decide who a real
      answer is mailed to, bounded only by their being able to read the file.
      A smaller hole than a relay, the same shape: a destination supplied by a
      caller rather than derived from the thing being sent.
    */
    await f.t.action(internal.functions.formNotify.deliver, {
      workspaceId: f.workspaceId,
      responseId,
      to: "@dan",
      formId: "intake",
      notePath: NOTE,
      responsesPath: RESPONSES,
    });
    expect(f.sent).toHaveLength(before);
  });

  test("...and the same call with the name the block does carry is delivered", async () => {
    const f = await fixture("owner");
    const { responseId } = await submit(f);
    const before = f.sent.length;
    await f.t.action(internal.functions.formNotify.deliver, {
      workspaceId: f.workspaceId,
      responseId,
      to: "owner",
      formId: "intake",
      notePath: NOTE,
      responsesPath: RESPONSES,
    });
    // The positive control, so the refusal above is about the mismatch rather
    // than about `deliver` being unreachable from a test.
    expect(f.sent).toHaveLength(before + 1);
  });
});

describe("the answers are fetched as the recipient", () => {
  test("a member the manifest holds back from the answers is not mailed", async () => {
    const f = await fixture("@dan");
    // The answers become private; `@dan` is a `member`, so they read at `team`
    // and this puts the file out of reach. The form's own note is untouched,
    // which is the case worth separating: they can still see the form.
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: RESPONSES,
      visibility: "private",
    });
    await submit(f);
    expect(f.sent).toHaveLength(0);
  });

  test("...and the owner of the same context still is, so the refusal is about the manifest", async () => {
    const f = await fixture("owner");
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: RESPONSES,
      visibility: "private",
    });
    await submit(f);
    expect(f.sent).toHaveLength(1);
  });

  test("a response that is gone by the time the notification runs announces nothing", async () => {
    const f = await fixture("owner");
    await submit(f);
    const before = f.sent.length;
    /*
      `deliver` called directly with an id that is not in the file, which is
      the state a retraction between the submission and its notification
      produces. Driven directly rather than by racing the scheduler: in
      `convex-test` a `runAfter(0)` job starts on a real timer as soon as the
      event loop turns, so a test that tried to retract "before" it would be
      asserting on whichever won, which is not a property.
    */
    await f.t.action(internal.functions.formNotify.deliver, {
      workspaceId: f.workspaceId,
      responseId: "r-deadbeef",
      to: "owner",
      formId: "intake",
      notePath: NOTE,
      responsesPath: RESPONSES,
    });
    expect(f.sent).toHaveLength(before);
  });
});

describe("a burst is counted rather than mailed or dropped", () => {
  test("over the limit the answers become one digest, and the digest names the count", async () => {
    const f = await fixture("owner");
    for (let i = 0; i < 23; i += 1) {
      await asUser(f.t, f.member).action(api.functions.forms.submitForm, {
        workspaceId: f.workspaceId,
        path: NOTE,
        values: [{ field: "who", value: `Person ${i}` }],
      });
    }
    await drainDue(f.t);

    // Twenty mailed, three held back — and exactly one digest row, with one
    // job outstanding for it however many answers landed in the window.
    expect(f.sent).toHaveLength(20);
    const digests = await f.t.run((ctx) => ctx.db.query("formNotifyDigests").collect());
    expect(digests).toHaveLength(1);
    expect(digests[0].pending).toBe(3);

    await f.t.action(internal.functions.formNotify.sendDigest, {
      digestId: digests[0]._id,
    });
    await drainDue(f.t);
    expect(f.sent).toHaveLength(21);
    expect(f.sent[20].subject).toContain("3 more");
    // A digest carries no answers. It is sent precisely when a lot of them
    // landed, and a message holding twenty strangers' briefs is a different
    // object from one holding one.
    expect(f.sent[20].text).not.toContain("Person 2");
  });

  test("a digest for a recipient the manifest now refuses is not sent", async () => {
    const f = await fixture("@dan");
    for (let i = 0; i < 22; i += 1) {
      await asUser(f.t, f.member).action(api.functions.forms.submitForm, {
        workspaceId: f.workspaceId,
        path: NOTE,
        values: [{ field: "who", value: `Person ${i}` }],
      });
    }
    await drainDue(f.t);
    const digests = await f.t.run((ctx) => ctx.db.query("formNotifyDigests").collect());
    expect(digests).toHaveLength(1);

    const before = f.sent.length;
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: RESPONSES,
      visibility: "private",
    });
    await f.t.action(internal.functions.formNotify.sendDigest, {
      digestId: digests[0]._id,
    });
    await drainDue(f.t);
    // The window closed on a file this member may no longer read. "Answers
    // arrived on a note you cannot open" is still a statement about that note.
    expect(f.sent).toHaveLength(before);
  });

  test("a digest with nothing pending sends nothing", async () => {
    const f = await fixture("owner");
    await submit(f);
    const id = await f.t.run((ctx) =>
      ctx.db.insert("formNotifyDigests", {
        workspaceId: f.workspaceId,
        recipientUserId: f.owner,
        formId: "intake",
        responsesPath: RESPONSES,
        notePath: NOTE,
        responseId: "r-00000000",
        notify: "owner",
        pending: 0,
      }),
    );
    const before = f.sent.length;
    await f.t.action(internal.functions.formNotify.sendDigest, { digestId: id });
    expect(f.sent).toHaveLength(before);
  });
});

describe("what a stranger can put in somebody's inbox", () => {
  /*
    The injection surface, and the reason this file exists at all. Everything
    below is a value a person with no account typed into a published form, on
    its way to becoming an HTML document and a Subject header.
  */
  const facts = {
    workspaceName: "Seyi",
    workspaceSlug: "seyi",
    formId: "intake",
    notePath: NOTE,
    responsesPath: RESPONSES,
    by: "via @seyi/intake",
    at: "2026-09-21 10:00",
  };

  test("markup in an answer arrives as text", () => {
    const rendered = renderFormNotification({
      ...facts,
      answers: [{ field: "brief", value: "<script>alert(1)</script>" }],
    });
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain(escapeHtml("<script>alert(1)</script>"));
  });

  test("a literal line break in an answer is a break, and a typed <br> is not", () => {
    const rendered = renderFormNotification({
      ...facts,
      answers: [{ field: "brief", value: "one\ntwo <br> three" }],
    });
    // Escaped first, then broken. The other order turns somebody's literal
    // "<br>" into a line break — the mistake `unescapeCell` has a fixture for
    // on the storage side, here on the rendering side.
    expect(rendered.html).toContain("one<br>two");
    expect(rendered.html).toContain("&lt;br&gt;");
  });

  test("a submitted newline cannot append a header", () => {
    const rendered = renderFormNotification({
      ...facts,
      workspaceName: "Seyi\r\nBcc: someone@example.invalid",
      answers: [{ field: "who", value: "Ada" }],
    });
    expect(rendered.subject).not.toContain("\r");
    expect(rendered.subject).not.toContain("\n");
    expect(rendered.subject).toBe(sanitizeHeaderText(rendered.subject));
  });

  test("no answer reaches the subject line at all", () => {
    const rendered = renderFormNotification({
      ...facts,
      answers: [{ field: "brief", value: "the acquisition of Acme" }],
    });
    // A subject shows on a lock screen and is quoted into notification
    // history. A client's brief arriving there is content leaving the boundary
    // in the one place its recipient cannot control.
    expect(rendered.subject).not.toContain("Acme");
  });

  test("one enormous answer is cut, and says that it was cut", () => {
    const rendered = renderFormNotification({
      ...facts,
      answers: [{ field: "brief", value: "x".repeat(20000) }],
    });
    expect(rendered.text.length).toBeLessThan(6000);
    expect(rendered.text).toContain("cut");
    // Never silently. An owner who thinks they have read a brief when they
    // have read the first tenth of it has been told something false.
    expect(rendered.text).toContain("All the answers");
  });

  test("a form with more answers than fit says how many are missing", () => {
    const rendered = renderFormNotification({
      ...facts,
      answers: Array.from({ length: 24 }, (_, i) => ({
        field: `f${i}`,
        value: "y".repeat(2000),
      })),
    });
    expect(rendered.text).toMatch(/\d+ further answer\(s\) are not shown/);
  });

  test("a digest's own subject is header-safe", () => {
    const rendered = renderFormDigest({
      workspaceName: "Seyi\nSubject: forged",
      workspaceSlug: "seyi",
      formId: "intake",
      responsesPath: RESPONSES,
      count: 9,
    });
    expect(rendered.subject).not.toContain("\n");
    expect(rendered.subject).toContain("9 more");
  });
});
