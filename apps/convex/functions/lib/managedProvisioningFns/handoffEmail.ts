/**
 * What the owner is emailed about a move out of managed storage.
 *
 * A move can run for a long time with nobody watching, so the owner is told
 * when it stops for them (paused, or waiting for their answer about files
 * already in the bucket) and when it finishes. Stopping it themselves sends
 * nothing: they were there.
 *
 * Pure, so every line is tested without a network. The mail names no bucket,
 * no path and no provider text: it says what happened and links to the one
 * screen that shows the rest.
 */

import { escapeHtml, sanitizeHeaderText, type RenderedEmail } from "../invitationEmail";

export type HandoffEmailKind = "needs_choice" | "paused" | "finished";

/** Which email a stopped move sends, if any. */
export function handoffEmailKindFor(errorCode: string): HandoffEmailKind | null {
  if (errorCode === "CANCELLED") return null;
  if (errorCode === "DESTINATION_NOT_EMPTY") return "needs_choice";
  return "paused";
}

/** Settings › Storage for this workspace, or null without a usable origin. */
export function storageSettingsUrl(origin: string | null, slug: string): string | null {
  if (origin === null) return null;
  return `${origin.replace(/\/+$/, "")}/console/@${encodeURIComponent(slug)}?settings=storage`;
}

const STILL_LIVE = "Your workspace keeps running from Context's storage, exactly as it was.";

export function renderHandoffEmail(
  kind: HandoffEmailKind,
  facts: { workspaceName: string; url: string | null; retainedUntil?: number },
): RenderedEmail {
  const name = sanitizeHeaderText(facts.workspaceName) || "your workspace";
  const where = facts.url ?? "Settings › Storage in Context";
  let subject: string;
  let lines: string[];
  switch (kind) {
    case "needs_choice":
      subject = `Your bucket already has files: choose how to move ${name}`;
      lines = [
        `The bucket you chose for ${name} already has files in it, so nothing has been copied or deleted yet.`,
        "Choose whether to keep those files and add your workspace beside them, or start fresh.",
        STILL_LIVE,
      ];
      break;
    case "paused":
      subject = `Moving ${name} to your bucket has paused`;
      lines = [
        `The move of ${name} to your own bucket stopped before switching over.`,
        "Settings › Storage says why and lets you retry; files already copied carry over.",
        STILL_LIVE,
      ];
      break;
    case "finished": {
      const kept =
        facts.retainedUntil === undefined
          ? null
          : new Date(facts.retainedUntil).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              timeZone: "UTC",
            });
      subject = `${name} now lives in your bucket`;
      lines = [
        `Every file in ${name} was copied to your bucket and checked, and your workspace now runs from it.`,
        kept === null
          ? "You can switch back to Context's storage from Settings › Storage."
          : `Context keeps its copy until ${kept} in case you want to switch back, then deletes it.`,
      ];
      break;
    }
  }
  const text = [...lines, "", where].join("\n");
  const link =
    facts.url === null
      ? `<p>${escapeHtml(where)}</p>`
      : `<p><a href="${escapeHtml(facts.url)}">Open Settings › Storage</a></p>`;
  const html = `${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}${link}`;
  return { subject: sanitizeHeaderText(subject), text, html };
}
