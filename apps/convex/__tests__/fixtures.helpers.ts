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
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { beginCopyPass, copyRowOf } from "../functions/lib/noteIds/state";

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

const ISSUER = "https://test.invalid";
/** Far enough out that no fake clock in this suite reaches it. */
const FIXTURE_FOREVER = Date.UTC(2100, 0, 1);

/**
 * A signed-in view of the world for one user, as somebody who has confirmed an
 * emailed code on this device: every big change is open to them, which is
 * what nearly every test means by "the owner does X".
 *
 * This is the fixture's one deliberate shortcut past real code (alongside
 * `addMember`): it writes a session and an email proof directly. The guard
 * itself is proven where it matters, with `asPhoneOnly` below, in
 * `emailProof*.test.ts`. A deleted session is recreated, so a test that signs
 * everyone out and acts again still acts as a proven person.
 */
export function asUser(t: TestConvex, userId: Id<"users">) {
  const identity = async () => {
    const sessionId = await provenSessionFor(t, userId);
    return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: ISSUER });
  };
  return {
    query: (async (...args: unknown[]) => ((await identity()).query as (...a: unknown[]) => unknown)(...args)) as ReturnType<TestConvex["withIdentity"]>["query"],
    mutation: (async (...args: unknown[]) => ((await identity()).mutation as (...a: unknown[]) => unknown)(...args)) as ReturnType<TestConvex["withIdentity"]>["mutation"],
    action: (async (...args: unknown[]) => ((await identity()).action as (...a: unknown[]) => unknown)(...args)) as ReturnType<TestConvex["withIdentity"]>["action"],
    fetch: (async (...args: unknown[]) => ((await identity()).fetch as (...a: unknown[]) => unknown)(...args)) as ReturnType<TestConvex["withIdentity"]>["fetch"],
  };
}

/**
 * Sessions a test made for itself, without the ones `asUser` wrote: for the
 * tests that count what a sign-in or a deletion left behind.
 */
export function withoutFixtureSessions<T extends { expirationTime: number }>(rows: T[]): T[] {
  return rows.filter((row) => row.expirationTime !== FIXTURE_FOREVER);
}

const provenSessions = new WeakMap<TestConvex, Map<string, Id<"authSessions">>>();

export async function provenSessionFor(t: TestConvex, userId: Id<"users">): Promise<Id<"authSessions">> {
  let byUser = provenSessions.get(t);
  if (byUser === undefined) {
    byUser = new Map();
    provenSessions.set(t, byUser);
  }
  const known = byUser.get(userId);
  const sessionId = await t.run(async (ctx) => {
    if (known !== undefined && (await ctx.db.get(known)) !== null) return known;
    const id = await ctx.db.insert("authSessions", { userId, expirationTime: FIXTURE_FOREVER });
    await ctx.db.insert("emailProofs", { userId, sessionId: id, until: FIXTURE_FOREVER });
    return id;
  });
  byUser.set(userId, sessionId);
  return sessionId;
}

/** A device signed in with a texted code and nothing else: no email confirmed. */
export async function asPhoneOnly(t: TestConvex, userId: Id<"users">) {
  const sessionId = await t.run((ctx) => ctx.db.insert("authSessions", { userId, expirationTime: FIXTURE_FOREVER }));
  return { sessionId, view: t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: ISSUER }) };
}

/** A token with no session in it at all, as the older fixtures made. */
export function asSessionless(t: TestConvex, userId: Id<"users">) {
  return t.withIdentity({ subject: userId, issuer: ISSUER });
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
 *
 * A job queued for later than `LATER_MS` from now is left alone: on real
 * timers no drain could reach it, and the one that motivated this (the tree's
 * parity re-check, half a minute after a write in flight made the first check
 * differ) is a staff alarm no test is about.
 */
const LATER_MS = 10_000;
// Rounds a drain may take: keyed workspaces chain more passes than path-keyed ones did (a write's
// fact fill, a scan's next page), so a slow runner needs more than the 50 a bound used to allow.
const DRAIN_ROUNDS = 500;
export async function drainScheduled(t: TestConvex): Promise<void> {
  for (let attempt = 0; attempt < DRAIN_ROUNDS; attempt += 1) {
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const outstanding = jobs.filter(
      (job) =>
        (job.state.kind === "pending" && job.scheduledTime <= Date.now() + LATER_MS) ||
        job.state.kind === "inProgress",
    );
    if (outstanding.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
    await t.finishInProgressScheduledFunctions();
  }
  throw new Error("scheduled functions never drained");
}

/**
 * The workspace's first copy into the Convex tree, run to its end against the
 * bucket it is bound to. Every reader of which notes exist reads that tree
 * and never the bucket (decided by the owner, 2026-10-13; see
 * `docs/decisions/app-and-console/convex-tree.md`), so a fixture that seeds a
 * bucket copies it before anything lists it, as the first walk of a real
 * workspace does. A change made through the app keeps the copy current on its
 * own; one written straight into the bucket afterwards needs another call,
 * as a real one waits for the next sweep.
 */
export async function copyTree(t: TestConvex, workspaceId: Id<"workspaces">): Promise<void> {
  await sweepToEnd(t, workspaceId);
  await keyWorkspace(t, workspaceId);
}

async function sweepToEnd(t: TestConvex, workspaceId: Id<"workspaces">): Promise<void> {
  for (let pass = 0; pass < 50; pass += 1) {
    await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "nodesSweep" },
    });
    const state = await t.query(internal.functions.nodes.state, { workspaceId });
    if (state?.status === "ready" && state.cursor === undefined && state.dirty !== true) return;
  }
  throw new Error("the tree's first copy never finished");
}

/**
 * Key the workspace the way production keyed every workspace: every note
 * copied to its id key by the real copy pass, and the pass's end flipping the
 * rows to those keys. After it, the bucket's path objects are frozen copies
 * nothing reads again, so a test changes notes through the product, never by
 * writing a path into the bucket.
 */
export async function keyWorkspace(t: TestConvex, workspaceId: Id<"workspaces">): Promise<void> {
  if (await t.run(async (ctx) => (await copyRowOf(ctx.db, workspaceId))?.keyedDoneAt !== undefined)) return;
  await t.run(async (ctx) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    if (layout === null) await ctx.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1 });
    else if (layout.mode !== "keys") await ctx.db.patch(layout._id, { mode: "keys" });
    // A whole listing first, so every row names the version the bucket holds now.
    const tree = (await ctx.db.query("nodeTrees").collect()).find((row) => row.workspaceId === workspaceId);
    if (tree !== undefined) await ctx.db.patch(tree._id, { dirty: true });
  });
  await sweepToEnd(t, workspaceId);
  await t.mutation(internal.functions.noteIdsCopy.backfill, { workspaceId });
  await t.run((ctx) => beginCopyPass(ctx, workspaceId, { force: true }));
  // A big workspace's copy runs as a chain of passes, longer than one drain.
  let row = await t.run((ctx) => copyRowOf(ctx.db, workspaceId));
  for (let round = 0; round < 1_000 && row?.keyedDoneAt === undefined; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await t.finishInProgressScheduledFunctions();
    row = await t.run((ctx) => copyRowOf(ctx.db, workspaceId));
  }
  if (row?.keyedDoneAt === undefined) throw new Error(`the workspace never finished keying: ${JSON.stringify(row?.failures.slice(0, 3))}`);
}

/**
 * What a product write leaves behind: the bucket's notes copied into the tree,
 * and each note's front matter read into its facts. Tests that seed the bucket
 * directly call this where production would have touched the tree.
 */
export async function readIntoTree(t: TestConvex, workspaceId: Id<"workspaces">): Promise<void> {
  await copyTree(t, workspaceId);
  for (let pass = 0; pass < 4; pass += 1) {
    await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private" as const,
      operation: { kind: "nodesFactFill" as const },
    });
  }
}

/**
 * Run the scheduled jobs that are actually due, and leave the future alone.
 *
 * `drainScheduled` waits for the queue to empty, which never happens once a
 * job is queued for later (a form digest an hour out, a parity re-check half
 * a minute out). A test can still say "everything due has run".
 */
export async function drainDueScheduled(t: TestConvex): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const due = jobs.filter(
      (job) => (job.state.kind === "pending" && job.scheduledTime <= Date.now()) || job.state.kind === "inProgress",
    );
    if (due.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
    await t.finishInProgressScheduledFunctions();
  }
  throw new Error("due scheduled functions never drained");
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
    /**
     * The *row's* capability object, deliberately as loose as the schema.
     *
     * A binding written before 2026-09-12 carries `conditionalWrite` and
     * nothing else, and that shape is not a hypothetical — it is what every
     * production row of that vintage still holds, and what
     * `sweepUnprobedCapabilities` exists to find. A test that could only seed
     * the current shape could not reproduce the fault.
     */
    capabilities?: {
      conditionalWrite: boolean;
      conditionalCreate?: boolean;
      conditionalDelete?: boolean;
      serverSideCopy?: boolean;
    };
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
 * A Google connection in a chosen state, inserted directly rather than
 * through the real connect flow — same reasoning as `seedStorageBinding`
 * just above: what several tests need is "a workspace with a live Google
 * grant", not a second exercise of `startGmailConnect`'s own suite.
 *
 * The refresh token is sealed with the real `encryptSecret`, bound to this
 * workspace, so a test asserting on the envelope (or on what a scheduled
 * revoke carries) is exercising the real shape.
 */
export async function seedGoogleConnection(
  t: TestConvex,
  options: {
    workspaceId: Id<"workspaces">;
    boundBy: Id<"users">;
    address?: string;
    googleAccountId?: string;
    refreshToken?: string;
    disconnected?: boolean;
  },
): Promise<Id<"googleConnections">> {
  const refreshToken = options.refreshToken ?? "example-google-refresh-token-not-real";
  const encryptedRefreshToken = options.disconnected
    ? ""
    : await encryptSecret(refreshToken, requireKeyset(), { workspaceId: options.workspaceId });
  const now = Date.now();
  return await t.run((ctx) =>
    ctx.db.insert("googleConnections", {
      workspaceId: options.workspaceId,
      provider: "google",
      address: options.address ?? "person@example.invalid",
      encryptedRefreshToken,
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      googleAccountId: options.googleAccountId ?? "example-google-account-id",
      products: ["gmail"],
      gmail: {
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        mailboxSlug: "person-at-example-invalid",
        backfillDays: 30,
        folders: ["inbox"],
        storeRawMime: false,
        attachmentMode: "metadata-only",
        quotaBytes: 1_000_000_000,
      },
      health: options.disconnected ? "error" : "active",
      disconnectedAt: options.disconnected ? now : undefined,
      boundBy: options.boundBy,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

/**
 * Obviously fake halves of the platform's own D1 credential.
 *
 * Not a customer's anything — `appSecrets` holds Context.LC's own integration
 * credentials — but still a credential, so the values here are the sort of
 * thing no Cloudflare account would ever accept, and the tests that use them
 * are largely about proving they do not escape.
 */
export const FAKE_D1 = {
  apiToken: "example-d1-api-token-not-a-real-one-000000",
  accountId: "example00cloudflare00account00id",
};

/**
 * Store one platform integration secret, sealed the way the console seals it.
 *
 * Inserted rather than driven through `setSecret`, which needs an admin session
 * and an `ADMIN_EMAILS` allowlist — machinery `admin.test.ts` owns and that a
 * gateway test should not depend on. The envelope is produced by the real
 * `encryptSecret` under the real `platform: "integration"` context, so the
 * decrypt exercised downstream is the real one and a test cannot pass because
 * the sealing was faked.
 */
export async function seedAppSecret(
  t: TestConvex,
  name: string,
  value: string,
): Promise<void> {
  const envelope = await encryptSecret(value, requireKeyset(), {
    platform: "integration",
  });
  const now = Date.now();
  await t.run(async (ctx) => {
    const setter = await ctx.db.insert("users", { createdAt: now });
    await ctx.db.insert("appSecrets", {
      name,
      encryptedValue: envelope,
      // A hash, not a prefix: what appears in a screenshot is not a fragment of
      // the real value. Any 8 hex will do here; nothing under test reads it.
      fingerprint: "0000beef",
      updatedBy: setter,
      updatedAt: now,
      createdAt: now,
    });
  });
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
  accessTokenExpiresAt?: number,
): Promise<Id<"oauthGrants">> {
  return await t.run((ctx) =>
    ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId,
      scopes: ["context.read"],
      hashedRefreshToken,
      accessTokenExpiresAt,
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
