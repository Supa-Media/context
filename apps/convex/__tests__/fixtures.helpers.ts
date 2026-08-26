/**
 * Shared fixtures for the control-plane tests.
 *
 * Deliberately thin. These tests exist to prove authorization, so the setup
 * must not quietly do anything the real code would refuse to do — with one
 * exception, `addMember`, which inserts a membership row directly to furnish a
 * shared context in one line. `joinViaInvitation` does the same thing through
 * the real invitation flow, and is what the membership and invitation tests
 * use. Everything else goes through the real public functions.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { convexTest, type TestConvex as TestConvexFor } from "convex-test";
import schema from "../schema";
import { modules } from "../test.setup";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";

/**
 * Bound to our schema on purpose. `ReturnType<typeof convexTest>` would
 * instantiate the generic with the default and silently degrade every `t.run`
 * to `any`, which would let a test reference a field that does not exist and
 * still pass.
 */
export type TestConvex = TestConvexFor<typeof schema>;

export function setupTest(): TestConvex {
  return convexTest(schema, modules);
}

/** A signed-in view of the world for one user. */
export function asUser(t: TestConvex, userId: Id<"users">) {
  return t.withIdentity({ subject: userId, issuer: "https://test.invalid" });
}

export async function createUser(
  t: TestConvex,
  email: string,
): Promise<Id<"users">> {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      email,
      emailVerificationTime: Date.now(),
      createdAt: Date.now(),
    }),
  );
}

/** Create a workspace through the real mutation, as its owner. */
export async function createWorkspace(
  t: TestConvex,
  ownerId: Id<"users">,
  slug: string,
  options: {
    displayName?: string;
    kind?: "personal" | "shared";
    structureTemplate?: "para" | "custom";
  } = {},
): Promise<Id<"workspaces">> {
  const result = await asUser(t, ownerId).mutation(
    api.functions.workspaces.createWorkspace,
    {
      slug,
      displayName: options.displayName ?? slug,
      kind: options.kind ?? "personal",
      structureTemplate: options.structureTemplate,
    },
  );
  return result.workspaceId;
}

/**
 * Add a member directly.
 *
 * A shortcut, and now a real one: `joinViaInvitation` below does this through
 * `inviteMember` + `acceptInvitation`, and the invitation and membership suites
 * use that. This stays because most of the older tests only need "a workspace
 * with a second person in it" and should not also depend on how that person got
 * there — a fixture that exercises three mutations is a fixture that can fail
 * for reasons the test is not about.
 */
export async function addMember(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  role: "owner" | "editor" | "member",
  invitedBy?: Id<"users">,
): Promise<void> {
  await t.run((ctx) =>
    ctx.db.insert("workspaceMembers", {
      workspaceId,
      userId,
      role,
      invitedBy,
      joinedAt: Date.now(),
    }),
  );
}

/**
 * The token of the one pending invitation addressed to `userId`, or `null`.
 *
 * Read the way the product reads it — through `listMyInvitations`, the
 * invitee's own query — rather than off the row, so a test that uses this is
 * also asserting that the delivery channel works.
 */
export async function pendingInvitationToken(
  t: TestConvex,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
): Promise<string | null> {
  const mine = await asUser(t, userId).query(
    api.functions.invitations.listMyInvitations,
    {},
  );
  return mine.find((row) => row.workspaceId === workspaceId)?.token ?? null;
}

/**
 * Invite somebody and have them accept — the whole real flow, in one line.
 *
 * Unlike `addMember`, every step here is a public mutation, so a fixture built
 * on it cannot set up a state the product could not reach.
 */
export async function joinViaInvitation(
  t: TestConvex,
  options: {
    workspaceId: Id<"workspaces">;
    owner: Id<"users">;
    invitee: Id<"users">;
    /** The `@name` or address the invitation is sent to. */
    addressedTo: string;
    role: "editor" | "member";
  },
): Promise<void> {
  await asUser(t, options.owner).mutation(api.functions.invitations.inviteMember, {
    workspaceId: options.workspaceId,
    invitee: options.addressedTo,
    role: options.role,
  });
  const token = await pendingInvitationToken(t, options.invitee, options.workspaceId);
  if (token === null) {
    throw new Error(`no invitation reached ${options.addressedTo}`);
  }
  await asUser(t, options.invitee).mutation(
    api.functions.invitations.acceptInvitation,
    { token },
  );
}

/** Obviously fake storage credentials. Never real ones, not even expired. */
export const FAKE_STORAGE = {
  provider: "r2" as const,
  endpoint: "https://accountid.r2.cloudflarestorage.example/",
  region: "auto",
  bucket: "example-context-bucket",
  accessKeyId: "EXAMPLEACCESSKEYID00",
  secretAccessKey: "example-secret-access-key-not-real-000000",
};

export async function bindFakeStorage(
  t: TestConvex,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
  overrides: Partial<typeof FAKE_STORAGE> & {
    rootPrefix?: string;
    forcePathStyle?: boolean;
  } = {},
) {
  return await asUser(t, userId).action(api.functions.storage.bindStorage, {
    workspaceId,
    ...FAKE_STORAGE,
    ...overrides,
  });
}

/**
 * Run every queued scheduled function to completion.
 *
 * `finishInProgressScheduledFunctions()` only awaits jobs that have already
 * *started*, and a `runAfter(0)` job sits `pending` behind a real 0ms timer
 * until the event loop gets a turn. Awaiting it straight after the mutation
 * therefore returns immediately, having waited for nothing — a test written
 * that way asserts on the state before verification and passes or fails for
 * reasons unrelated to the code. So: yield, drain, repeat until the queue is
 * empty, and fail loudly rather than silently proceeding if it never is.
 */
export async function drainScheduled(t: TestConvex): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const outstanding = jobs.filter(
      (job) => job.state.kind === "pending" || job.state.kind === "inProgress",
    );
    if (outstanding.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
    await t.finishInProgressScheduledFunctions();
  }
  throw new Error("scheduled functions never drained");
}

/**
 * A storage binding in a chosen state, with **no verification queued**.
 *
 * Inserted directly rather than through `bindStorage`, for the reason
 * `provisioning.test.ts` gives at length: `bindStorage` schedules a
 * `runAfter(0)` probe, `convex-test` starts those eagerly on a real timer, and
 * a probe that cannot reach the network flips the row to `error` partway
 * through whatever the test was actually about. A test whose fixture races
 * itself is worse than no test.
 *
 * The envelope is produced by the real `encryptSecret`, bound to this
 * workspace, so the decrypt path exercised downstream is the real one.
 */
export async function seedStorageBinding(
  t: TestConvex,
  options: {
    workspaceId: Id<"workspaces">;
    boundBy: Id<"users">;
    status?: "unverified" | "connected" | "error";
    endpoint?: string;
    bucket?: string;
    rootPrefix?: string;
    forcePathStyle?: boolean;
    accessKeyId?: string;
    secretAccessKey?: string;
    capabilities?: { conditionalWrite: boolean };
    lastError?: string;
    errorCode?: string;
  },
): Promise<void> {
  const secretAccessKey = options.secretAccessKey ?? FAKE_STORAGE.secretAccessKey;
  const encryptedSecretAccessKey = await encryptSecret(
    secretAccessKey,
    requireKeyset(),
    { workspaceId: options.workspaceId },
  );
  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId: options.workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: options.endpoint ?? FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: options.bucket ?? FAKE_STORAGE.bucket,
      rootPrefix: options.rootPrefix,
      forcePathStyle: options.forcePathStyle,
      accessKeyId: options.accessKeyId ?? FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: options.capabilities ?? { conditionalWrite: true },
      status: options.status ?? "connected",
      lastVerifiedAt: options.status === "connected" ? now : undefined,
      lastError: options.lastError,
      errorCode: options.errorCode,
      boundBy: options.boundBy,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

/**
 * The gateway secret the test deployment expects. Obviously fake, and mirrored
 * in `vitest.config.ts` — the tests need to know it in order to prove it never
 * escapes into a response or an audit row.
 */
export const TEST_GATEWAY_SECRET = "test-gateway-secret-not-a-real-one";

/**
 * The Email Worker's secret. A different value, on purpose — see
 * `EMAIL_WORKER_SECRET_ENV_VAR` in `functions/lib/gatewayAuth.ts`.
 */
export const TEST_EMAIL_WORKER_SECRET = "test-email-worker-secret-not-a-real-one";

/**
 * One ingest call, exactly as the Email Worker makes it.
 *
 * A separate helper from `gatewayPost` rather than a `secret` option on it,
 * because the point of these routes is that they are behind a *different* door.
 * A test that reached them by passing the gateway secret to `gatewayPost` would
 * be testing a deployment we do not want to have.
 */
export async function ingestPost(
  t: TestConvex,
  path: string,
  body: unknown,
  options: { secret?: string | null } = {},
): Promise<Response> {
  const secret =
    options.secret === undefined ? TEST_EMAIL_WORKER_SECRET : options.secret;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;

  return await t.fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** One control-plane call, exactly as the gateway makes it. */
export async function gatewayPost(
  t: TestConvex,
  path: string,
  body: unknown,
  options: { secret?: string | null } = {},
): Promise<Response> {
  const secret = options.secret === undefined ? TEST_GATEWAY_SECRET : options.secret;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // `null` means "send no Authorization header at all", which is a different
  // request from "send the wrong secret" and must get the identical answer.
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;

  return await t.fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * Everything about a response that a caller can observe.
 *
 * Two refusals being "both null" is not the property that matters —
 * `isolation.test.ts` makes the same point about error payloads. What matters
 * is that a caller cannot tell them apart at all, so the comparison is over
 * the status, the headers, and the bytes.
 */
export async function responseFingerprint(response: Response): Promise<string> {
  const headers = [...response.headers.entries()]
    .map(([key, value]) => `${key.toLowerCase()}: ${value}`)
    .sort()
    .join("\n");
  return `${response.status}\n${headers}\n${await response.text()}`;
}

/** Seed a grant directly — the OAuth flow lives in the gateway, not here. */
export async function seedGrant(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  clientId: string,
  hashedRefreshToken: string,
): Promise<Id<"oauthGrants">> {
  return await t.run((ctx) =>
    ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId,
      scopes: ["context.read"],
      hashedRefreshToken,
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

/** The `code` field of a thrown ConvexError, or `undefined` for anything else. */
export function errorCode(error: unknown): string | undefined {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "object" && data !== null && "code" in data) {
    return (data as { code?: string }).code;
  }
  return undefined;
}

/** Run `fn` and return the thrown error, or fail loudly if it did not throw. */
export async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw, but it resolved.");
}
