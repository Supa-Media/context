/**
 * The staff mail for a folder move whose copy in the bucket fell behind the
 * file tree, and the one when it caught up (`storageLag.ts`). A workspace's
 * handle, counts and times only: never a path, never a folder's name.
 */

import { escapeHtml } from "./invitationEmail";
import type { LateReason } from "./nodes/moveLag";

export type StorageLagFacts =
  | { kind: "late"; workspace: string; reason: LateReason; ageMs: number; remaining: number; etaMs: number | null; lastError: string | null }
  | { kind: "recovered"; workspace: string; tookMs: number };

/** "40 minutes", "3 hours 10 minutes", "2 days". */
export function spanWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  const rest = minutes % 60;
  const head = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return rest === 0 ? head : `${head} ${rest} ${rest === 1 ? "minute" : "minutes"}`;
}

const files = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "file" : "files"}`;

export function renderStorageLagAlert(facts: StorageLagFacts, consoleUrl: string) {
  let subject: string;
  let lines: string[];
  if (facts.kind === "recovered") {
    subject = `Storage caught up: ${facts.workspace}`;
    lines = [`The folder move in ${facts.workspace} is now in its bucket, ${spanWords(facts.tookMs)} after it was made.`];
  } else {
    subject = `Storage is behind: ${facts.workspace}`;
    const why =
      facts.reason === "stuck"
        ? `It is stuck${facts.lastError ? `: ${facts.lastError}` : ""}.`
        : facts.reason === "old"
          ? "It has been copying for over 4 hours."
          : "At its current pace it will not finish within 5 hours of being made.";
    const left =
      facts.etaMs === null
        ? `${files(facts.remaining)} left to copy.`
        : `${files(facts.remaining)} left to copy, about ${spanWords(facts.etaMs)} at its current pace.`;
    lines = [
      `A folder move in ${facts.workspace} was made ${spanWords(facts.ageMs)} ago and its bucket still has not caught up. ${why}`,
      left,
      "People see the move already; the bucket is what an export or a hand-off reads. Retry or Undo it under Search › Indexes in the staff console.",
    ];
  }
  const footer = "You get these because you turned on storage alerts under Search › Indexes in the staff console. Turn them off there.";
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
