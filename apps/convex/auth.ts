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
});
