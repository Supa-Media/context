/**
 * `write_note` `site` — a website's status, a check, Publish, screenshots and
 * the kept versions to roll back to, from an agent.
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

const ACTIONS = new Set(["status", "check", "publish", "screenshot", "history"]);
const SIZES = ["phone", "tablet", "desktop"];

/** One sentence for every refusal, so it says nothing about why. */
const REFUSED =
  "only this workspace's owners and editors can see a website's status or publish it, from a connection that can write.";

/** One width's measurements, as lines an agent can act on. */
function describeShot(shot) {
  const m = shot.measurements;
  const lines = [`${shot.size} (${shot.width}px wide, ${shot.height}px shown${shot.truncated ? ", cut short" : ""}):`];
  lines.push(
    m.overflowX > 0
      ? `- sideways scroll: content is ${m.overflowX}px wider than the screen${m.wide.length ? ` (widest: ${m.wide.map((w) => `${w.element} +${w.by}px`).join(", ")})` : ""}`
      : "- no sideways scroll",
  );
  lines.push(
    m.bottomReachable
      ? `- the bottom of the page can be scrolled to (${m.scrollHeight}px of content in a ${m.viewportHeight}px screen)`
      : `- the bottom of the page cannot be scrolled to: ${m.scrollHeight}px of content, scrolling stops short`,
  );
  if (m.clipped.length > 0) lines.push(`- boxes hiding content: ${m.clipped.map((c) => `${c.element} hides ${c.hidden}px`).join(", ")}`);
  if (m.brokenImages.length > 0) lines.push(`- pictures that did not load: ${m.brokenImages.join(", ")}`);
  if (m.textLength === 0) lines.push("- the page shows no text at all");
  if (m.headings.length > 0) lines.push(`- outline: ${m.headings.join(" · ")}`);
  if (shot.errors.length > 0) lines.push(`- errors in the page: ${shot.errors.join(" | ")}`);
  return lines.join("\n");
}

async function photograph(store, target, sizes) {
  if (target.url === null) return toolError(target.message ?? REFUSED);
  const result = await store.shootSite({ url: target.url, sizes });
  if (result.error) return toolError(`no screenshot: ${result.error}`);
  const header = `${target.url} (published revision ${target.revision ?? "?"}), as a signed-out visitor sees it:`;
  const text = [header, ...result.shots.map(describeShot), ...result.failures.map((f) => `${f.size}: failed: ${f.reason}`)];
  return {
    content: [
      { type: "text", text: text.join("\n\n") },
      ...result.shots.flatMap((shot) => [
        { type: "text", text: `${shot.size}, ${shot.width}px:` },
        { type: "image", data: shot.jpeg, mimeType: "image/jpeg" },
      ]),
    ],
    ...(result.shots.length === 0 ? { isError: true } : {}),
  };
}

export async function toolSiteAction(store, args) {
  const request = args.site;
  if (!request || typeof request !== "object" || !ACTIONS.has(request.action)) {
    return toolError(
      'site must be { action: "status" }, { action: "check", inspect? }, { action: "publish", draft? }, { action: "screenshot", page?, sizes? } or { action: "history", revision?, inspect? }',
    );
  }
  if (args.content !== undefined || args.comment !== undefined || args.images !== undefined) {
    return toolError("pass site on its own: it reads or publishes the website and writes no note");
  }
  if (request.draft !== undefined && (typeof request.draft !== "string" || !/^[0-9a-f]{16}$/.test(request.draft))) {
    return toolError('draft must be the 16-character draft a site status returned, e.g. "3fa9c2e01b7d4a65"');
  }
  if (
    request.inspect !== undefined &&
    (!["check", "history"].includes(request.action) ||
      typeof request.inspect !== "string" ||
      !(request.action === "check" ? /^website\/[^\0]{1,300}\.md$/ : /^[^\0]{1,300}\.md$/).test(request.inspect) ||
      (request.action === "history" && request.revision === undefined))
  ) {
    return toolError(
      'inspect goes with action "check" and names a note under website/, e.g. "website/layout.html.md", or with "history" and a revision, naming one page of that version',
    );
  }
  if (
    request.revision !== undefined &&
    (request.action !== "history" || !Number.isSafeInteger(request.revision) || request.revision < 0)
  ) {
    return toolError('revision goes with action "history" and is a revision number a history listed, e.g. 12');
  }
  if (
    request.page !== undefined &&
    (request.action !== "screenshot" || typeof request.page !== "string" || !/^\/[^\0]{0,300}$/.test(request.page))
  ) {
    return toolError('page goes with action "screenshot" and is an address on the site, e.g. "/" or "/about"');
  }
  if (
    request.sizes !== undefined &&
    (request.action !== "screenshot" ||
      !Array.isArray(request.sizes) ||
      request.sizes.length === 0 ||
      !request.sizes.every((size) => SIZES.includes(size)))
  ) {
    return toolError('sizes goes with action "screenshot" and lists phone, tablet and/or desktop');
  }
  if (typeof store.site !== "function") {
    return toolError("websites are not available on this deployment");
  }
  if (request.action === "screenshot" && typeof store.shootSite !== "function") {
    return toolError("screenshots are not available on this deployment; a site check needs no browser.");
  }
  const answer = await store.site({
    action: request.action,
    ...(request.draft ? { draft: request.draft } : {}),
    ...(request.inspect ? { inspect: request.inspect } : {}),
    ...(request.revision !== undefined ? { revision: request.revision } : {}),
    ...(request.action === "screenshot" ? { page: request.page ?? "/" } : {}),
  });
  if (answer === null) return toolError(REFUSED);
  if (request.action === "screenshot") return await photograph(store, answer, request.sizes ?? SIZES);
  if (request.action === "check") return describeCheck(answer);
  if (request.action === "history") return describeHistory(answer);
  return request.action === "status" ? describeStatus(answer) : describePublish(answer);
}

function when(ms) {
  return typeof ms === "number" ? ` (${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC)` : "";
}

function describeStatus(site) {
  if (!site.enabled) {
    return toolText(OFF);
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

function size(bytes) {
  if (typeof bytes !== "number") return "";
  if (bytes < 1024) return ` (${bytes} B)`;
  if (bytes < 1024 * 1024) return ` (${Math.round(bytes / 1024)} KB)`;
  return ` (${(bytes / 1024 / 1024).toFixed(1)} MB)`;
}

const OFF = "the website is off. Only the workspace's owner can turn it on, in the app; until then nothing under website/ is published.";

function describeCheck(check) {
  if (!check.enabled) return toolText(OFF);
  const lines = [`website check · draft ${check.draft}`];
  const routes = check.routes.map((route) => `${route.address} ← ${route.path}${route.status === "live" ? "" : ` (${route.status})`}`);
  lines.push(`addresses (${routes.length}): ${routes.join("; ") || "none"}`);
  let blocking = 0;
  if (check.pageProblems.length > 0) {
    blocking += check.pageProblems.length;
    lines.push(`problems that stop Publish (${check.pageProblems.length}):`);
    for (const page of check.pageProblems) lines.push(`- ${page.path}: ${page.problems.join(" ")}`);
  }
  if (check.links.length > 0) {
    lines.push(`links that go nowhere (${check.links.length + check.more.links}):`);
    for (const link of check.links) lines.push(`- ${link.path}:${link.line} → ${link.target}: ${link.problem}`);
    if (check.more.links > 0) lines.push(`- …and ${check.more.links} more; fix these and check again.`);
  }
  if (check.pictures.length > 0) {
    lines.push(`pictures (${check.pictures.length}):`);
    for (const picture of check.pictures) {
      const labels = (picture.labels ?? []).map((label) => `, "${label}"`).join("");
      lines.push(`- ${picture.name}${size(picture.bytes)}${labels}, used by ${picture.usedBy.join(", ")}${picture.problem ? `: ${picture.problem}` : ""}`);
    }
  }
  const removed = check.code.flatMap((note) =>
    note.removed.map((removal) => `- ${note.path}${removal.line === null ? "" : `:${removal.line}`} ${removal.what}: ${removal.why}`),
  );
  if (removed.length > 0) {
    lines.push(`removed by the cleaner (${removed.length + check.more.removed}):`, ...removed);
    if (check.more.removed > 0) lines.push(`- …and ${check.more.removed} more.`);
  }
  if (check.warnings.length > 0) {
    lines.push(`draws nothing, or less than it says (${check.warnings.length}):`);
    for (const warning of check.warnings) lines.push(`- ${warning.path}: ${warning.why}`);
  }
  const found = check.links.length + removed.length + check.warnings.length + check.pictures.filter((p) => p.problem).length;
  if (found === 0 && blocking === 0) lines.push("nothing to fix.");
  lines.push(
    blocking > 0
      ? "fix the problems that stop Publish, then check again."
      : `to publish exactly this draft: write_note { path: "website/index.md", site: { action: "publish", draft: "${check.draft}" } }`,
  );
  if (check.inspected) {
    const fence = check.inspected.path.endsWith(".css.md") ? "css" : "html";
    lines.push(
      "",
      `${check.inspected.path} as the site draws it${check.inspected.truncated ? " (cut short)" : ""}:`,
      `\`\`\`${fence}`,
      check.inspected.output,
      "\`\`\`",
    );
  }
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

/**
 * The kept versions, or one version's files to write back. Rolling back is
 * writing them: they become the draft, and the same Publish releases them.
 */
function describeHistory(history) {
  if (history.message) return toolError(history.message);
  if (history.version === null) {
    if (history.versions.length === 0) return toolText("no published versions are kept yet; each Publish keeps one, the last 5.");
    const lines = ["published versions kept (newest first; each Publish keeps one, the last 5):"];
    for (const version of history.versions) {
      lines.push(`- revision ${version.revision}${when(version.publishedAt)}: ${version.pages} pages${version.live ? " (live now)" : ""}`);
    }
    lines.push('to see one version\'s files: write_note { path: "website/index.md", site: { action: "history", revision: N } }');
    return toolText(lines.join("\n"));
  }
  const version = history.version;
  const lines = [
    `revision ${version.revision}${when(version.publishedAt)}, as it was published. To roll back, write each file below with write_note ` +
      "(read the note first and pass its etag where it still exists). That makes it the draft; check it, then publish it. Nothing goes live before.",
  ];
  if (version.addedSince.length > 0) {
    lines.push(`added since this version (draft or delete them to match it): ${version.addedSince.join(", ")}`);
  }
  if (version.withheld > 0) {
    lines.push(`${version.withheld} page${version.withheld === 1 ? " is" : "s are"} not shown: privacy.md holds them back now, or they are encrypted.`);
  }
  if (version.more.length > 0) {
    lines.push(`too long for one answer; ask for each with inspect: ${version.more.join(", ")}`);
  }
  for (const file of version.files) {
    const fence = "`".repeat(Math.max(4, ...[...file.text.matchAll(/`{3,}/g)].map((run) => run[0].length + 1)));
    lines.push("", `${file.path}:`, `${fence}markdown`, file.text.replace(/\n$/, ""), fence);
  }
  return toolText(lines.join("\n"));
}
