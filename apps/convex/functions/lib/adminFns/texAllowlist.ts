/**
 * WHO MAY TEXT TEX: THE LINQ SHARED LINE'S CONTACT LIST.
 *
 * Tex answers on Linq's free shared line, and that line only forwards a text
 * from a number on its contact list, at most twenty of them (Dev2, 2026-10-13:
 * "we only have 20 slots with the linq trial, I wanna make sure we are
 * handling that properly"). A number that is not on the list gets nothing back
 * and leaves no trace on our side, because Linq never delivers it.
 *
 * Linq keeps the list, so this file reads and changes Linq's copy and keeps
 * none of its own: a second copy here would drift the first time somebody used
 * Linq's CLI (`linq contacts add`), and the twenty slots are Linq's to count.
 * The calls are the ones that CLI makes (`@linqapp/cli` 2.7.0,
 * `commands/contacts/*`), with the same Partner API key the texting Worker
 * replies with, `LINQ_API_KEY`, set on the control plane by the deploy:
 *
 *   GET  /cli/account-info            which organization, and what kind of line
 *   GET  /cli/contacts?orgId=…        the list
 *   POST /cli/contacts/add            { orgId, contactPhone }
 *   POST /cli/contacts/remove         { orgId, contactPhone }
 *
 * A paid or dedicated line has no list: anybody can text it, and the answer
 * says so instead of drawing twenty empty slots.
 *
 * The key never leaves this file, and a failure is reported in our words with
 * Linq's status code, never with Linq's body.
 */

import { v, type Infer } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import { normalizePhone } from "../phoneCheck";
import { usernameOf } from "./people";

export const LINQ_ZERO_SERVICE = "https://prod.zero-service.linqapp.com";

/** Linq's shared line: "max 20 per shared line". */
export const SHARED_LINE_CAP = 20;

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256_000;
const E164 = /^\+[1-9]\d{6,14}$/;

export interface LinqEnv {
  LINQ_API_KEY?: string;
}

export interface LinqContact {
  phone: string;
  /** When Linq added it, in milliseconds; `null` when Linq did not say. */
  addedAt: number | null;
}

export type LinqLine =
  | { state: "not_connected" }
  | { state: "error"; error: string }
  | { state: "unlimited"; line: string | null }
  | { state: "shared"; orgId: string; line: string | null; contacts: LinqContact[] };

export type LinqChange =
  | { status: "added"; phone: string }
  | { status: "removed"; phone: string }
  | { status: "invalid" }
  | { status: "already"; phone: string }
  | { status: "absent"; phone: string }
  | { status: "full"; cap: number }
  | { status: "error"; error: string };

type Fetch = typeof fetch;

/** The person a listed number belongs to, as far as the control plane knows. */
export const texPersonValidator = v.union(
  v.null(),
  v.object({
    name: v.union(v.string(), v.null()),
    email: v.union(v.string(), v.null()),
    username: v.union(v.string(), v.null()),
    /** The phone is linked to this account for texting, so Tex answers as them. */
    linked: v.boolean(),
  }),
);

export const texAllowlistValidator = v.union(
  v.object({ state: v.literal("not_connected") }),
  v.object({ state: v.literal("error"), error: v.string() }),
  v.object({ state: v.literal("unlimited"), line: v.union(v.string(), v.null()) }),
  v.object({
    state: v.literal("shared"),
    line: v.union(v.string(), v.null()),
    cap: v.number(),
    contacts: v.array(
      v.object({ phone: v.string(), addedAt: v.union(v.number(), v.null()), person: texPersonValidator }),
    ),
  }),
);

export const texChangeValidator = v.union(
  v.object({ status: v.literal("added"), phone: v.string() }),
  v.object({ status: v.literal("removed"), phone: v.string() }),
  v.object({ status: v.literal("invalid") }),
  v.object({ status: v.literal("already"), phone: v.string() }),
  v.object({ status: v.literal("absent"), phone: v.string() }),
  v.object({ status: v.literal("full"), cap: v.number() }),
  v.object({ status: v.literal("error"), error: v.string() }),
);

class LinqFailure extends Error {}

async function call(
  key: string,
  fetchImpl: Fetch,
  path: string,
  body?: Record<string, string>,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${LINQ_ZERO_SERVICE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
  } catch {
    throw new LinqFailure("Linq could not be reached. Try again in a minute.");
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 401 || response.status === 403) {
    throw new LinqFailure("Linq refused the API key. Check LINQ_API_KEY is the shared line's key.");
  }
  if (!response.ok) throw new LinqFailure(`Linq answered ${response.status}. Try again, or check the line in Linq.`);
  const text = await response.text().catch(() => "");
  if (text.length > MAX_BODY_BYTES) throw new LinqFailure("Linq's answer was too large.");
  try {
    return text === "" ? {} : JSON.parse(text);
  } catch {
    throw new LinqFailure("Linq's answer was not readable.");
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= 128 ? value.trim() : null;
}

function asTime(value: unknown): number | null {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** The line, and its list when it has one. Never throws. */
export async function readLinqLine(env: LinqEnv, fetchImpl: Fetch = globalThis.fetch): Promise<LinqLine> {
  const key = env.LINQ_API_KEY?.trim();
  if (!key) return { state: "not_connected" };
  try {
    const account = (await call(key, fetchImpl, "/cli/account-info")) as {
      orgId?: unknown;
      accountInfo?: { accountLabel?: unknown; phones?: Array<{ phoneNumber?: unknown }> };
    };
    const orgId = asString(account?.orgId);
    const label = asString(account?.accountInfo?.accountLabel);
    const phones = Array.isArray(account?.accountInfo?.phones) ? account.accountInfo.phones : [];
    const line = phones.map((p) => asString(p?.phoneNumber)).find((p) => p !== null && E164.test(p)) ?? null;
    if (label !== null && label !== "Shared") return { state: "unlimited", line };
    if (orgId === null) return { state: "error", error: "Linq did not say which account this key belongs to." };

    const listed = (await call(key, fetchImpl, `/cli/contacts?orgId=${encodeURIComponent(orgId)}`)) as {
      contacts?: Array<{ contactPhone?: unknown; createdAt?: unknown }>;
    };
    const seen = new Set<string>();
    const contacts: LinqContact[] = [];
    for (const row of Array.isArray(listed?.contacts) ? listed.contacts : []) {
      const phone = asString(row?.contactPhone);
      if (phone === null || !E164.test(phone) || seen.has(phone)) continue;
      seen.add(phone);
      contacts.push({ phone, addedAt: asTime(row?.createdAt) });
    }
    contacts.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
    return { state: "shared", orgId, line, contacts };
  } catch (error) {
    return { state: "error", error: error instanceof LinqFailure ? error.message : "Linq could not be read." };
  }
}

function notShared(line: LinqLine): LinqChange | null {
  if (line.state === "not_connected") {
    return { status: "error", error: "The control plane has no LINQ_API_KEY, so it cannot reach Linq." };
  }
  if (line.state === "error") return { status: "error", error: line.error };
  if (line.state === "unlimited") {
    return { status: "error", error: "This Linq line has no contact list: anybody can text it." };
  }
  return null;
}

/**
 * Put `typed` on the list. Refused when it is not a phone, already listed, or
 * the list is full, so a twenty-first number is a sentence in the console
 * rather than a number that silently never reaches Tex.
 */
export async function addToLinqLine(
  env: LinqEnv,
  typed: string,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<LinqChange> {
  return (await addToLinqLineAt(env, typed, fetchImpl)).change;
}

/**
 * `addToLinqLine`, also saying the line's own number when Linq gave one, so
 * the "You're in" text can tell somebody just added which number to text.
 */
export async function addToLinqLineAt(
  env: LinqEnv,
  typed: string,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<{ change: LinqChange; line: string | null; unlimited?: true }> {
  const phone = normalizePhone(typed);
  if (phone === null) return { change: { status: "invalid" }, line: null };
  const line = await readLinqLine(env, fetchImpl);
  const refused = notShared(line);
  // A line with no list refuses the add, but anybody can text it.
  if (line.state === "unlimited") return { change: refused!, line: line.line, unlimited: true };
  if (refused !== null || line.state !== "shared") return { change: refused!, line: null };
  const at = (change: LinqChange) => ({ change, line: line.line });
  if (line.contacts.some((contact) => contact.phone === phone)) return at({ status: "already", phone });
  if (line.contacts.length >= SHARED_LINE_CAP) return at({ status: "full", cap: SHARED_LINE_CAP });
  try {
    await call(env.LINQ_API_KEY!.trim(), fetchImpl, "/cli/contacts/add", { orgId: line.orgId, contactPhone: phone });
  } catch (error) {
    return at({ status: "error", error: error instanceof LinqFailure ? error.message : "Linq could not be reached." });
  }
  return at({ status: "added", phone });
}

/** Take `typed` off the list, which frees its slot. */
export async function removeFromLinqLine(
  env: LinqEnv,
  typed: string,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<LinqChange> {
  const phone = normalizePhone(typed);
  if (phone === null) return { status: "invalid" };
  const line = await readLinqLine(env, fetchImpl);
  const refused = notShared(line);
  if (refused !== null || line.state !== "shared") return refused!;
  if (!line.contacts.some((contact) => contact.phone === phone)) return { status: "absent", phone };
  try {
    await call(env.LINQ_API_KEY!.trim(), fetchImpl, "/cli/contacts/remove", { orgId: line.orgId, contactPhone: phone });
  } catch (error) {
    return { status: "error", error: error instanceof LinqFailure ? error.message : "Linq could not be reached." };
  }
  return { status: "removed", phone };
}

export type TexPerson = Infer<typeof texPersonValidator>;
export type TexAllowlist = Infer<typeof texAllowlistValidator>;

/**
 * Whose each listed number is: the account it is linked to for texting, or
 * else the account that signs in with it. A number nobody holds is `null`,
 * which the console shows as "No account yet".
 */
export async function peopleForPhones(ctx: QueryCtx, phones: readonly string[]): Promise<TexPerson[]> {
  const out: TexPerson[] = [];
  for (const phone of phones.slice(0, SHARED_LINE_CAP * 2)) {
    const link = await ctx.db
      .query("phoneLinks")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    const user =
      link !== null
        ? await ctx.db.get(link.userId)
        : await ctx.db
            .query("users")
            .withIndex("by_phone", (q) => q.eq("phone", phone))
            .first();
    out.push(
      user === null
        ? null
        : {
            name: user.name ?? null,
            email: user.email ?? null,
            username: await usernameOf(ctx, user._id),
            linked: link !== null,
          },
    );
  }
  return out;
}
