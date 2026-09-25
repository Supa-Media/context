/**
 * A fake Cloudflare zone and a fake public resolver, for the custom-domain
 * tests. Every value is obviously fake; `.invalid` and `.example` names never
 * resolve anywhere.
 */

import { vi } from "vitest";
import type { Id } from "../../_generated/dataModel";
import {
  CUSTOM_DOMAINS_TARGET_ENV_VAR,
  CUSTOM_DOMAINS_TOKEN_SECRET,
  CUSTOM_DOMAINS_ZONE_ENV_VAR,
} from "../../functions/lib/customDomains/config";
import { createUser, createWorkspace, seedAppSecret, type TestConvex } from "../fixtures.helpers";

export const ZONE_ID = "0123456789abcdef0123456789abcdef";
export const TARGET = "customers.context-test.example.com";
export const OPERATOR_TOKEN = "example-custom-hostnames-token-not-a-real-one";

export interface FakeRegistration {
  id: string;
  hostname: string;
  status: string;
  ssl: { status: string };
  ownership_verification?: { type: string; name: string; value: string };
}

/**
 * The world outside: registrations in our zone, and TXT records in DNS.
 * Tests flip `status`/`ssl.status` and `txt` to move a domain along.
 */
export function stubWorld() {
  const registrations = new Map<string, FakeRegistration>();
  const txt = new Map<string, string[]>();
  const calls: { method: string; url: string }[] = [];
  let nextId = 1;
  const failures = { deleteFails: false, providerDown: false };
  /** Other hosts a test answers for itself, such as a DNS provider's Domain Connect API. */
  const hosts = new Map<string, (url: URL) => { status: number; body: unknown }>();

  const envelope = (result: unknown, status = 200, errors: unknown[] = []) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify({ success: status < 300, errors, result }),
    json: async () => ({ success: status < 300, errors, result }),
  });

  vi.stubGlobal("fetch", async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      const name = new URL(url).searchParams.get("name") ?? "";
      const values = txt.get(name) ?? [];
      return {
        ok: true,
        status: 200,
        json: async () => ({ Status: 0, Answer: values.map((value) => ({ type: 16, data: `"${value}"` })) }),
      };
    }
    const other = hosts.get(new URL(url).host);
    if (other !== undefined) {
      const { status, body } = other(new URL(url));
      return { ok: status < 300, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) };
    }
    if (!url.startsWith(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/custom_hostnames`)) {
      throw new Error(`unexpected fetch ${method} ${url}`);
    }
    if (init?.headers?.Authorization !== `Bearer ${OPERATOR_TOKEN}`) return envelope(null, 403, [{ code: 10000 }]);
    if (failures.providerDown) return envelope(null, 503, [{ code: 1 }]);
    const path = url.slice(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/custom_hostnames`.length);
    if (method === "POST") {
      const body = JSON.parse((init as { body: string }).body) as { hostname: string };
      if ([...registrations.values()].some((row) => row.hostname === body.hostname)) {
        return envelope(null, 409, [{ code: 1406, message: "Duplicate custom hostname found." }]);
      }
      const id = `ch_${nextId++}`;
      const row = {
        id,
        hostname: body.hostname,
        status: "pending",
        ssl: { status: "initializing" },
        ownership_verification: {
          type: "txt",
          name: `_cf-custom-hostname.${body.hostname}`,
          value: `00000000-0000-4000-8000-${id.replace(/\D/g, "").padStart(12, "0")}`,
        },
      };
      registrations.set(row.id, row);
      return envelope(row);
    }
    if (method === "GET" && path.startsWith("?hostname=")) {
      const hostname = decodeURIComponent(path.slice("?hostname=".length));
      return envelope([...registrations.values()].filter((row) => row.hostname === hostname));
    }
    const id = decodeURIComponent(path.slice(1));
    const row = registrations.get(id);
    if (row === undefined) return envelope(null, 404, [{ code: 1436, message: "not found" }]);
    if (method === "DELETE") {
      if (failures.deleteFails) return envelope(null, 503, [{ code: 1 }]);
      registrations.delete(id);
      return envelope({ id });
    }
    return envelope(row);
  });

  return {
    registrations,
    txt,
    calls,
    failures,
    hosts,
    /** Point DNS at us and let the certificate issue. */
    goLive(hostname: string) {
      for (const row of registrations.values()) {
        if (row.hostname === hostname) {
          row.status = "active";
          row.ssl.status = "active";
        }
      }
    },
  };
}

export async function configureDomains(t: TestConvex): Promise<void> {
  vi.stubEnv(CUSTOM_DOMAINS_ZONE_ENV_VAR, ZONE_ID);
  vi.stubEnv(CUSTOM_DOMAINS_TARGET_ENV_VAR, TARGET);
  await seedAppSecret(t, CUSTOM_DOMAINS_TOKEN_SECRET, OPERATOR_TOKEN);
}

export async function payingWorkspace(
  t: TestConvex,
  slug: string,
): Promise<{ owner: Id<"users">; workspaceId: Id<"workspaces"> }> {
  const owner = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, owner, slug);
  await setPlan(t, workspaceId, "active");
  return { owner, workspaceId };
}

export async function setPlan(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  status: "active" | "canceled",
): Promise<void> {
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("workspacePlans")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (existing !== null) {
      await ctx.db.patch(existing._id, { status });
      return;
    }
    await ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: false,
      fastSearch: true,
      status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

/** Run what is due now, without running the checks scheduled for later. */
export async function runDue(t: TestConvex): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
  }
}

export async function shortLink(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  createdBy: Id<"users">,
  slug: string,
  recipientKind: "anyone" | "members",
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("noteShares", {
      workspaceId,
      entryPath: `website/${slug}.md`,
      recipientKind,
      recipient: recipientKind,
      createdBy,
      token: `${slug}-token-0000000000000000000000000000000000000000000000000000`.slice(0, 64),
      status: "active",
      titleInPreview: true,
      slug,
      createdAt: Date.now(),
    });
  });
}
