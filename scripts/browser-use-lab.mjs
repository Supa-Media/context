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
  const listeners = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (typeof message.id !== "number") {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params);
      return;
    }
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
          ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
        },
        on(method, listener) {
          listeners.set(method, [...(listeners.get(method) ?? []), listener]);
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("error", () => reject(new Error("cdp connect failed")));
  });
}

/** Chrome's network-error page is not a loaded site. A real host, even one that answered 403, is. */
function loadFailure(href, netError) {
  const url = typeof href === "string" ? href : "";
  const net = /net::ERR_[A-Z0-9_]{1,60}/.exec(netError ?? "")?.[0] ?? "";
  if (url.startsWith("chrome-error:") || url.startsWith("chrome://")) return net || "chrome error page";
  try {
    if (new URL(url).hostname === "chromewebdata") return net || "chrome error page";
  } catch {
    // Not a URL.
  }
  return null;
}

const started = Date.now();
let sessionId = null;
let balanceBefore = null;
let loadFailed = null;
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
  balanceBefore = usd;
  console.log(`balance $${usd} in ${balanceMs}ms`);

  const createStarted = Date.now();
  // proxyCountryCode "us" is the documented default (lowercase), not a
  // special value. A navigation that lands on chromewebdata is a failed
  // load, reported below, not a reason to change this body.
  const created = await api("POST", "/api/v4/browsers", { timeout: 15, proxyCountryCode: "us" });
  const createMs = Date.now() - createStarted;
  sessionId = created.json?.id ?? null;
  const cdpUrl = created.json?.cdpUrl;
  if ((created.status !== 201 && created.status !== 200) || typeof sessionId !== "string" || typeof cdpUrl !== "string") {
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
    const session = attached.sessionId;
    let netErrorText = "";
    let statusCode = "";
    cdp.on("Network.loadingFailed", (params) => {
      if (typeof params?.errorText === "string") netErrorText = params.errorText;
    });
    cdp.on("Network.responseReceived", (params) => {
      if (params?.type === "Document" && typeof params.response?.status === "number") statusCode = String(params.response.status);
    });
    const loaded = new Promise((resolve) => {
      const timer = setTimeout(resolve, 20_000);
      cdp.on("Page.loadEventFired", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await cdp.send("Page.enable", {}, session);
    await cdp.send("Network.enable", {}, session).catch(() => undefined);
    const navigated = await cdp.send("Page.navigate", { url: PAGE }, session);
    const navigateError = typeof navigated?.errorText === "string" ? navigated.errorText : "";
    await loaded;
    let href = "";
    let title = "";
    let ready = "";
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      const info = await cdp.send("Runtime.evaluate", {
        expression: "({ href: location.href, title: document.title, ready: document.readyState })",
        returnByValue: true,
      }, session);
      const page = info.result?.value ?? {};
      href = typeof page.href === "string" ? page.href : "";
      title = typeof page.title === "string" ? page.title : "";
      ready = typeof page.ready === "string" ? page.ready : "";
      if (ready === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const failure = navigateError || loadFailure(href, netErrorText);
    let host = "";
    try {
      host = new URL(href || PAGE).hostname;
    } catch {
      host = "";
    }
    console.log(`status=${statusCode || "none"} netErrorText=${JSON.stringify(netErrorText || navigateError || "")}`);
    console.log(`title=${JSON.stringify(title)} ready=${ready} host=${host} ms=${Date.now() - navStarted}`);
    if (failure) {
      loadFailed = failure;
      console.error(`load failed: ${failure}`);
    }
  } finally {
    cdp.close();
  }
} finally {
  if (sessionId) {
    const stopStarted = Date.now();
    const stopped = await api("PATCH", `/api/v4/browsers/${sessionId}`, { action: "stop" });
    const browser = await api("GET", `/api/v4/browsers/${sessionId}`);
    const after = await api("GET", "/api/v2/billing/account");
    const browserCost = browser.json?.browserCost ?? "none";
    const proxyCost = browser.json?.proxyCost ?? "none";
    const proxyMb = browser.json?.proxyUsedMb ?? "none";
    const afterUsd = Number(after.json?.totalCreditsBalanceUsd);
    const delta = balanceBefore !== null && Number.isFinite(afterUsd) ? Math.round((balanceBefore - afterUsd) * 1_000_000) / 1_000_000 : "unknown";
    console.log(`stopped (${stopped.status}) in ${Date.now() - stopStarted}ms browserCost=${browserCost} proxyCost=${proxyCost} proxyMb=${proxyMb} balanceDeltaUsd=${delta} totalMs=${Date.now() - started}`);
  }
}
if (loadFailed) process.exit(1);

