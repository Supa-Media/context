/**
 * ONE RECORD OF WHICH PAYER'S CREDIT IS SPENT, shared by every isolate.
 *
 * The plan key is tried before Unified Billing (`aiGateway.js`). When Anthropic
 * says that credit is gone, the payer rests for `CREDIT_REST_MS` and later
 * calls skip it. That rest used to live in the isolate's memory, so every
 * other isolate learned by sending the spent key itself and then the call
 * again on Unified Billing (production, 2026-11-12: one failed 400 plus one
 * paid call, about $8.80 a day). This object is that rest for the whole
 * gateway: one Durable Object, payer names and a timestamp, never a key and
 * never a prompt.
 *
 * A call reads it at most every `FRESH_MS` while a payer looks available, and
 * not at all while the local copy of the rest is still in the future. When
 * the rest expires, one caller probes the key; the others skip it until that
 * probe lands. A read that fails or takes longer than `STORE_WAIT_MS` tries
 * the key, so a stuck object costs one extra attempt, never a dropped turn.
 *
 * The rest is fifteen minutes, the same as before. The next probe after it
 * clears the record when the credit answers, which is how a monthly refill
 * (the plan's credit returns on the 21st) starts being spent again without
 * anyone clearing the record by hand.
 *
 * Self-hosting on the free tier: leave the `CREDIT_REST` binding out. Each
 * isolate then keeps its own rest, as it did before this object existed.
 */

import { objectByName } from "../../../../apps/mcp/src/objectPlace.js";

/** How long a spent payer is skipped before one caller tries it again. */
export const CREDIT_REST_MS = 15 * 60_000;

/** How long an isolate trusts "this payer is available" before asking the object again. */
export const FRESH_MS = 15_000;

/** How long other callers skip a payer while one of them is probing it. */
const PROBE_MS = 30_000;

/** A hung object must not hold the model call. */
const STORE_WAIT_MS = 400;

/** The one object's name. A new name would be a new, empty rest. */
export const CREDIT_REST_OBJECT = "ai-gateway-credit-rest:v1";

/** The gateway route a benchmark runner uses to read and write this object. It has no Durable Object binding of its own. */
export const CREDIT_REST_PATH = "/credit-rest";

/** `plan`, or `alias:<name>` as `aiGateway.js` labels a stored key. */
const PAYER = /^(plan|alias:[a-z0-9][a-z0-9_-]{0,63})$/;

const payerName = (name) => (typeof name === "string" && PAYER.test(name) ? name : null);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * The one object. `book` is `{ [payer]: { until, probeUntil } }`. `until` is
 * when the rest ends; `probeUntil` is when the single in-flight probe gives up.
 */
export class CreditRestObject {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const action = new URL(request.url).pathname;
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const name = payerName(body?.name);
    const now = Number(body?.now);
    const book = (await this.storage.get("book")) ?? {};
    const row = name ? book[name] ?? null : null;

    if (action === "/claim") {
      if (!name || !Number.isFinite(now)) return json({ try: true });
      if (row && now < row.until) return json({ try: false, until: row.until });
      if (row && now < (row.probeUntil ?? 0)) return json({ try: false, until: row.probeUntil });
      if (row && row.until > 0) {
        book[name] = { ...row, probeUntil: now + PROBE_MS };
        await this.storage.put("book", book);
        return json({ try: true, probe: true });
      }
      return json({ try: true });
    }

    if (action === "/spent") {
      const until = Number(body?.until);
      if (!name || !Number.isFinite(until)) return new Response(null, { status: 400 });
      book[name] = { until: Math.max(row?.until ?? 0, until), probeUntil: 0 };
      await this.storage.put("book", book);
      return json({ until: book[name].until });
    }

    if (action === "/clear") {
      if (!name) return new Response(null, { status: 400 });
      delete book[name];
      await this.storage.put("book", book);
      return json({ ok: true });
    }

    return new Response(null, { status: 404 });
  }
}

/** The object as the gateway calls it, or null when the binding is absent. Never throws. */
export function creditStoreOf(env) {
  const namespace = env?.CREDIT_REST;
  if (!namespace || typeof namespace.idFromName !== "function" || typeof namespace.get !== "function") return null;
  const call = async (action, body) => {
    const response = await objectByName(namespace, CREDIT_REST_OBJECT).fetch(
      new Request(`https://credit-rest.invalid${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) throw new Error("credit rest refused");
    return response.json();
  };
  return {
    claim: (name, now) => call("/claim", { name, now }),
    spent: (name, until) => call("/spent", { name, until }),
    clear: (name) => call("/clear", { name }),
  };
}

/** One isolate's copy of the rest. Tests pass their own; the process keeps one. */
export function createCreditCache() {
  return { until: new Map(), fresh: new Map(), probing: new Set() };
}

const processCache = createCreditCache();

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * `POST /credit-rest` for the benchmark runner. The bearer is the gateway
 * token the runner already holds. A wrong token is a 404, the same as a
 * worker with no such route. The body is an op and a payer name, never a key
 * and never a prompt.
 *
 * The runner's clock is not this worker's. A claim uses `Date.now()` here,
 * and a spent mark is kept at most `CREDIT_REST_MS` ahead of it. A larger
 * finite `until` is clamped and logged. A non-finite `until` is forwarded
 * unchanged, the same as before this bound. Callers inside this worker do
 * not come through here, and the object still stores the timestamp they send.
 */
export async function handleCreditRest(request, env) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!sameSecret(bearer, env?.AI_GATEWAY_TOKEN)) return new Response(null, { status: 404 });
  const store = creditStoreOf(env);
  if (!store) return new Response(null, { status: 404 });
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  try {
    if (body?.op === "claim") return json(await store.claim(body.name, Date.now()));
    if (body?.op === "spent") {
      const bound = clampedUntil(body);
      const result = await store.spent(body.name, bound.until);
      if (bound.clamped) {
        const payer = typeof body.name === "string" ? body.name.slice(0, 80) : null;
        console.log(JSON.stringify({ event: "credit_rest_clamped", payer, asked: bound.asked, kept: bound.until }));
      }
      return json(result);
    }
    if (body?.op === "clear") return json(await store.clear(body.name));
  } catch {
    return new Response(null, { status: 502 });
  }
  return new Response(null, { status: 400 });
}

/** The runner's `until`, at most one rest ahead of this worker. A non-finite value is unchanged. */
function clampedUntil(body) {
  const asked = Number(body?.until);
  const cap = Date.now() + CREDIT_REST_MS;
  if (!Number.isFinite(asked) || asked <= cap) return { until: asked, clamped: false };
  return { until: cap, clamped: true, asked };
}

/** For tests: forget the process-wide copy. A store the test holds is its own. */
export function resetCreditCache() {
  processCache.until.clear();
  processCache.fresh.clear();
  processCache.probing.clear();
}

/** Ask the store, and give up after `STORE_WAIT_MS` so a stuck object never holds the call. */
async function ask(work) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), STORE_WAIT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether to skip `name` and let the next payer (or Unified Billing) pay.
 * True while this isolate, or any other, already knows the credit is spent.
 */
export async function payerSkipped(name, now, { store = null, cache = processCache } = {}) {
  if (now < (cache.until.get(name) ?? 0)) return true;
  if (!store) return false;
  if (now < (cache.fresh.get(name) ?? 0)) return false;
  const claim = await ask(store.claim(name, now));
  if (!claim || claim.try !== false) {
    cache.fresh.set(name, now + FRESH_MS);
    if (claim?.probe === true) cache.probing.add(name);
    return false;
  }
  const until = Number(claim.until);
  if (Number.isFinite(until) && until > now) cache.until.set(name, until);
  return true;
}

/** `name`'s credit is spent until `until`. Remembered here and, when there is one, in the object. */
export async function noteCreditSpent(name, until, { store = null, cache = processCache } = {}) {
  cache.until.set(name, until);
  cache.fresh.delete(name);
  cache.probing.delete(name);
  if (store) await ask(store.spent(name, until));
  console.log(JSON.stringify({ event: "ai_gateway_credit_rest", payer: name, until }));
}

/**
 * `name` just paid. A probe that found the credit back, or a rest this isolate
 * was holding, is cleared so the next call tries the key. A normal success
 * writes nothing.
 */
export async function noteCreditPaid(name, { store = null, cache = processCache } = {}) {
  const probing = cache.probing.has(name);
  const resting = (cache.until.get(name) ?? 0) > 0;
  cache.until.delete(name);
  cache.fresh.delete(name);
  cache.probing.delete(name);
  if (store && (probing || resting)) await ask(store.clear(name));
}
