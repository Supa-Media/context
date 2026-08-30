import { describe, expect, test, vi } from "vitest";

/**
 * **The control plane's half of the shared email rule, pinned by a call rather
 * than by a value.**
 *
 * `packages/shared/src/email.ts` exists because `parseInvitee` and
 * `normalizeSignInEmail` must produce the same string for the same address:
 * an invitation is matched to an account by byte-exact index lookup, and when
 * the two disagree one person ends up with two accounts and the invitation
 * lands on the one they cannot sign in to.
 *
 * The mobile half is pinned by identity — `email.ts` re-exports `normalizeEmail`
 * under its own name, so a copy is a different function object and
 * `signInEmail.test.ts` fails immediately. **The control plane's half had no
 * such pin, and the comment that said it did was wrong.** Measured before this
 * file existed:
 *
 * ```
 * const value = normalizeEmail(trimmed)  ->  const value = trimmed.toLowerCase()
 *   apps/mobile   1595 passed / 1595      0 failures
 *   apps/convex   1292 passed / 1292      0 failures
 * ```
 *
 * That is the exact defect the shared rule was extracted to remove — a second
 * copy that agrees today — and the drift table in `invitations.test.ts` cannot
 * see it, because it compares two functions that still return the same string.
 * **A behavioural test over values cannot distinguish a call from a copy.** So
 * this asserts the call.
 *
 * `vi.mock` with `importOriginal` wraps the real implementation rather than
 * replacing it, so `parseInvitee` behaves exactly as it does in production and
 * the assertion is about the edge it went through, not about a stubbed answer.
 *
 * **The value assertion does not close the obvious hole in that, and an earlier
 * version of this comment implied it did.** It said a spy "called but whose
 * result was discarded" would satisfy a call count on its own — true as far as
 * it goes, and measured, the natural discard does not fail anything:
 *
 * ```
 * normalizeEmail(trimmed);
 * const value = trimmed.toLowerCase();   ->  1294 passed / 1294, 0 failures
 * ```
 *
 * because the value is compared against the same rule applied to the same
 * fixture, so a discard that recomputes the identical string is invisible here
 * — and a discard that *drifts* is already caught by the table in
 * `invitations.test.ts`. What the value assertion actually holds is the
 * relationship between what goes in and what comes back: `parseInvitee` trims
 * before calling, so it is one of the three failures when the shared rule stops
 * trimming. That is worth having and is not what it was advertised as.
 *
 * Its own file, deliberately. `vi.mock` is hoisted to the top of the module it
 * appears in, so putting this beside the drift table would hand every other
 * test in `invitations.test.ts` a wrapped `normalizeEmail` for no reason.
 */

const calls: string[] = [];

vi.mock("@context/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@context/shared")>();
  return {
    ...actual,
    normalizeEmail: (raw: string) => {
      calls.push(raw);
      return actual.normalizeEmail(raw);
    },
  };
});

const { parseInvitee } = await import("../functions/lib/invitees");
const { normalizeEmail } = await import("@context/shared");

describe("parseInvitee uses the shared rule rather than its own copy of it", () => {
  test("an email invitee goes through normalizeEmail, and keeps its answer", () => {
    calls.length = 0;
    const parsed = parseInvitee("  LK@Example.Invalid  ");

    // Called: this is what a re-inlined `.toLowerCase()` would fail, and what
    // no assertion over the returned value can see.
    expect(calls).toEqual(["LK@Example.Invalid"]);

    // And its answer is the one that was kept. A call whose result is thrown
    // away would pass the assertion above on its own.
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.invitee.kind !== "email") {
      throw new Error("fixture is not an email address");
    }
    expect(parsed.invitee.value).toBe(normalizeEmail("  LK@Example.Invalid  "));
  });

  test("a handle invitee does not go through it", () => {
    // The negative half, and not decoration: without it, `normalizeEmail`
    // applied to every input — lowercasing a handle on the way to
    // `validateName`, which has its own normalization — would satisfy the test
    // above. The two branches are separate for the reason `looksLikeEmail`
    // gives, and the email rule belongs to only one of them.
    calls.length = 0;
    expect(parseInvitee("@LK").ok).toBe(true);
    expect(calls).toEqual([]);
  });
});
