/**
 * The pinned workspace as production has it on the day "team means members" ships
 * (`docs/decisions/privacy-and-sharing/all-context-users.md`): staff own `@context-lc`, a bucket behind it, its rows
 * the authority, and three kinds of note in it.
 *
 *  - `guides/`, a folder at base `team`: the notes every account was meant to read, the bug-report form among them.
 *  - `1-projects/plan.md` in the #1912 Members position (base `private` plus the `members` grant), and the `areas/`
 *    folder in the same position, holding `areas/ai/bench.md`, the note a benchmark runner reads through an MCP
 *    connection. A real member's MCP connection holds no granted names, so before the migration it cannot read that.
 *  - `1-projects/secret.md` at `private`, and an old bug report at `areas/tex-bugs/user/old.md` opened to `team`.
 *
 * Sayo reaches it through the pin alone; Mel is a real member. Both have an ordinary MCP grant on their own personal
 * workspace, which is how every AI client reaches the pin. Every value is fake, and every body carries the one word
 * the search tests look for, so a note that is found and should not be is a failure rather than a coincidence.
 */

import { vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { hashToken } from "../functions/lib/crypto";
import { setAccessRow, type GranteeInput } from "../functions/lib/nodes/setAccess";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  addMember,
  asUser,
  copyTree,
  createUser,
  createWorkspace,
  drainScheduled,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { registerClient, seedConnectedClient, token } from "./controlPlane/fixtures.helpers";

export const WORD = "zzqpinword";
export const GUIDE = "guides/start.md";
export const FORM = "guides/bug-reports.md";
export const RESPONSES = "guides/bug-reports-responses.md";
export const PLAN = "1-projects/plan.md";
export const SECRET = "1-projects/secret.md";
export const BENCH = "areas/ai/bench.md";
export const OLD_BUG = "areas/tex-bugs/user/old.md";
export const NOTES = [GUIDE, FORM, PLAN, SECRET, BENCH, OLD_BUG] as const;

export const SAYO_TOKEN = token("pin_sayo");
export const MEL_TOKEN = token("pin_mel");
const CLIENT = "mcp_client_pinned";
const BUCKET = "pinned-readers";

const FORM_BLOCK = [
  "# Bug reports",
  "",
  WORD,
  "",
  "```form",
  "id: bugs",
  `responses: ${RESPONSES}`,
  "layout: table",
  "submit: member",
  "fields:",
  "  - { name: summary, type: line, max: 120, required: true }",
  "```",
].join("\n");

export interface PinnedWorld {
  t: TestConvex;
  staff: Id<"users">;
  /** A real member of the pinned workspace. */
  mel: Id<"users">;
  /** Reaches the pinned workspace through the pin alone. */
  sayo: Id<"users">;
  pinned: Id<"workspaces">;
  backend: MemoryS3;
}

export async function pinnedWorld(): Promise<PinnedWorld> {
  vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
  const t = setupTest();
  const staff = await createUser(t, "staff@example.invalid");
  await createWorkspace(t, staff, "staff-personal");
  const pinned = await createWorkspace(t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
  const mel = await createUser(t, "mel@example.invalid");
  const melOwn = await createWorkspace(t, mel, "mel");
  await addMember(t, pinned, mel, "member", staff);
  const sayo = await createUser(t, "sayo@example.invalid");
  const sayoOwn = await createWorkspace(t, sayo, "sayo");

  const backend = memoryS3(BUCKET);
  backend.seed("index.md", "# Context\n");
  for (const path of NOTES) if (path !== FORM) backend.seed(path, `# ${path}\n\n${WORD}\n`);
  vi.stubGlobal("fetch", backend.fetchImpl);
  await seedStorageBinding(t, { workspaceId: pinned, boundBy: staff, bucket: BUCKET });
  await copyTree(t, pinned);
  await t.run(async (ctx) => {
    const migration = await ctx.db.query("nodeMigration").first();
    const flags = { accessSource: "rows" as const, privacyAuthority: true };
    if (migration === null) await ctx.db.insert("nodeMigration", { paused: false, updatedAt: 1, ...flags });
    else await ctx.db.patch(migration._id, flags);
    const privacy = await ctx.db.query("nodePrivacy").withIndex("by_workspace", (q) => q.eq("workspaceId", pinned)).first();
    const authorityRow = { etag: "e1", invalid: false, folders: [], notes: [] };
    if (privacy === null) await ctx.db.insert("nodePrivacy", { workspaceId: pinned, observedAt: 1, ...authorityRow });
    else await ctx.db.patch(privacy._id, authorityRow);
  });

  const w: PinnedWorld = { t, staff, mel, sayo, pinned, backend };
  await setRow(w, "guides", "team");
  await setRow(w, PLAN, "private", [{ kind: "members", role: "view" }]);
  await setRow(w, "areas", "private", [{ kind: "members", role: "view" }]);
  await setRow(w, SECRET, "private");
  await setRow(w, OLD_BUG, "team");
  // Written by staff, as an editor writes a form, which is also what creates its response file.
  await asUser(t, staff).action(api.functions.files.writeNote, { workspaceId: pinned, path: FORM, text: FORM_BLOCK });

  await registerClient(t, CLIENT);
  await seedConnectedClient(t, { workspaceId: sayoOwn, userId: sayo, clientId: CLIENT, accessToken: SAYO_TOKEN, scopes: ["context:read", "context:write"] });
  await seedConnectedClient(t, { workspaceId: melOwn, userId: mel, clientId: CLIENT, accessToken: MEL_TOKEN, scopes: ["context:read", "context:write"] });
  return w;
}

/** Set one row's base and list, as the owner. */
export async function setRow(
  w: PinnedWorld,
  path: string,
  base: "private" | "team",
  grantees: GranteeInput[] = [],
): Promise<void> {
  const result = await w.t.run(async (ctx) =>
    await setAccessRow(ctx as unknown as MutationCtx, {
      workspaceId: w.pinned,
      path,
      base,
      grantees,
      actor: { userId: w.staff, role: "owner" },
    }),
  );
  if (!result.ok) throw new Error(`setAccessRow refused ${path}: ${result.code}`);
}

/** Run the migration to its end, as staff run it: `npx convex run functions/pinnedAccounts:start`. */
export async function migrate(w: PinnedWorld, pageSize?: number): Promise<string> {
  const started = await w.t.mutation(internal.functions.pinnedAccounts.start, pageSize === undefined ? {} : { pageSize });
  await drainScheduled(w.t);
  return started;
}

/** What `authorizeFileAccess` hands every console read for this person in the pinned workspace. */
export async function clearanceOf(w: PinnedWorld, userId: Id<"users">) {
  return await w.t.query(internal.functions.files.authorizeFileAccess, {
    actorUserId: userId,
    workspaceId: w.pinned,
    minimum: "member",
  });
}

/** Which of the world's notes a clearance reaches, through the bucket's own read path. */
export async function visibleTo(w: PinnedWorld, scope: "private" | "team", grantedNames: string[] | undefined): Promise<string[]> {
  const seen = await w.t.action(internal.functions.files.runFileOperation, {
    workspaceId: w.pinned,
    scope,
    ...(grantedNames === undefined ? {} : { grantedNames }),
    operation: { kind: "visiblePaths", paths: [...NOTES, RESPONSES] },
  });
  return seen.kind === "visiblePaths" ? [...seen.paths].sort() : [];
}

/** The same, for a person, through the clearance the console gives them. */
export async function visibleToPerson(w: PinnedWorld, userId: Id<"users">): Promise<string[]> {
  const { scope, grantedNames } = await clearanceOf(w, userId);
  return await visibleTo(w, scope, grantedNames);
}

/** The pinned workspace's entry in an MCP session, as the control plane resolves it for the gateway. */
export async function sessionEntry(w: PinnedWorld, accessToken: string) {
  const session = await w.t.query(internal.functions.controlPlane.resolveGrantByAccessToken, {
    hashedAccessToken: await hashToken(accessToken),
  });
  return session?.workspaces.find((entry) => entry.workspaceId === w.pinned) ?? null;
}
