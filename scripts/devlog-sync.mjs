#!/usr/bin/env node
/**
 * Copy the published devlog's newest week to a draft GitHub Release, and,
 * when the owner has switched it on, to one Discord message.
 *
 * Downstream only: it reads the page the owner already published and never
 * writes back to it. A page with a promise in exploring stops it before any
 * write. The release is always a draft; publishing it is the owner's act,
 * and a release that is already published is theirs and is not touched.
 * Each week is one release and at most one Discord message, found again by
 * the marker in the release body, so hourly runs are no-ops until the week
 * changes. See `docs/decisions/release-communication.md`.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { devlogPromiseProblems } from "../packages/shared/src/devlog.ts";
import {
  decideDiscord,
  decideRelease,
  readPublishedDevlog,
  releasePayload,
  renderDiscordMessage,
} from "./devlog-copy.mjs";

const DISCORD_WEBHOOK = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

function githubClient(repository, token, fetchImpl) {
  if (!token) throw new Error("GH_TOKEN is required to keep the draft release.");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  return async (method, path, body) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/${path}`, {
      method,
      headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path.split("?")[0]}: HTTP ${response.status}`);
    return response.json();
  };
}

async function allReleases(api) {
  const releases = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await api("GET", `releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

/** Post or edit the one message. The webhook URL is a secret: never logged. */
async function discord(fetchImpl, webhook, messageId, content) {
  const url = messageId ? `${webhook}/messages/${messageId}` : `${webhook}?wait=true`;
  const response = await fetchImpl(url, {
    method: messageId ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!response.ok) throw new Error(`Discord ${messageId ? "edit" : "post"} failed: HTTP ${response.status}`);
  const message = await response.json();
  if (!/^\d+$/.test(String(message?.id ?? ""))) throw new Error("Discord returned no message id.");
  return String(message.id);
}

export async function main({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) {
    throw new Error("GITHUB_REPOSITORY must be owner/name.");
  }
  const devlog = await readPublishedDevlog(env.DEVLOG_CONVEX_URL, fetchImpl);
  const problems = devlogPromiseProblems(devlog.markdown);
  if (problems.length > 0) {
    throw new Error(`The published devlog has page problems; nothing was copied.\n${problems.join("\n")}`);
  }
  const week = devlog.latest;
  if (!week) throw new Error("The published devlog has no week to copy.");

  const api = githubClient(env.GITHUB_REPOSITORY, env.GH_TOKEN, fetchImpl);
  const decision = decideRelease(await allReleases(api), week);
  if (decision.action === "published") {
    log(`Week ${week.number} is already a published release; it is the owner's, so it was left alone.`);
    return { release: "published", discord: "none" };
  }

  const webhook = env.DEVLOG_DISCORD_WEBHOOK || null;
  let messageId = decision.marker?.discordMessageId ?? null;
  const discordAction = decideDiscord({
    webhook,
    flag: env.DEVLOG_DISCORD,
    releaseAction: decision.action,
    messageId,
  });
  if ((discordAction === "post" || discordAction === "patch") && !DISCORD_WEBHOOK.test(webhook)) {
    throw new Error("DEVLOG_DISCORD_WEBHOOK is not a Discord webhook URL; nothing was copied.");
  }

  const payload = (id) => releasePayload(week, { revision: devlog.revision, discordMessageId: id });
  let release = decision.release;
  if (decision.action === "create") release = await api("POST", "releases", payload(messageId));
  if (decision.action === "update") release = await api("PATCH", `releases/${release.id}`, payload(messageId));
  log(`Week ${week.number} draft release: ${decision.action === "none" ? "unchanged" : `${decision.action}d`}.`);

  if (discordAction === "post" || discordAction === "patch") {
    const content = renderDiscordMessage(week);
    const posted = await discord(fetchImpl, webhook, discordAction === "patch" ? messageId : null, content);
    if (discordAction === "post") {
      messageId = posted;
      // Recorded so the next change edits this message instead of posting again.
      await api("PATCH", `releases/${release.id}`, payload(messageId));
    }
    log(`Week ${week.number} Discord message: ${discordAction === "post" ? "posted" : "edited"}.`);
  }
  return { release: decision.action, discord: discordAction };
}

const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
