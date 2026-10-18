/**
 * The mail a content report sends to the support address: what was reported,
 * why, by whom, and a link to the console's Reports tab where it is handled.
 *
 * Ids and the reporter's own words only, as everywhere a report travels
 * (`functions/reports.ts`): never a note's text, title or path.
 */

import { escapeHtml } from "./invitationEmail";

export interface ContentReportFacts {
  reason: string;
  kind: string;
  details: string | null;
  resolved: boolean;
  reporter: string;
  about: string | null;
  workspace: string | null;
  ids: Record<string, string>;
  environment: string;
}

export function renderContentReport(facts: ContentReportFacts, consoleUrl: string) {
  const prefix = facts.environment === "production" ? "" : `[${facts.environment}] `;
  const subject = `${prefix}Report: ${facts.reason}, about ${facts.kind}`;
  const lines = [
    `${facts.reporter} reported ${facts.kind}: ${facts.reason}.`,
    ...(facts.about !== null ? [`Sent by ${facts.about}.`] : []),
    ...(facts.workspace !== null ? [`Workspace: ${facts.workspace}.`] : []),
    ...(facts.resolved ? [] : ["The reported item could not be found for this person."]),
    ...(facts.details !== null ? [`In their words: "${facts.details}"`] : []),
    `Ids: ${Object.entries(facts.ids).map(([key, value]) => `${key} ${value}`).join(", ") || "none"}.`,
    "The Terms promise a review within 24 hours. Mark it handled in the Reports tab.",
  ];
  const text = [...lines.flatMap((line) => [line, ""]), "Reports tab:", consoleUrl].join("\n");

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
    `<p style="margin:6px 0 0;"><a href="${escapeHtml(consoleUrl)}" style="display:inline-block;background:#2A45CF;color:#FFFDF9;text-decoration:none;font:600 15px ${font};padding:11px 18px;border-radius:8px;">Open the Reports tab</a></p>`,
    "</div></body></html>",
  ].join("");
  return { subject, text, html };
}
