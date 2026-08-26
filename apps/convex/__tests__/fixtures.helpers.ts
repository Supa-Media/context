/**
 * Shared fixtures for the control-plane tests.
 *
 * Deliberately thin. These tests exist to prove authorization, so the setup
 * must not quietly do anything the real code would refuse to do — with one
 * exception, `addMember`, which inserts a membership row directly because
 * there is no invitation flow yet. Everything else goes through the real
 * public functions.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { convexTest, type TestConvex as TestConvexFor } from "convex-test";
import schema from "../schema";
import { modules } from "../test.setup";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

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
 * There is no invitation mutation yet, and inventing one here would be testing
 * a fiction. Direct insert keeps the tests honest about what exists.
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
  overrides: Partial<typeof FAKE_STORAGE> & { rootPrefix?: string } = {},
) {
  return await asUser(t, userId).action(api.functions.storage.bindStorage, {
    workspaceId,
    ...FAKE_STORAGE,
    ...overrides,
  });
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
