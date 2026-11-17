#!/usr/bin/env node
/**
 * Load the Air France check-in page on Browser Use and stop the session.
 *
 * Load only: nothing is typed and nothing is submitted. The same calls the
 * screenshot Worker makes (balance, create, CDP navigate, stop, cost).
 * Refuses when the balance is under $0.50 or the balance call fails.
 *
 *   BROWSER_USE_API_KEY=… node scripts/browser-use-lab.mjs
 *
 * The key is the Worker secret `BROWSER_USE_API_KEY` on
 * `context-site-shots-staging` (and, optionally, production). GitHub Actions
 * secret of the same name is what the deploy workflows copy. Production's
 * flag stays off (`browsers.browserUseFallback` in texConfig.json).
 */

const PAGE = "https://wwws.airfrance.com/check-in";
const KEY = process.env.BROWSER_USE_API_KEY ?? "";
const ORIGIN = "https://api.browser-use.com";

if (!KEY) {
  console.error("BROWSER_USE_API_KEY is not set.");
  console.error("Set the GitHub Actions secret BROWSER_USE_API_KEY. Deploy staging copies it onto the Worker context-site-shots-staging.");
  console.error("Do not merge until this load has run. Production flag stays off.");
  process.exit(2);
}

const headers = { "X-Browser-Use-API-Key": KEY, "content-type": "application/json" };

async function api(method, path, body) {
  const response = await fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

function connect(url) {
  const ws = new WebSocket(url);
  let next = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "cdp"));
    else waiter.resolve(message.result);
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      resolve({
        send(method, params, sessionId) {
          const id = next++;
          ws.send(JSON.stringify({ id, method, params, sessionId }));
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("error", () => reject(new Error("cdp connect failed")));
  });
}

const started = Date.now();
let sessionId = null;
try {
  const balanceStarted = Date.now();
  const balance = await api("GET", "/api/v2/billing/account");
  const balanceMs = Date.now() - balanceStarted;
  const usd = Number(balance.json?.totalCreditsBalanceUsd);
  if (balance.status !== 200 || !Number.isFinite(usd)) {
    console.error(`balance check failed (${balance.status}) after ${balanceMs}ms`);
    process.exit(1);
  }
  if (usd < 0.5) {
    console.error(`balance $${usd} is under $0.50 after ${balanceMs}ms; not starting a session`);
    process.exit(1);
  }
  console.log(`balance $${usd} in ${balanceMs}ms`);

  const createStarted = Date.now();
  const created = await api("POST", "/api/v4/browsers", { timeout: 15, proxyCountryCode: "us" });
  const createMs = Date.now() - createStarted;
  sessionId = created.json?.id ?? null;
  const cdpUrl = created.json?.cdpUrl;
  if (created.status !== 201 && created.status !== 200 || typeof sessionId !== "string" || typeof cdpUrl !== "string") {
    console.error(`create failed (${created.status}) after ${createMs}ms`);
    process.exit(1);
  }
  console.log(`session started in ${createMs}ms`);

  const navStarted = Date.now();
  const cdp = await connect(cdpUrl);
  try {
    const targets = await cdp.send("Target.getTargets");
    let targetId = targets.targetInfos?.find((target) => target.type === "page")?.targetId;
    if (!targetId) targetId = (await cdp.send("Target.createTarget", { url: "about:blank" })).targetId;
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.navigate", { url: PAGE }, attached.sessionId);
    const info = await cdp.send("Runtime.evaluate", {
      expression: "({ href: location.href, title: document.title, ready: document.readyState })",
      returnByValue: true,
    }, attached.sessionId);
    const page = info.result?.value ?? {};
    console.log(`loaded in ${Date.now() - navStarted}ms title=${JSON.stringify(page.title ?? "")} ready=${page.ready ?? ""}`);
    console.log(`host=${(() => { try { return new URL(String(page.href ?? PAGE)).hostname; } catch { return ""; } })()}`);
  } finally {
    cdp.close();
  }
} finally {
  if (sessionId) {
    const stopStarted = Date.now();
    const stopped = await api("PATCH", `/api/v4/browsers/${sessionId}`, { action: "stop" });
    const cost = await api("GET", `/api/v4/sessions/${sessionId}/cost`);
    const total = cost.json?.totalCostUsd ?? "unknown";
    const proxy = cost.json?.proxyUsedMb ?? "unknown";
    console.log(`stopped (${stopped.status}) in ${Date.now() - stopStarted}ms costUsd=${total} proxyMb=${proxy} totalMs=${Date.now() - started}`);
  }
}
