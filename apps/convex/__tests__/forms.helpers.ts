/**
 * The forms suite's workspace: a shared workspace with an owner, an editor, a
 * read-only member and an outsider, a form note in a team folder, and helpers
 * to rewrite and answer it. Shared by `forms.test.ts` and `formsTree.test.ts`.
 */

import { vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3, type MemoryS3Options } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  type TestConvex,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  setupTest,
} from "./fixtures.helpers";
import { renderPrivacyManifest } from "./seededRules.helpers";

export const FORM_NOTE = "1-projects/feedback.md";
export const RESPONSES = "1-projects/feedback-responses.md";

export const FORM_BLOCK = [
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

export interface Fixture {
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
 * outsider — and a personal workspace for each of the four.
 *
 * The workspaces are not decoration. A response is recorded under its author's
 * **username**, which `formActor` reads from their own personal workspace's
 * slug, so a fixture without them would prove nothing about `by` and every
 * submission would refuse with `NO_USERNAME`.
 */
export async function fixture(options: MemoryS3Options & { conditionalWrite?: boolean } = {}) {
  const { conditionalWrite = true, ...bucketOptions } = options;
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const other = await createUser(t, "other@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");

  // Each person's own workspace, which is where their username lives.
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
export async function rewriteForm(f: Fixture, text: string): Promise<void> {
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

export function submit(f: Fixture, who: Id<"users">, values: Record<string, string>) {
  return asUser(f.t, who).action(api.functions.forms.submitForm, {
    workspaceId: f.workspaceId,
    path: FORM_NOTE,
    formId: "bugs",
    values: Object.entries(values).map(([field, value]) => ({ field, value })),
  });
}
