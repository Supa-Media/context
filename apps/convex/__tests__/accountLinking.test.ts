import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { setupTest } from "./fixtures.helpers";

/**
 * One address is one account, however many times a verification code is minted
 * for it.
 *
 * ## Why this file exists
 *
 * An adversarial review of the invitation email argued that minting a sign-in
 * code for a stranger's address inserts an **unverified** `users` row, so that
 * when the real person later signs up with the ordinary email OTP the library
 * fails to link the two and inserts a second row — after which
 * `resolveInviteeUser`'s `.take(2)` fails closed and **every** email invitation
 * to that address, from anybody, becomes permanently unacceptable. That would
 * be a cheap, unrecoverable denial of service against any address, and it would
 * be worth blocking a release over.
 *
 * It does not reproduce, and the reason is worth pinning rather than
 * remembering. The reasoning traced `defaultCreateOrUpdateUser` in
 * `@convex-dev/auth` — `emailVerified` defaulting to `false` for an email
 * provider, `uniqueUserWithVerifiedEmail` skipping unverified rows — and all of
 * that is real code that never runs here. Its first branch is:
 *
 *     if (config.callbacks?.createOrUpdateUser !== undefined)
 *       return await config.callbacks.createOrUpdateUser(ctx, { ... });
 *
 * `createSupaAuth` supplies that callback, so the library's own linking and
 * verification rules are bypassed in their entirety, and the framework's are
 * what decide. Those link by email *and* stamp `emailVerificationTime` when
 * they create.
 *
 * So the invariant below is not the library's and not ours — it belongs to
 * `@supa-media/convex`, which is a separate repository on its own release
 * cycle. That is exactly the kind of fact that is true when you check it and
 * false after somebody else's refactor, and the failure mode is silent: nothing
 * breaks at mint time, and invitations to that address stop working weeks
 * later. Hence a test here, in the repository that would suffer, rather than a
 * note in a docstring.
 *
 * These use the `email` provider because it is the one this deployment
 * registers. The magic-link provider is a second provider of the same *type*
 * (`Email()`), reaching the same callback with the same `type: "email"` — see
 * `createVerificationCodeImpl`, which passes `{ type: "email" }` for any
 * provider whose type is email. When it is registered, these properties are the
 * ones that keep an invitation-minted account and a self-signed-up account from
 * being two people.
 */

/** Mint a verification code the way the sign-in and invitation paths both do. */
async function mintCode(
  t: ReturnType<typeof setupTest>,
  email: string,
  code: string,
): Promise<void> {
  await t.mutation(internal.auth.store, {
    args: {
      type: "createVerificationCode",
      provider: "email",
      email,
      code,
      expirationTime: Date.now() + 10 * 60 * 1000,
      allowExtraProviders: false,
    },
  } as never);
}

async function usersWithEmail(
  t: ReturnType<typeof setupTest>,
  email: string,
): Promise<Array<{ emailVerificationTime?: number }>> {
  return await t.run((ctx) =>
    ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect(),
  );
}

describe("minting a code for an address nobody has claimed", () => {
  test("creates exactly one account, and marks it verified", () => {
    // The whole F1 chain hangs on this row being *unverified*. It is not:
    // `createOrUpdateUser` stamps `emailVerificationTime` whenever it creates
    // for `type: "email"`. If this ever flips, a second sign-up for the same
    // address stops linking and the duplicate-row failure becomes real.
    return (async () => {
      const t = setupTest();
      await mintCode(t, "stranger@example.invalid", "a".repeat(64));

      const users = await usersWithEmail(t, "stranger@example.invalid");
      expect(users).toHaveLength(1);
      expect(users[0]!.emailVerificationTime).toBeTypeOf("number");
    })();
  });

  test("minting again for the same address links rather than duplicating", async () => {
    // The property `resolveInviteeUser` depends on. It reads `by_email` with
    // `.take(2)` and returns null on two rows — deliberately, because two
    // accounts for one address means nobody can say who the invitee is. So a
    // second row here does not merely clutter: it makes every email invitation
    // to that address unanswerable, from anybody, permanently.
    const t = setupTest();
    await mintCode(t, "stranger@example.invalid", "a".repeat(64));
    await mintCode(t, "stranger@example.invalid", "b".repeat(64));

    expect(await usersWithEmail(t, "stranger@example.invalid")).toHaveLength(1);
  });

  test("a second address is a second account, so the linking is by email and not a no-op", async () => {
    // Guards the test above from passing for the wrong reason — a callback that
    // returned the same user for everything would satisfy it.
    const t = setupTest();
    await mintCode(t, "one@example.invalid", "a".repeat(64));
    await mintCode(t, "two@example.invalid", "b".repeat(64));

    expect(await usersWithEmail(t, "one@example.invalid")).toHaveLength(1);
    expect(await usersWithEmail(t, "two@example.invalid")).toHaveLength(1);
  });
});
