/**
 * The staff signup alert: "New on the waitlist: …" or "New account: …".
 *
 * Who signed up is in the subject because that is the whole point of the
 * mail: the address or phone for the waitlist, the handle (else phone, else
 * email) for an account, and the handle once it is picked. It reaches staff only, who see the same in the console.
 */

import { escapeHtml } from "./invitationEmail";

export type SignupAlertFacts =
  | { kind: "waitlist"; email: string; source: string; useFor: string | null }
  | { kind: "account" | "handle"; handle: string | null; phone: string | null; email: string | null };

const WHERE: Record<string, string> = {
  homepage: "the homepage",
  login: "the sign-in page",
  staff: "the staff console",
};

/**
 * A new account by what it has: its handle first, since people sign up with a
 * phone and add an email later, then the phone and the email.
 */
function accountName(facts: { handle: string | null; phone: string | null; email: string | null }) {
  const known = [facts.handle === null ? null : `@${facts.handle}`, facts.phone, facts.email].filter(
    (part): part is string => part !== null && part.length > 0,
  );
  return { title: known[0] ?? "no handle yet", all: known };
}

export function renderSignupAlert(facts: SignupAlertFacts, consoleUrl: string) {
  let subject: string;
  let lines: string[];
  if (facts.kind === "waitlist") {
    subject = `New on the waitlist: ${facts.email}`;
    lines = [
      `${facts.email} joined the waitlist from ${WHERE[facts.source] ?? facts.source}.`,
      ...(facts.useFor !== null ? [`They'd use it for: "${facts.useFor}"`] : []),
      "Let them in from the Waitlist tab in the staff console.",
    ];
  } else {
    const account = accountName(facts);
    const who = account.all.join(" · ");
    if (facts.kind === "handle") {
      subject = `New handle: ${account.title}`;
      lines = [`${who} just picked their handle.`];
    } else {
      subject = `New account: ${account.title}`;
      lines = [
        account.all.length > 0
          ? `${who} just created a Context.LC account.`
          : "Somebody just created a Context.LC account and has not picked a handle yet.",
      ];
    }
  }
  const footer = "Signup alerts are on in the staff console's Waitlist tab. Turn them off there.";
  const text = [...lines.flatMap((line) => [line, ""]), "Staff console:", consoleUrl, "", footer].join("\n");

  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const paragraphs = lines
    .map((line) => `<p style="margin:0 0 14px;font:15px/1.5 ${font};color:#4A443C;">${escapeHtml(line)}</p>`)
    .join("");
  const html = [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    '<body style="margin:0;padding:32px 16px;background:#F7F4ED;">',
    '<div style="max-width:520px;margin:0 auto;background:#FFFDF9;border-radius:12px;padding:28px 26px;">',
    `<h1 style="margin:0 0 14px;font:600 20px/1.3 ${font};color:#1A1714;">${escapeHtml(subject)}</h1>`,
    paragraphs,
    `<p style="margin:6px 0 18px;"><a href="${escapeHtml(consoleUrl)}" style="display:inline-block;background:#2A45CF;color:#FFFDF9;text-decoration:none;font:600 15px ${font};padding:11px 18px;border-radius:8px;">Open the staff console</a></p>`,
    `<p style="margin:0;font:13px/1.5 ${font};color:#6B6358;">${escapeHtml(footer)}</p>`,
    "</div></body></html>",
  ].join("");
  return { subject, text, html };
}
