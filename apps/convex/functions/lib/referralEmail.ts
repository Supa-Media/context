/**
 * The one referral message: "@maya invited you to Context.LC".
 *
 * Every word is ours. There is deliberately no note from the inviter: this
 * mail goes from our address to any address a person types, and a free-text
 * box would make it a way to send anything from us. The inviter is named by
 * handle, which the namespace already validates and reserves.
 *
 * The link addresses the invite (`/join/<token>`) so the page can say who
 * invited you. It carries no address and no sign-in code: the recipient types
 * their address there and is mailed an ordinary code.
 */

import { escapeHtml } from "./invitationEmail";

export interface RenderedReferralEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderReferralEmail(
  inviterHandle: string | null,
  joinUrl: string,
  expiresOn: string,
): RenderedReferralEmail {
  const who = inviterHandle === null ? "Someone you know" : `@${inviterHandle}`;
  const subject = `${who} invited you to Context.LC`;
  const lines = [
    `${who} invited you to skip the Context.LC waitlist. Context.LC keeps your notes in one place that your AI tools can read and write.`,
  ];
  const footer = `Works for this email until ${expiresOn}. Didn't expect this? You can ignore it.`;
  const text = [...lines.flatMap((line) => [line, ""]), "Accept invite:", joinUrl, "", footer].join("\n");

  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const html = [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    '<body style="margin:0;padding:32px 16px;background:#F7F4ED;">',
    '<div style="max-width:520px;margin:0 auto;background:#FFFDF9;border-radius:12px;padding:28px 26px;">',
    `<h1 style="margin:0 0 14px;font:600 22px/1.3 ${font};color:#1A1714;">${escapeHtml(subject)}</h1>`,
    ...lines.map((line) => `<p style="margin:0 0 14px;font:15px/1.5 ${font};color:#4A443C;">${escapeHtml(line)}</p>`),
    `<p style="margin:6px 0 18px;"><a href="${escapeHtml(joinUrl)}" style="display:inline-block;background:#0E6C69;color:#FFFDF9;text-decoration:none;font:600 15px ${font};padding:11px 18px;border-radius:8px;">Accept invite</a></p>`,
    `<p style="margin:0;font:13px/1.5 ${font};color:#6B6358;">${escapeHtml(footer)}</p>`,
    "</div></body></html>",
  ].join("");
  return { subject, text, html };
}

/** "Oct 13", in UTC, for the footer. */
export function shortDate(at: number): string {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
