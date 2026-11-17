#!/usr/bin/env node
/**
 * Load one page on Browser Use and stop the session.
 *
 * Load only: nothing is typed and nothing is submitted. Refuses when the
 * balance is under $0.50 or the balance call fails. A Chrome error page
 * (chromewebdata, chrome-error) is a failed load and exits non-zero.
 *
 * With no proxy argument this is the Worker path: the create body omits
 * proxyCountryCode (the harness default, which is the US residential proxy),
 * and a SOCKS, proxy, or tunnel error is retried once with the proxy turned
 * off (`PATCH /api/v4/browsers/{id}/proxy` `{"mode":"direct"}`).
 *
 *   BROWSER_USE_API_KEY=… node scripts/browser-use-lab.mjs
 *   BROWSER_USE_API_KEY=… node scripts/browser-use-lab.mjs https://wwws.airfrance.us/check-in
 *   BROWSER_USE_API_KEY=… node scripts/browser-use-lab.mjs --proxy direct
 *   BROWSER_USE_API_KEY=… node scripts/browser-use-lab.mjs https://example.com/ --proxy us
 *   BROWSER_USE_API_KEY=… node scripts/browser-use-lab.mjs --proxy null
 *   BROWSER_USE_API_KEY=… node scripts/browser-use-lab.mjs --proxy omit
 *   BROWSER_USE_API_KEY=… node scripts/browser-use-lab.mjs --proxy rotate
 *
 * `--proxy` runs that one setting and does not retry. `omit` sends no
 * proxyCountryCode. `null` sends null (create-time disable; a lab run showed
 * this can leave the SOCKS proxy on). `direct` patches mode direct before
 * navigating. `rotate` asks for a new residential IP. `us` sends "us".
 */

const DEFAULT_PAGE = "https://wwws.airfrance.us/check-in";
const KEY = process.env.BROWSER_USE_API_KEY ?? "";
const ORIGIN = "https://api.browser-use.com";
const PROXY_CHOICES = new Set(["omit", "us", "null", "direct", "rotate"]);

const args = process.argv.slice(2);
let page = DEFAULT_PAGE;
let proxyOverride = "";
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--proxy") {
    proxyOverride = args[++i] ?? "";
  } else if (arg.startsWith("--proxy=")) {
    proxyOverride = arg.slice("--proxy=".length);
  } else if (/^https?:\/\//.test(arg)) {
    page = arg;
  } else if (PROXY_CHOICES.has(arg)) {
    proxyOverride = arg;
  } else {
    console.error(`unknown argument ${arg}`);
    process.exit(2);
  }
}
if (proxyOverride !== "" && !PROXY_CHOICES.has(proxyOverride)) {
  console.error("proxy must be omit, us, null, direct, or rotate");
  process.exit(2);
}

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

function proxyConnect(failure) {
  return typeof failure === "string" && /net::ERR_(?:SOCKS|PROXY|TUNNEL)_/.test(failure);
}

/**
 * Same rule as `navigationFailure` in `infra/site-shots/src/pageLoad.ts`.
 * `net::ERR_ABORTED` is the redirect Chrome cancelled. A real host whose
 * document status is 2xx or 3xx has landed.
 */
function navigationFailure(href, netError, status) {
  const text = typeof netError === "string" ? netError : "";
  const net = /net::ERR_[A-Z0-9_]{1,60}/.exec(text)?.[0] ?? "";
  const code = typeof status === "number" && Number.isInteger(status) ? status : NaN;
  let landed = code >= 200 && code < 400 && typeof href === "string" && !/^(about|chrome-error|chrome|blob|data):/.test(href);
  if (landed) {
    try {
      const url = new URL(href);
      landed = (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0 && url.hostname !== "chromewebdata";
    } catch {
      landed = false;
    }
  }
  if (net === "net::ERR_ABORTED" && landed) return null;
  const page = loadFailure(href, text);
  if (page) return page;
  if (net) return net;
  return null;
}

function createBody(override) {
  const body = { timeout: 15 };
  if (override === "us") body.proxyCountryCode = "us";
  if (override === "null" || override === "direct") body.proxyCountryCode = null;
  return body;
}

async function readProxy(id) {
  const got = await api("GET", `/api/v4/browsers/${id}/proxy`);
  const mode = typeof got.json?.mode === "string" ? got.json.mode : "unknown";
  const country = got.json && "country" in got.json ? got.json.country : "none";
  console.log(`proxyMode=${mode} country=${country === null ? "null" : country} (${got.status})`);
  return mode;
}

async function navigate(cdp, session, url) {
  let netErrorText = "";
  let documentStatus = 0;
  let mainFrame = "";
  const tree = await cdp.send("Page.getFrameTree", {}, session).catch(() => null);
  if (typeof tree?.frameTree?.frame?.id === "string") mainFrame = tree.frameTree.frame.id;
  cdp.on("Network.loadingFailed", (params) => {
    if (typeof params?.errorText === "string") netErrorText = params.errorText;
  });
  cdp.on("Network.responseReceived", (params) => {
    if (params?.type !== "Document" || typeof params.response?.status !== "number") return;
    if (mainFrame && params.frameId !== mainFrame) return;
    documentStatus = params.response.status;
  });
  const loaded = new Promise((resolve) => {
    const timer = setTimeout(resolve, 20_000);
    cdp.on("Page.loadEventFired", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const started = Date.now();
  const navigated = await cdp.send("Page.navigate", { url }, session);
  const navigateError = typeof navigated?.errorText === "string" ? navigated.errorText : "";
  await loaded;
  let href = "";
  let title = "";
  let ready = "";
  let pageStatus = 0;
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const info = await cdp.send("Runtime.evaluate", {
      expression: "({ href: location.href, title: document.title, ready: document.readyState, status: (performance.getEntriesByType('navigation').at(-1) || {}).responseStatus || 0 })",
      returnByValue: true,
    }, session);
    const seen = info.result?.value ?? {};
    href = typeof seen.href === "string" ? seen.href : "";
    title = typeof seen.title === "string" ? seen.title : "";
    ready = typeof seen.ready === "string" ? seen.ready : "";
    pageStatus = typeof seen.status === "number" ? seen.status : 0;
    if (ready === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const status = pageStatus >= 200 ? pageStatus : documentStatus;
  const failure = navigationFailure(href, navigateError || netErrorText, status);
  let host = "";
  try {
    host = new URL(href || url).hostname;
  } catch {
    host = "";
  }
  console.log(`status=${status || "none"} netErrorText=${JSON.stringify(netErrorText || navigateError || "")}`);
  console.log(`title=${JSON.stringify(title)} ready=${ready} host=${host} ms=${Date.now() - started}`);
  if (failure) console.error(`load failed: ${failure}`);
  return failure;
}

const started = Date.now();
let sessionId = null;
let balanceBefore = null;
let loadFailed = null;
console.log(`page=${page} proxy=${proxyOverride || "worker"}`);
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
  const body = createBody(proxyOverride);
  const created = await api("POST", "/api/v4/browsers", body);
  const createMs = Date.now() - createStarted;
  sessionId = created.json?.id ?? null;
  const cdpUrl = created.json?.cdpUrl;
  if ((created.status !== 201 && created.status !== 200) || typeof sessionId !== "string" || typeof cdpUrl !== "string") {
    console.error(`create failed (${created.status}) after ${createMs}ms body=${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(`session started in ${createMs}ms body=${JSON.stringify(body)}`);
  await readProxy(sessionId);
  if (proxyOverride === "direct") {
    const patched = await api("PATCH", `/api/v4/browsers/${sessionId}/proxy`, { mode: "direct" });
    console.log(`direct patch=${patched.status}`);
    await readProxy(sessionId);
  } else if (proxyOverride === "rotate") {
    const patched = await api("PATCH", `/api/v4/browsers/${sessionId}/proxy`, { rotate: true });
    console.log(`rotate patch=${patched.status}`);
    await readProxy(sessionId);
  }

  const cdp = await connect(cdpUrl);
  try {
    const targets = await cdp.send("Target.getTargets");
    let targetId = targets.targetInfos?.find((target) => target.type === "page")?.targetId;
    if (!targetId) targetId = (await cdp.send("Target.createTarget", { url: "about:blank" })).targetId;
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const session = attached.sessionId;
    await cdp.send("Page.enable", {}, session);
    await cdp.send("Network.enable", {}, session).catch(() => undefined);
    loadFailed = await navigate(cdp, session, page);
    if (!proxyOverride && proxyConnect(loadFailed)) {
      const patched = await api("PATCH", `/api/v4/browsers/${sessionId}/proxy`, { mode: "direct" });
      console.log(`retry patch=${patched.status}`);
      await readProxy(sessionId);
      if (patched.status >= 200 && patched.status < 300) loadFailed = await navigate(cdp, session, page);
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
