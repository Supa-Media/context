/**
 * `write_note` `site` — a website's status, and Publish, from an agent.
 *
 * On `write_note` rather than a tool of its own because clients cache the
 * tool list: an argument reaches every connected client the day it ships, a
 * new tool only those that re-fetch (docs/decisions/gateway-protocol.md, "A
 * new argument reaches a client that a new tool cannot").
 *
 * The owner decided (2026-10-03) that owners and editors may publish through
 * MCP, as they may press Publish in the app. Everything is decided by the
 * control plane (`apps/convex/functions/lib/websites/agentSite.ts`); this
 * file only words its answer. A draft is named by a fingerprint of what
 * Publish would release, so an agent publishes the draft it checked or is
 * told the folder changed since.
 */

import { toolError, toolText } from "../results.js";

const ACTIONS = new Set(["status", "publish"]);

/** One sentence for every refusal, so it says nothing about why. */
const REFUSED =
  "only this workspace's owners and editors can see a website's status or publish it, from a connection that can write.";

export async function toolSiteAction(store, args) {
  const request = args.site;
  if (!request || typeof request !== "object" || !ACTIONS.has(request.action)) {
    return toolError('site must be { action: "status" } or { action: "publish", draft? }');
  }
  if (args.content !== undefined || args.comment !== undefined || args.images !== undefined) {
    return toolError("pass site on its own: it reads or publishes the website and writes no note");
  }
  if (request.draft !== undefined && (typeof request.draft !== "string" || !/^[0-9a-f]{16}$/.test(request.draft))) {
    return toolError('draft must be the 16-character draft a site status returned, e.g. "3fa9c2e01b7d4a65"');
  }
  if (typeof store.site !== "function") {
    return toolError("websites are not available on this deployment");
  }
  const answer = await store.site({ action: request.action, ...(request.draft ? { draft: request.draft } : {}) });
  if (answer === null) return toolError(REFUSED);
  return request.action === "status" ? describeStatus(answer) : describePublish(answer);
}

function when(ms) {
  return typeof ms === "number" ? ` (${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC)` : "";
}

function describeStatus(site) {
  if (!site.enabled) {
    return toolText(
      "the website is off. Only the workspace's owner can turn it on, in the app; until then nothing under website/ is published.",
    );
  }
  const lines = [
    `website: on · draft ${site.draft} · published revision ${site.publishedRevision ?? "none yet"}${when(site.publishedAt)}`,
  ];
  if (site.addresses.length > 0) lines.push(`addresses: ${site.addresses.join(", ")}`);
  const page = (entry) => `${entry.path}${entry.address ? ` → ${entry.address}` : ""}`;
  const changed = site.pages.filter((entry) => entry.changed);
  const problems = site.pages.filter((entry) => entry.problems.length > 0);
  const live = site.pages.filter((entry) => entry.status === "live");
  const drafts = site.pages.filter((entry) => entry.status === "draft");
  lines.push(
    changed.length === 0 && site.removed.length === 0
      ? "nothing changed since the last publish."
      : `changed since the last publish (${changed.length}): ${changed.map(page).join("; ") || "none"}`,
  );
  if (site.removed.length > 0) {
    lines.push(`publishing takes down (${site.removed.length}): ${site.removed.map(page).join("; ")}`);
  }
  if (problems.length > 0) {
    lines.push(`problems that stop Publish (${problems.length}):`);
    for (const entry of problems) lines.push(`- ${entry.path}: ${entry.problems.join(" ")}`);
  }
  lines.push(`pages: ${live.length} published when you publish, ${drafts.length} drafts.`);
  lines.push(
    problems.length > 0
      ? "fix the problems, then check again."
      : `to publish exactly this draft: write_note { path: "website/index.md", site: { action: "publish", draft: "${site.draft}" } }`,
  );
  return toolText(lines.join("\n"));
}

function describePublish(result) {
  if (result.message) return toolError(result.message);
  if (result.conflict) {
    return toolError(
      `not published: the website folder changed after you checked it; it is now draft ${result.draft}. ` +
        "Check it again with site status before publishing, so you release what you looked at.",
    );
  }
  if (!result.published) {
    if (result.problems.length === 0) return toolError("not published: saves kept landing while publishing; try again.");
    return toolError(
      [`not published. Fix these pages, then publish again:`, ...result.problems.map((p) => `- ${p.path}: ${p.message}`)].join("\n"),
    );
  }
  const lines = [`published draft ${result.draft} as revision ${result.revision ?? "?"}.`];
  if (result.addresses.length > 0) lines.push(`live at: ${result.addresses.join(", ")}`);
  return toolText(lines.join("\n"));
}
