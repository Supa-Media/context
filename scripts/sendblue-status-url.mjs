#!/usr/bin/env node
/**
 * The address Sendblue posts each send's status to (`SENDBLUE_STATUS_URL`,
 * `apps/agent/src/sendblueStatus.ts`), worked out at deploy time.
 *
 *   SENDBLUE_WEBHOOK_SECRET=… node scripts/sendblue-status-url.mjs <worker> <workers.dev subdomain>
 *
 * Why: the receipts code shipped, but production never had the address set,
 * so no delivery receipt ever arrived and a reply Sendblue held for minutes
 * looked delivered (2026-11-07 and 2026-11-11). Nobody had to mint a new
 * secret for it: the path's secret is an HMAC of the Sendblue webhook secret
 * the deploy already holds, so it is stable across deploys, different from
 * that secret, and absent whenever that secret is. The Worker's own check
 * (`statusPath`) refuses anything but `https://…/sendblue/status/<16-128 of
 * [A-Za-z0-9_-]>`, which base64url always is.
 *
 * Prints the address, or nothing when an input is missing. Never logs it.
 */
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

const LABEL = "context-agent sendblue status callback";

/** The status address for this Worker, or "" when any input is missing. */
export function sendblueStatusUrl(worker, subdomain, webhookSecret) {
  const name = (worker ?? "").trim();
  const sub = (subdomain ?? "").trim();
  const secret = (webhookSecret ?? "").trim();
  if (!name || !sub || !secret) return "";
  if (!/^[a-z0-9-]+$/.test(name) || !/^[a-z0-9-]+$/.test(sub)) throw new Error("sendblue-status-url.mjs: worker and subdomain are DNS labels");
  const key = createHmac("sha256", secret).update(LABEL).digest("base64url").slice(0, 43);
  return `https://${name}.${sub}.workers.dev/sendblue/status/${key}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [worker, subdomain] = process.argv.slice(2);
  process.stdout.write(sendblueStatusUrl(worker, subdomain, process.env.SENDBLUE_WEBHOOK_SECRET));
}
