import { createSupaAuth } from "@supa-media/convex/auth";
import { productionOtpGuard, sealDevOtpBypass } from "./functions/lib/otpBypass";

// Before the providers are built, because they read `DEV_OTP_BYPASS` while
// they are being built. See `functions/lib/otpBypass.ts` for why this is a
// whitelist of one deployment rather than a list of the deployments it must
// not work on, and why the guard below is not redundant with it.
sealDevOtpBypass();

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
  // The link in invitation mail signs its recipient in on click. That needs a
  // second provider, because `@convex-dev/auth`'s `Email()` hardcodes an
  // `authorize` that refuses any verification without a matching
  // `params.email` — right for a code typed off a screen, wrong for a link
  // whose URL is meant to carry everything. Clearing that check on the OTP
  // provider instead is the one-line version and a serious regression:
  // `verifyCodeAndSignIn` derives its rate-limit key from `params.email`, so a
  // verification carrying no email is not rate limited at all — against a
  // six-digit secret. Hence two providers. See MAGIC_LINK_PROVIDER_ID in
  // @supa-media/convex/auth.
  //
  // `maxAge` does NOT bound the invitation link, and it is worth being exact
  // about why, because the obvious reading is wrong and an earlier draft of
  // this comment believed it. `maxAge` is read in one place — `signIn.js` —
  // and only when the *library* generates a code. Redemption checks the stored
  // row instead (`verifyCodeAndSignIn.js`, `verificationCode.expirationTime <
  // Date.now()`). `functions/invitationEmail.ts` mints its own code and passes
  // its own `expirationTime` (SIGNIN_CODE_TTL_MS — seven days, the
  // invitation's own life), so that is what governs the link. A test pins
  // this rather than trusting the reading: "a seven-day link outlives this
  // provider's maxAge, because the app sets its own expiry".
  //
  // What `maxAge` does bound is the one path that reaches this provider
  // without going through us. `api.auth.signIn` is public, so anybody can call
  // signIn("magic-link", { email }) for an address they do not own. Nothing
  // reaches them — no sendVerificationRequest is configured, and a configured
  // one would mail the address that was named — so it is a nuisance rather
  // than a hole, but the code it mints is real. An hour is the shortest useful
  // life for it. Seven days here would lengthen only that code and would buy
  // the invitation link nothing at all.
  magicLink: { maxAge: 60 * 60 },
  // Dedicated production CUJ identity. The framework registers a separate
  // provider that refuses every other address; this is not the global dev
  // bypass and cannot change the ordinary customer email provider.
  testEmail: { email: "agentseyi@agentmail.to", code: "000000" },
  // The framework honours `DEV_OTP_BYPASS` — which changes what the ORDINARY
  // customer provider mints, for every address — unless this is truthy and
  // `CONVEX_SITE_URL` contains it. Passing nothing is not "no opinion": it is
  // the guard disabled, because `undefined && …` is false for every input.
  // Absent only on the isolated staging deployment, which is the one place
  // the bypass is for.
  productionIdentifier: productionOtpGuard(),
});
