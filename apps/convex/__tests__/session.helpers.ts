import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";

/**
 * A signed-in person as the app really has one: a token whose subject names a
 * live session, `userId|sessionId`.
 *
 * Every Convex function takes the person from `lib/signedIn.ts`, which
 * refuses a token whose session is gone. A bare `withIdentity({ subject:
 * userId })` names no session, so it now reads as signed out, as it would in
 * production. This makes the session on first use and remembers it, so a
 * test that signs everyone out and then acts again gets a new one, like a
 * person signing back in. Unlike `asUser`, it writes no email proof.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withSession<S extends SchemaDefinition<GenericSchema, boolean>>(t: TestConvex<S>, userId: any) {
  let sessionId: string | undefined;
  const identity = async () => {
    sessionId = await t.run(async (ctx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = ctx.db as any;
      if (sessionId !== undefined && (await db.get(sessionId)) !== null) return sessionId;
      return (await db.insert("authSessions", { userId, expirationTime: Date.now() + 365 * 24 * 60 * 60 * 1000 })) as string;
    });
    return t.withIdentity({ subject: `${userId}|${sessionId}` });
  };
  type As = ReturnType<TestConvex<S>["withIdentity"]>;
  return {
    query: (async (...args: unknown[]) => ((await identity()).query as (...a: unknown[]) => unknown)(...args)) as As["query"],
    mutation: (async (...args: unknown[]) => ((await identity()).mutation as (...a: unknown[]) => unknown)(...args)) as As["mutation"],
    action: (async (...args: unknown[]) => ((await identity()).action as (...a: unknown[]) => unknown)(...args)) as As["action"],
    fetch: (async (...args: unknown[]) => ((await identity()).fetch as (...a: unknown[]) => unknown)(...args)) as As["fetch"],
  } as As;
}
