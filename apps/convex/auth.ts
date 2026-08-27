import { createSupaAuth } from "@supa-media/convex/auth";

/**
 * Auth setup for Context.
 *
 * `createSupaAuth` wires up @convex-dev/auth with OTP providers. The enabled
 * methods and their transports (Resend for email, Twilio Verify for phone)
 * are configured here. See @supa-media/convex/auth for all options.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = createSupaAuth({
  appName: "Context",
  methods: ["email"],
  resend: {
    fromAddress: process.env.AUTH_EMAIL_FROM ?? "auth@context.com",
    emailSubject: (code) => `${code} is your Context code`,
  },
  // ── Waiting on a framework release ──────────────────────────────────────
  //
  // Invitation mail carries a link that should sign its recipient in on click.
  // The code is minted correctly (`functions/invitationEmail.ts`), but it can
  // only be *redeemed* by a provider whose email check is cleared, and
  // `@convex-dev/auth`'s `Email()` hardcodes that check — its documented
  // `authorize: undefined` override does nothing in 0.0.90.
  //
  // The fix is a separate link-only provider, which is committed to
  // supa-framework and not yet released. `@supa-media/convex@0.2.0` has
  // neither the option nor the export, so adding it here today is a type
  // error. Until then `invitationEmail.ts` degrades to a plain link and the
  // recipient signs in with a code.
  //
  // When the release lands, uncomment this and switch that module's
  // SIGNIN_PROVIDER to the imported constant:
  //
  //   magicLink: { maxAge: 24 * 60 * 60 },
  //
  // 24 hours rather than the invitation's seven days: a code is typed off a
  // screen somebody is looking at, while a link sits in a mailbox, gets
  // forwarded, and is readable by anything with access to it later.
});
