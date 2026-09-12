/**
 * MARKDOWN FORMS, THROUGH THE CONTROL PLANE.
 *
 * `apps/mcp/test/forms.test.mjs` proves the format. This proves the thing only
 * this layer can get wrong, and it is the thing the whole feature rests on:
 *
 * **`submitForm` is the one write a workspace `member` is allowed, and it must
 * not become a second `writeNote`.**
 *
 * `files.writeNote` requires `editor` and correctly so — it writes arbitrary
 * text to an arbitrary path. These four actions require `member`, because a
 * form exists to collect answers from people who cannot write notes, and a
 * shared workspace whose members can file nothing is the gap this closes. What
 * keeps the relaxation narrow is not the authorization check; it is that there
 * is **no argument on any of these actions that reaches a bucket as text, and
 * none that names a path except the form's own note**. So the assertions that
 * matter are the ones about what a member *cannot* do with them:
 *
 *  - aim a submission at a note that is not a response file,
 *  - write into a workspace they are not in, or learn that one exists,
 *  - claim to be somebody else,
 *  - or act on a response that is not theirs.
 *
 * The whole path is real, in the style of `files.test.ts`: the real actions,
 * the real `S3Store` doing real SigV4 against a `fetch` stub, the real
 * `formOps` importing the real `apps/mcp/src/forms.js`. Only the socket is fake.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import {
  emptyResponsesFile,
  parseFormBlocks,
  parseResponsesFile,
  renderResponsesFile,
} from "../../mcp/src/forms.js";
import { runFormAction } from "../functions/lib/formOps";
import type { FileStore } from "../functions/lib/fileOps";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { memoryS3, type MemoryS3, type MemoryS3Options } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const FORM_NOTE = "1-projects/feedback.md";
const RESPONSES = "1-projects/feedback-responses.md";

const FORM_BLOCK = [
  "# Feedback",
  "",
  "```form",
  "id: bugs",
  /*
    Rooted, not relative. `responses:` is resolved by `normalizePath` from the
    bucket root exactly as the gateway resolves it — a form is not a link and
    there is no "beside this note" here — so a bare name would put the response
    file at the top of the context rather than next to the form.
  */
  `responses: ${RESPONSES}`,
  "layout: table",
  "submit: member",
  "edit_own: true",
  "votes: named",
  "fields:",
  "  - { name: summary, type: line, max: 120, required: true }",
  "  - { name: area, type: select, options: [app, gateway] }",
  "```",
].join("\n");

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  editor: Id<"users">;
  member: Id<"users">;
  other: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

/**
 * A shared workspace with an owner, an editor, a read-only member and an
 * outsider — and a personal brain for each of the four.
 *
 * The brains are not decoration. A response is recorded under its author's
 * **username**, which `formActor` reads from their own personal workspace's
 * slug, so a fixture without them would prove nothing about `by` and every
 * submission would refuse with `NO_USERNAME`.
 */
async function fixture(options: MemoryS3Options & { conditionalWrite?: boolean } = {}) {
  const { conditionalWrite = true, ...bucketOptions } = options;
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const other = await createUser(t, "other@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");

  // Each person's own brain, which is where their username lives.
  await createWorkspace(t, owner, "ada");
  await createWorkspace(t, editor, "grace");
  await createWorkspace(t, member, "alan");
  await createWorkspace(t, other, "linus");
  await createWorkspace(t, stranger, "edsger");

  const workspaceId = await createWorkspace(t, owner, "atlas", { kind: "shared" });
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, member, "member", owner);
  await addMember(t, workspaceId, other, "member", owner);

  const backend = memoryS3(FAKE_STORAGE.bucket, bucketOptions);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed("1-projects/README.md", "# Projects\n");
  vi.stubGlobal("fetch", backend.fetchImpl);

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
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  const f: Fixture = { t, owner, editor, member, other, stranger, workspaceId, backend };
  /*
    `1-projects` is team-visible, which is a precondition of the feature rather
    than a convenience here: `canSee` is what decides whether a member can open
    the form's note at all, and a form in a folder they cannot see is a form
    they cannot answer. The PARA scaffold makes every folder private, so this
    is the step a person setting up a shared bug tracker takes too.
  */
  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "1-projects",
    visibility: "team",
  });
  // The form is written by the editor, which is also what creates the response
  // file — see `ensureFormResponseFiles`, and the test for it below.
  await asUser(t, editor).action(api.functions.files.writeNote, {
    workspaceId,
    path: FORM_NOTE,
    text: FORM_BLOCK,
  });
  return f;
}

/**
 * Change the form's own note, as an editor.
 *
 * Through a read first, because `writeFile` refuses a blind write over a file
 * that already exists — `CONFLICT`, "A file already exists at that path" — and
 * that refusal is the console's unsaved-changes guard doing its job rather than
 * something to work around with a flag.
 */
async function rewriteForm(f: Fixture, text: string): Promise<void> {
  const read = await asUser(f.t, f.editor).action(api.functions.files.readNote, {
    workspaceId: f.workspaceId,
    path: FORM_NOTE,
  });
  await asUser(f.t, f.editor).action(api.functions.files.writeNote, {
    workspaceId: f.workspaceId,
    path: FORM_NOTE,
    text,
    expectedEtag: read.etag,
  });
}

function submit(f: Fixture, who: Id<"users">, values: Record<string, string>) {
  return asUser(f.t, who).action(api.functions.forms.submitForm, {
    workspaceId: f.workspaceId,
    path: FORM_NOTE,
    formId: "bugs",
    values: Object.entries(values).map(([field, value]) => ({ field, value })),
  });
}

/** The response file, parsed back through the format that wrote it. */
function responses(f: Fixture): Array<{ id: string; by: string; values: Record<string, string>; votes: string[] }> {
  const stored = f.backend.snapshot()[RESPONSES];
  const config = (parseFormBlocks(FORM_BLOCK) as Array<{ config?: unknown }>)[0].config;
  const parsed = parseResponsesFile(stored, config) as {
    responses?: Array<{ id: string; by: string; values: Record<string, string>; votes: string[] }>;
    error?: string;
  };
  expect(parsed.error).toBeUndefined();
  return parsed.responses ?? [];
}

/* -------------------------------------------------------------------------- */
/*                          the point of the feature                          */
/* -------------------------------------------------------------------------- */

describe("a member may submit, and that is the only write they get", () => {
  test("the author's write creates the response file, so the form collects from the start", async () => {
    const f = await fixture();
    expect(f.backend.snapshot()[RESPONSES]).toContain("context:form responses id=bugs");
  });

  test("a member submits, though they cannot write a note", async () => {
    const f = await fixture();

    // The premise, asserted rather than assumed: this person genuinely has no
    // write access. A fixture where they did would make every test below pass
    // for the wrong reason.
    const refused = await captureError(() =>
      asUser(f.t, f.member).action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/sneaky.md",
        text: "# Mine now\n",
      }),
    );
    expect(errorCode(refused)).toBe("INSUFFICIENT_ROLE");

    const result = await submit(f, f.member, { summary: "Search is slow", area: "app" });
    expect(result.formId).toBe("bugs");
    expect(result.responsesPath).toBe(RESPONSES);

    const rows = responses(f);
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toEqual({ summary: "Search is slow", area: "app" });
  });

  test("the answer lands in the response file and nowhere else", async () => {
    const f = await fixture();
    const before = f.backend.snapshot();
    await submit(f, f.member, { summary: "Search is slow" });
    const after = f.backend.snapshot();

    const changed = Object.keys(after).filter((key) => after[key] !== before[key]);
    expect(changed).toEqual([RESPONSES]);
    // The form's own note is untouched: a submission never rewrites the block.
    expect(after[FORM_NOTE]).toBe(FORM_BLOCK);
  });

  test("note content never reaches the control plane's tables", async () => {
    const f = await fixture();
    await submit(f, f.member, { summary: "zzq-answer-marker-never-persist" });
    const database = await f.t.run(async (ctx) => {
      const tables = ["auditEvents", "storageBindings", "workspaces", "users"] as const;
      return JSON.stringify(await Promise.all(tables.map((table) => ctx.db.query(table).collect())));
    });
    expect(database).not.toContain("zzq-answer-marker-never-persist");
  });
});

/* -------------------------------------------------------------------------- */
/*                         identity is stamped, not claimed                   */
/* -------------------------------------------------------------------------- */

describe("who a response belongs to", () => {
  /*
    Proved with two people rather than one person trying to lie, because the
    argument validator refuses a `by` before any handler runs — there is no
    field to put one in. Two submitters with two different rows is the only
    evidence that `by` is read from the session at all.
  */
  test("is read from the session, so two submitters get their own names", async () => {
    const f = await fixture();
    await submit(f, f.member, { summary: "From the member" });
    await submit(f, f.editor, { summary: "From the editor" });

    const rows = responses(f);
    expect(rows.map((row) => row.by)).toEqual(["@alan", "@grace"]);
  });

  test("a person with no brain of their own is refused rather than recorded anonymously", async () => {
    const f = await fixture();
    // Their personal workspace is removed, which is the state a stale
    // membership or a self-hosted deployment can produce.
    await f.t.run(async (ctx) => {
      const brains = await ctx.db
        .query("workspaces")
        .filter((q) => q.eq(q.field("slug"), "alan"))
        .collect();
      for (const brain of brains) await ctx.db.delete(brain._id);
    });

    const error = await captureError(() => submit(f, f.member, { summary: "Anonymous" }));
    expect(errorCode(error)).toBe("NO_USERNAME");
    expect(responses(f)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                              tenant isolation                              */
/* -------------------------------------------------------------------------- */

describe("somebody else's context", () => {
  /*
    The rule `isolation.test.ts` sets and this follows byte-for-byte: an
    endpoint that answers "not yours" differently from "never existed" is an
    oracle for which workspaces are real, and a form action is reachable by the
    lowest role in the product.
  */
  test("refuses an outsider with the same error as a workspace that never existed", async () => {
    const f = await fixture();
    const outsider = await captureError(() => submit(f, f.stranger, { summary: "Hello" }));

    const nowhere = await f.t.run(async (ctx) => {
      const id = await ctx.db.insert("workspaces", {
        slug: "temporary-placeholder",
        displayName: "Temporary",
        createdBy: f.stranger,
        kind: "personal" as const,
        structureTemplate: "para" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });
    const absent = await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.forms.submitForm, {
        workspaceId: nowhere,
        path: FORM_NOTE,
        formId: "bugs",
        values: [{ field: "summary", value: "Hello" }],
      }),
    );

    expect(JSON.stringify((outsider as { data?: unknown }).data)).toBe(
      JSON.stringify((absent as { data?: unknown }).data),
    );
    expect(responses(f)).toHaveLength(0);
  });

  test("and writes nothing into the bucket on the way to being refused", async () => {
    const f = await fixture();
    const before = f.backend.snapshot();
    await captureError(() => submit(f, f.stranger, { summary: "Hello" }));
    expect(f.backend.snapshot()).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/*              the destination is the form's, never the caller's             */
/* -------------------------------------------------------------------------- */

describe("what a submission can be aimed at", () => {
  test("a note carrying no form is refused, and is not appended to", async () => {
    const f = await fixture();
    // A note this member can genuinely read, so the refusal is about the form
    // rather than about visibility — see the case below for that one.
    const error = await captureError(() =>
      asUser(f.t, f.member).action(api.functions.forms.submitForm, {
        workspaceId: f.workspaceId,
        path: "1-projects/README.md",
        formId: "bugs",
        values: [{ field: "summary", value: "Hello" }],
      }),
    );
    expect(errorCode(error)).toBe("FORM_NOT_FOUND");
    expect(f.backend.snapshot()["1-projects/README.md"]).toBe("# Projects\n");
  });

  /*
    A note the caller cannot see answers "does not exist", identically to a note
    that does not — the rule every read in `fileOps.ts` follows, and a form is
    not the place to start distinguishing them. `index.md` is private under the
    PARA scaffold, so a `team`-scoped member cannot see it.
  */
  test("a note the caller cannot see is not an oracle for whether it holds a form", async () => {
    const f = await fixture();
    const hidden = await captureError(() =>
      asUser(f.t, f.member).action(api.functions.forms.submitForm, {
        workspaceId: f.workspaceId,
        path: "index.md",
        formId: "bugs",
        values: [{ field: "summary", value: "Hello" }],
      }),
    );
    const absent = await captureError(() =>
      asUser(f.t, f.member).action(api.functions.forms.submitForm, {
        workspaceId: f.workspaceId,
        path: "1-projects/no-such-note.md",
        formId: "bugs",
        values: [{ field: "summary", value: "Hello" }],
      }),
    );
    expect(JSON.stringify((hidden as { data?: unknown }).data)).toBe(
      JSON.stringify((absent as { data?: unknown }).data),
    );
    expect(f.backend.snapshot()["index.md"]).toBe("# Context\n");
  });

  /*
    THE GUARD THAT MAKES `minimum: "member"` SAFE.

    There is no path argument that names the *destination* — `responses:` is
    read out of a note an editor wrote — and on top of that the destination must
    already carry this form's marker. So even an editor who re-aims a form at
    `index.md` cannot turn a member's submission into a write over it.
  */
  test("a form re-aimed at an ordinary note cannot write over it", async () => {
    const f = await fixture();
    await rewriteForm(f, FORM_BLOCK.replace(`responses: ${RESPONSES}`, "responses: ../index.md"));

    const error = await captureError(() => submit(f, f.member, { summary: "Hello" }));
    expect(errorCode(error)).toBe("FORM_INVALID");
    expect(f.backend.snapshot()["index.md"]).toBe("# Context\n");
  });

  test("re-aiming at an existing note does not overwrite it when the form is saved", async () => {
    const f = await fixture();
    await asUser(f.t, f.editor).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/notes.md",
      text: "# Notes\n\nkeep me\n",
    });
    const read = await asUser(f.t, f.editor).action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: FORM_NOTE,
    });
    const result = await asUser(f.t, f.editor).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: FORM_NOTE,
      text: FORM_BLOCK.replace(`responses: ${RESPONSES}`, "responses: 1-projects/notes.md"),
      expectedEtag: read.etag,
    });

    expect(f.backend.snapshot()["1-projects/notes.md"]).toBe("# Notes\n\nkeep me\n");
    // And the author is told, rather than left with a form that quietly
    // collects nothing.
    expect(result.forms.occupied.join(" ")).toContain("notes.md");
    expect(result.forms.created).toEqual([]);
  });

  test("saving the same form twice does not empty the responses already in it", async () => {
    const f = await fixture();
    await submit(f, f.member, { summary: "Search is slow" });
    await rewriteForm(f, `${FORM_BLOCK}\n\nThanks.`);
    expect(responses(f)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*                     you can only change what is yours                      */
/* -------------------------------------------------------------------------- */

describe("editing and withdrawing", () => {
  test("a submitter may change their own answer", async () => {
    const f = await fixture();
    const sent = await submit(f, f.member, { summary: "Search is slow" });
    await asUser(f.t, f.member).action(api.functions.forms.updateSubmission, {
      workspaceId: f.workspaceId,
      path: FORM_NOTE,
      formId: "bugs",
      responseId: sent.responseId,
      values: [{ field: "summary", value: "Search is slow on big contexts" }],
    });
    expect(responses(f)[0].values.summary).toBe("Search is slow on big contexts");
    // `by` is not the submitter's to rewrite either: an edit changes answers.
    expect(responses(f)[0].by).toBe("@alan");
  });

  /*
    THE OWNERSHIP CHECK, EXERCISED BY SOMEBODY WHO GETS AS FAR AS IT.

    A stranger is refused at the workspace door and never reaches
    `assertMayChange`, so a test using one would pass with the ownership rule
    deleted. This is a second `member` of the same context: authorized to submit,
    authorized to read the file, and still not the author of that row.
  */
  test("but not another member's, even though they can see it", async () => {
    const f = await fixture();
    const mine = await submit(f, f.member, { summary: "Mine" });

    const error = await captureError(() =>
      asUser(f.t, f.other).action(api.functions.forms.retractSubmission, {
        workspaceId: f.workspaceId,
        path: FORM_NOTE,
        formId: "bugs",
        responseId: mine.responseId,
      }),
    );
    expect(errorCode(error)).toBe("FORM_FORBIDDEN");
    expect(responses(f)).toHaveLength(1);
    expect(responses(f)[0].by).toBe("@alan");
  });

  test("and not by editing it into their own either", async () => {
    const f = await fixture();
    const mine = await submit(f, f.member, { summary: "Mine" });
    const error = await captureError(() =>
      asUser(f.t, f.other).action(api.functions.forms.updateSubmission, {
        workspaceId: f.workspaceId,
        path: FORM_NOTE,
        formId: "bugs",
        responseId: mine.responseId,
        values: [{ field: "summary", value: "Actually mine" }],
      }),
    );
    expect(errorCode(error)).toBe("FORM_FORBIDDEN");
    expect(responses(f)[0].values.summary).toBe("Mine");
  });

  test("nor by an outsider, who never gets as far as the response at all", async () => {
    const f = await fixture();
    const mine = await submit(f, f.member, { summary: "Mine" });
    const error = await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.forms.retractSubmission, {
        workspaceId: f.workspaceId,
        path: FORM_NOTE,
        formId: "bugs",
        responseId: mine.responseId,
      }),
    );
    // Not `FORM_FORBIDDEN`: they are refused at the workspace, which must not
    // tell them a response with that id exists.
    expect(errorCode(error)).not.toBe("FORM_FORBIDDEN");
    expect(responses(f)).toHaveLength(1);
  });

  test("an editor may act on anybody's, because they could rewrite the file anyway", async () => {
    const f = await fixture();
    const theirs = await submit(f, f.member, { summary: "Theirs" });
    await asUser(f.t, f.editor).action(api.functions.forms.updateSubmission, {
      workspaceId: f.workspaceId,
      path: FORM_NOTE,
      formId: "bugs",
      responseId: theirs.responseId,
      values: [{ field: "summary", value: "Rewritten" }],
    });
    // Refusing here would be a lock on a door standing open: `writeNote` puts
    // the whole response file in their hands.
    expect(responses(f)[0].values.summary).toBe("Rewritten");
    // The author is still the author. An editor's correction does not make the
    // response theirs.
    expect(responses(f)[0].by).toBe("@alan");
  });

  test("a submitter may withdraw their own", async () => {
    const f = await fixture();
    const sent = await submit(f, f.member, { summary: "Never mind" });
    await asUser(f.t, f.member).action(api.functions.forms.retractSubmission, {
      workspaceId: f.workspaceId,
      path: FORM_NOTE,
      formId: "bugs",
      responseId: sent.responseId,
    });
    expect(responses(f)).toHaveLength(0);
  });

  test("`edit_own: false` makes an answer final, for its author and nobody above", async () => {
    const f = await fixture();
    await rewriteForm(f, FORM_BLOCK.replace("edit_own: true", "edit_own: false"));
    const sent = await submit(f, f.member, { summary: "Final" });

    const error = await captureError(() =>
      asUser(f.t, f.member).action(api.functions.forms.retractSubmission, {
        workspaceId: f.workspaceId,
        path: FORM_NOTE,
        formId: "bugs",
        responseId: sent.responseId,
      }),
    );
    expect(errorCode(error)).toBe("FORM_FORBIDDEN");
    expect(responses(f)).toHaveLength(1);

    // The editor is still able to, which is what makes this a policy about
    // submitters rather than a lock on the file.
    await asUser(f.t, f.editor).action(api.functions.forms.retractSubmission, {
      workspaceId: f.workspaceId,
      path: FORM_NOTE,
      formId: "bugs",
      responseId: sent.responseId,
    });
    expect(responses(f)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   votes                                    */
/* -------------------------------------------------------------------------- */

describe("upvotes", () => {
  test("are named, so voting twice is one vote", async () => {
    const f = await fixture();
    const sent = await submit(f, f.member, { summary: "Search is slow" });
    const vote = () =>
      asUser(f.t, f.editor).action(api.functions.forms.voteForm, {
        workspaceId: f.workspaceId,
        path: FORM_NOTE,
        formId: "bugs",
        responseId: sent.responseId,
      });

    expect((await vote()).votes).toBe(1);
    expect((await vote()).votes).toBe(1);
    expect(responses(f)[0].votes).toEqual(["@grace"]);
  });

  test("can be taken back, and taking back one never cast is not an error", async () => {
    const f = await fixture();
    const sent = await submit(f, f.member, { summary: "Search is slow" });
    const none = () =>
      asUser(f.t, f.editor).action(api.functions.forms.voteForm, {
        workspaceId: f.workspaceId,
        path: FORM_NOTE,
        formId: "bugs",
        responseId: sent.responseId,
        vote: "none" as const,
      });
    expect((await none()).votes).toBe(0);
    expect((await none()).votes).toBe(0);
  });

  test("a form with votes off refuses one rather than counting it invisibly", async () => {
    const f = await fixture();
    /*
      Pointed at a *fresh* response file, which is what turning votes off
      requires: the Votes column is part of the table's shape, so an existing
      file no longer matches and `parseResponsesFile` says so rather than
      migrating it. That refusal has its own test below.
    */
    await rewriteForm(
      f,
      FORM_BLOCK.replace("votes: named", "votes: off").replace(
        `responses: ${RESPONSES}`,
        "responses: 1-projects/quiet-responses.md",
      ),
    );
    const sent = await submit(f, f.member, { summary: "Search is slow" });
    const error = await captureError(() =>
      asUser(f.t, f.member).action(api.functions.forms.voteForm, {
        workspaceId: f.workspaceId,
        path: FORM_NOTE,
        formId: "bugs",
        responseId: sent.responseId,
      }),
    );
    expect(errorCode(error)).toBe("FORM_FORBIDDEN");
  });

  /*
    CHANGING THE SHAPE UNDER EXISTING RESPONSES IS A BREAKING CHANGE.

    Rows already written are the wrong shape for the new layout, and the answer
    is to refuse rather than to migrate — nothing already written is ever
    rewritten, and the old file stays readable exactly as it was. The way out is
    to point the form at a fresh file, which the test above does.
  */
  test("turning votes off over an existing response file refuses rather than rewriting it", async () => {
    const f = await fixture();
    await submit(f, f.member, { summary: "Search is slow" });
    const before = f.backend.snapshot()[RESPONSES];

    await rewriteForm(f, FORM_BLOCK.replace("votes: named", "votes: off"));
    const error = await captureError(() => submit(f, f.member, { summary: "Another" }));

    expect(errorCode(error)).toBe("FORM_INVALID");
    expect(f.backend.snapshot()[RESPONSES]).toBe(before);
  });

});

/* -------------------------------------------------------------------------- */
/*                   the values are checked, never interpolated               */
/* -------------------------------------------------------------------------- */

describe("what a member may put in a field", () => {
  test("an answer that mimics a table row does not forge a second response", async () => {
    const f = await fixture();
    await submit(f, f.member, { summary: "a | b | @someone | 99 | x" });
    const rows = responses(f);
    expect(rows).toHaveLength(1);
    expect(rows[0].values.summary).toBe("a | b | @someone | 99 | x");
    expect(rows[0].by).toBe("@alan");
    expect(rows[0].votes).toEqual([]);
  });

  test("a field that is not on the form is refused", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      submit(f, f.member, { summary: "ok", nonesuch: "smuggled" }),
    );
    expect(errorCode(error)).toBe("FORM_INVALID");
    expect(f.backend.snapshot()[RESPONSES]).not.toContain("smuggled");
  });

  test("a select answer outside the declared options is refused", async () => {
    const f = await fixture();
    const error = await captureError(() => submit(f, f.member, { summary: "ok", area: "billing" }));
    expect(errorCode(error)).toBe("FORM_INVALID");
  });

  test("a required field left empty is refused", async () => {
    const f = await fixture();
    const error = await captureError(() => submit(f, f.member, { area: "app" }));
    expect(errorCode(error)).toBe("FORM_INVALID");
  });

  test("an answer past the declared limit is refused", async () => {
    const f = await fixture();
    const error = await captureError(() => submit(f, f.member, { summary: "x".repeat(121) }));
    expect(errorCode(error)).toBe("FORM_INVALID");
  });

  test("one field answered twice is refused rather than resolved", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.member).action(api.functions.forms.submitForm, {
        workspaceId: f.workspaceId,
        path: FORM_NOTE,
        formId: "bugs",
        values: [
          { field: "summary", value: "first" },
          { field: "summary", value: "second" },
        ],
      }),
    );
    expect(errorCode(error)).toBe("FORM_INVALID");
  });
});

/* -------------------------------------------------------------------------- */
/*                          storage, honestly degraded                        */
/* -------------------------------------------------------------------------- */

describe("a store that cannot do conditional writes", () => {
  /*
    A form is the most contended write in the product — a bug tracker shared
    with everybody is many people appending to one file. Without `If-Match` two
    submissions seconds apart silently become one, and silence here destroys a
    customer's data rather than merely disappointing them. So it is refused
    with the reason.
  */
  test("refuses the submission with the reason rather than losing it", async () => {
    const f = await fixture({ conditionalWrite: false });
    const error = await captureError(() => submit(f, f.member, { summary: "Search is slow" }));
    expect(errorCode(error)).toBe("FORM_STORAGE_UNSUITABLE");
    expect(String((error as { data?: { message?: string } }).data?.message)).toContain(
      "conditional writes",
    );
  });
});

describe("what the caller's role lets them see", () => {
  /*
    The scope a form is resolved under comes from the caller's role
    (`scopeForRole`), not from a constant. An owner reads `private`, everybody
    below reads `team` — so a form on a private note is the owner's to answer
    and invisible to a member, with the same "does not exist" as a note that is
    not there. Assumed rather than derived, this is the one line that would
    hand a member the private half of a context.
  */
  test("a form on a private note is answerable by the owner and invisible to a member", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: FORM_NOTE,
      visibility: "private",
    });

    const hidden = await captureError(() => submit(f, f.member, { summary: "Mine" }));
    expect(errorCode(hidden)).toBe("FILE_NOT_FOUND");
    expect(responses(f)).toHaveLength(0);

    const sent = await submit(f, f.owner, { summary: "The owner's" });
    expect(sent.formId).toBe("bugs");
    expect(responses(f).map((row) => row.by)).toEqual(["@ada"]);
  });
});

describe("two submissions racing for the same file", () => {
  /*
    THE RETRY, EXERCISED AGAINST A REAL LOST CONDITIONAL WRITE.

    Run against `runFormAction` and an in-memory store directly, in the style of
    `fileOps.test.ts`, because the race cannot be staged through the action: two
    `submitForm` calls in a test run one after the other and never overlap, so a
    test built from them passes with the retry deleted — which is exactly what
    an earlier version of this file did, and the sabotage pass caught it.

    Here the store *is* the other submitter. Its first conditional write loses
    the way a real one does — somebody else's response landed in between, so the
    etag no longer matches and the put returns `null` — and the second pass has
    to read that response back and re-apply ours on top of it. Nothing of
    either is lost.
  */
  const RACE_FORM = [
    "```form",
    "id: bugs",
    "responses: responses.md",
    "layout: table",
    "submit: member",
    "votes: named",
    "fields:",
    "  - { name: summary, type: line, max: 120, required: true }",
    "```",
  ].join("\n");

  /** A store whose first conditional write is beaten by somebody else's. */
  function contended(): MemoryStore & FileStore & { puts: number } {
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    store.seed("form.md", RACE_FORM);
    const config = (parseFormBlocks(RACE_FORM) as Array<{ config?: unknown }>)[0].config;
    store.seed("responses.md", emptyResponsesFile(config) as string);

    const realPut = store.put.bind(store);
    let puts = 0;
    const wrapped = store as MemoryStore & FileStore & { puts: number };
    wrapped.put = async (key, body, options) => {
      puts += 1;
      wrapped.puts = puts;
      if (puts === 1 && key === "responses.md") {
        /*
          The competing submission lands *now*, between our read and our write,
          and then our write is passed to the real store **unchanged**.

          That last part is what makes this a test rather than a fixture: the
          store, not this wrapper, decides whether our put lands, by checking
          the `If-Match` it was sent against the etag the competitor left. Code
          that stopped sending the precondition would have its write accepted
          here and would silently erase "Theirs" — which is the production bug,
          and which an earlier version of this stub hid by returning `null`
          itself no matter what it was sent.
        */
        await realPut(
          key,
          renderResponsesFile(config, [
            {
              id: "r-00000001",
              by: "@someone-else",
              at: "2026-09-12T00:00:00Z",
              values: { summary: "Theirs" },
              votes: [],
            },
          ]) as string,
        );
      }
      return realPut(key, body, options);
    };
    return wrapped;
  }

  test("the loser is retried on top of the winner, and neither is lost", async () => {
    const store = contended();
    const result = await runFormAction(store, {
      scope: "private",
      path: "form.md",
      formId: "bugs",
      actor: { name: "@alan", role: "member" },
      action: { kind: "submit", values: [{ field: "summary", value: "Mine" }] },
    });

    // It really did lose once: a green test with one put would be a test of
    // nothing.
    expect(store.puts).toBeGreaterThan(1);

    const config = (parseFormBlocks(RACE_FORM) as Array<{ config?: unknown }>)[0].config;
    const parsed = parseResponsesFile(store.snapshot()["responses.md"], config) as {
      responses?: Array<{ id: string; by: string; values: Record<string, string> }>;
    };
    expect(parsed.responses?.map((row) => row.values.summary)).toEqual(["Theirs", "Mine"]);
    expect(parsed.responses?.map((row) => row.by)).toEqual(["@someone-else", "@alan"]);
    expect(parsed.responses?.some((row) => row.id === result.responseId)).toBe(true);
  });

  test("and gives up with a conflict rather than looping, when it keeps losing", async () => {
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    store.seed("form.md", RACE_FORM);
    const config = (parseFormBlocks(RACE_FORM) as Array<{ config?: unknown }>)[0].config;
    store.seed("responses.md", emptyResponsesFile(config) as string);
    // Every conditional write loses. A retry loop with no bound would hang.
    store.put = async () => null;

    await expect(
      runFormAction(store, {
        scope: "private",
        path: "form.md",
        formId: "bugs",
        actor: { name: "@alan", role: "member" },
        action: { kind: "submit", values: [{ field: "summary", value: "Mine" }] },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
