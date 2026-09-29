/**
 * The two waitlist messages: "you're on the list" and "you're in".
 *
 * Plain on purpose. Neither carries a token, a code or the address in a link:
 * "you're in" points at the sign-in page, where the person types their own
 * address and is mailed an ordinary code. A link that signed them in would be
 * a credential sitting in a mailbox for as long as the mail does.
 */

import { escapeHtml } from "./invitationEmail";

export type WaitlistMail = "joined" | "admitted";

export interface RenderedWaitlistEmail {
  subject: string;
  text: string;
  html: string;
}

const IGNORE = "Didn't sign up? You can ignore this email.";

export function renderWaitlistEmail(kind: WaitlistMail, signInUrl: string): RenderedWaitlistEmail {
  const subject = kind === "joined" ? "You're on the Context.LC waitlist" : "You're in";
  const lines =
    kind === "joined"
      ? [
          "Thanks for signing up. We're letting people in a few at a time, and we'll email you when it's your turn.",
          "Nothing else to do for now.",
        ]
      : [
          "Your Context.LC access is ready. Sign in with this email address and we'll send you a code.",
        ];
  const text = [
    ...lines.flatMap((line) => [line, ""]),
    ...(kind === "admitted" ? ["Sign in:", signInUrl, ""] : []),
    IGNORE,
  ].join("\n");

  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const paragraphs = lines
    .map((line) => `<p style="margin:0 0 14px;font:15px/1.5 ${font};color:#4A443C;">${escapeHtml(line)}</p>`)
    .join("");
  const button =
    kind === "admitted"
      ? `<p style="margin:6px 0 18px;"><a href="${escapeHtml(signInUrl)}" style="display:inline-block;background:#0E6C69;color:#FFFDF9;text-decoration:none;font:600 15px ${font};padding:11px 18px;border-radius:8px;">Sign in</a></p>`
      : "";
  const html = [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    '<body style="margin:0;padding:32px 16px;background:#F7F4ED;">',
    '<div style="max-width:520px;margin:0 auto;background:#FFFDF9;border-radius:12px;padding:28px 26px;">',
    `<h1 style="margin:0 0 14px;font:600 22px/1.3 ${font};color:#1A1714;">${escapeHtml(subject)}</h1>`,
    paragraphs,
    button,
    `<p style="margin:0;font:13px/1.5 ${font};color:#6B6358;">${escapeHtml(IGNORE)}</p>`,
    "</div></body></html>",
  ].join("");
  return { subject, text, html };
}
