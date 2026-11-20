#!/usr/bin/env node
/**
 * Mails a sign-in code for one of a preview's personas to the team inbox, so a
 * person can sign in to that preview's web app and use it, Tex's in-app chat
 * included. Run by `.github/workflows/preview-sign-in-code.yml`.
 *
 * A preview sends no mail itself (packages/sandbox/src/guards.mjs), so the code is
 * issued on the preview through the convex CLI, read from its output here, and
 * mailed from this runner to the one fixed team inbox. It is never printed: this
 * repository's Actions logs are public.
 *
 *   PR=<N> PERSONA=alpha node packages/sandbox/src/sign-in-code.mjs
 *
 * Environment: CONVEX_DEPLOY_KEY (the preview deploy key), RESEND_API_KEY,
 * AUTH_EMAIL_FROM (optional), and PREVIEW_ROUTER_HOST (optional: the preview's
 * web app host, for the link in the mail).
 */
import { pathToFileURL } from "node:url";
import { findConvexPreview } from "./teardown.mjs";

/** The seed's personas (packages/sandbox/src/seed.mjs PERSONAS), here so this file does not load the convex client. */
export const PERSONAS = ["alpha", "beta", "gamma", "delta", "epsilon"];
const personaEmail = (name) => `${name}@supa.media`;

/** The seed's code issuer, loaded only when a code is really issued (it imports the convex client). */
async function issueForReal(email, options) {
  const { issuePersonaCode } = await import("./seed.mjs");
  return issuePersonaCode(email, options);
}

/** The team inbox, the same one production's sign-in code workflow mails (deploy-convex.yml SIGNUP_ALERTS_EMAIL). */
export const TEAM_INBOX = "context@supa.media";

/** The mail, as Resend takes it. The code goes only here. */
export function codeMail({ pr, persona, code, expiresAt, routerHost, from }) {
  const email = personaEmail(persona);
  const link = routerHost ? `https://${routerHost}/login` : `the router context-router-pr${pr} on workers.dev, at /login`;
  return {
    from: from || "auth@context.lc",
    to: TEAM_INBOX,
    subject: `Preview pr${pr} sign-in code for ${email}`,
    text:
      `Sign-in code for ${email} on pull request #${pr}'s preview: ${code}\n\n` +
      `Sign in at ${link}: type the address, then this code. Do not press "send me a code" first, which replaces it. It works once and expires ${new Date(expiresAt).toUTCString()}.\n` +
      `The preview holds only fictional seeded data and sends no texts or mail.\n`,
  };
}

export async function main(env = process.env, { fetchImpl = fetch, issue = issueForReal, find = findConvexPreview, log = console.log } = {}) {
  const pr = String(env.PR ?? "");
  if (!/^[1-9][0-9]{0,6}$/.test(pr)) throw new Error("PR must be a pull request number.");
  const persona = String(env.PERSONA ?? "");
  if (!PERSONAS.includes(persona)) throw new Error(`PERSONA must be one of ${PERSONAS.join(", ")}.`);
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set: there is no way to mail the code.");
  const deployment = await find(env.CONVEX_DEPLOY_KEY, `pr${pr}`, { fetchImpl });
  if (deployment === null) throw new Error(`Pull request #${pr} has no preview deployment.`);
  const code = await issue(personaEmail(persona), { deployment, deployKey: env.CONVEX_DEPLOY_KEY });
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const mail = codeMail({ pr, persona, code, expiresAt, routerHost: env.PREVIEW_ROUTER_HOST, from: env.AUTH_EMAIL_FROM });
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(mail),
  });
  // Resend's error body quotes the address; only the status is shown.
  if (!response.ok) throw new Error(`Mailing the code failed (HTTP ${response.status}).`);
  log(`Mailed a sign-in code for ${persona} on preview pr${pr} to the team inbox; it expires in ten minutes.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
