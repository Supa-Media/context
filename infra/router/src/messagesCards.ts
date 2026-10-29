/**
 * The pages the Context app's Messages extension shows for Tex's cards
 * (`apps/mobile/targets/context-messages`), served at `/messages/<kind>`.
 *
 * The extension is native code, which only an App Store build can change, so
 * it is a thin shell: it shows one of these pages and does what the page asks
 * through its one bridge (send a card back, put one in the text field, open a
 * note, resize), each request checked again on the phone. What a card offers
 * and how it looks is decided here, and ships with a deploy (the owner,
 * 2026-10-29: "the message extension can't get ota updates?").
 *
 * - `/messages/pick?p=&o=&o=&c=`: a pick card's options (apps/agent/src/pickCard.ts).
 * - `/messages/ask?k=&c=`: Yes or Not now under an ask (apps/agent/src/cardChats.ts).
 * - `/messages/hello`: a hello card, already sent.
 * - `/messages/drawer`: the extension opened from the drawer, with no card.
 *
 * Every page is a pure function of its address: no session, no storage, no
 * fetch. Nothing in the address is trusted; it is the card's own URL, which
 * anyone in the chat could have written. Names are escaped, counts clamped,
 * and the only addresses a page hands the bridge are `https://context.lc/tex/…`
 * cards it builds itself. The one script is a constant, allowed by its hash.
 */

export const MESSAGES_PREFIX = "/messages/";

const ORIGIN = "https://context.lc";
const MAX_OPTIONS = 8;
const MAX_NAME = 60;
const ASK_KEY = /^[a-z0-9]{1,8}$/;

/** What a button asks the extension to do; the extension checks it again. */
type CardRequest = { kind: "send" | "insert"; url: string; caption: string; subcaption?: string; summary: string };

/** The page's one script: buttons post their request, the extension answers with `contextCardDone`. */
export const BRIDGE_SCRIPT = `(function () {
  var handlers = window.webkit && window.webkit.messageHandlers;
  var bridge = handlers && handlers.context;
  var status = document.getElementById("status");
  function say(text) { if (status) status.textContent = text; }
  var buttons = document.querySelectorAll("button[data-card]");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function (event) {
      var button = event.currentTarget;
      if (!bridge) { say(button.getAttribute("data-fallback")); return; }
      for (var j = 0; j < buttons.length; j++) buttons[j].disabled = true;
      window.contextCardFallback = button.getAttribute("data-fallback");
      bridge.postMessage(JSON.parse(button.getAttribute("data-card")));
    });
  }
  window.contextCardDone = function (ok) {
    if (ok) return;
    for (var j = 0; j < buttons.length; j++) buttons[j].disabled = false;
    say(window.contextCardFallback || "That didn't send.");
  };
  var size = document.body.getAttribute("data-size");
  if (bridge && size) bridge.postMessage({ kind: "size", style: size });
})();`;

/** `BRIDGE_SCRIPT`'s sha256, which the page's policy allows (`messagesCards.test.ts` checks it). */
export const BRIDGE_SCRIPT_HASH = "sha256-QuW0ZHNrFNWVWbHCP50Ugg8tugL73qVyqnZ6JvZA0cU=";

const POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; " +
  `script-src '${BRIDGE_SCRIPT_HASH}'; ` +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function escaped(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

function numberIn(raw: string | null, max: number): number | undefined {
  const n = Number(raw);
  return raw !== null && Number.isInteger(n) && n >= 1 && n <= max ? n : undefined;
}

function button(label: string, request: CardRequest, fallback: string, primary: boolean, detail = ""): string {
  return (
    `<button type="button" class="${primary ? "primary" : ""}" data-card="${escaped(JSON.stringify(request))}" data-fallback="${escaped(fallback)}">` +
    `<span>${escaped(label)}</span>${detail ? `<span class="detail">${escaped(detail)}</span>` : ""}</button>`
  );
}

type Page = { title: string; body: string; size?: "expanded" | "compact" };

function pickPage(query: URLSearchParams): Page {
  const options = query.getAll("o").map(clean).filter(Boolean).slice(0, MAX_OPTIONS);
  if (options.length < 2) return noCard();
  const pick = numberIn(query.get("p"), options.length);
  const chosen = numberIn(query.get("c"), options.length);
  const base = `${ORIGIN}/tex/pick?${pick ? `p=${pick}&` : ""}${options.map((name) => `o=${encodeURIComponent(name)}`).join("&")}`;
  const buttons = options.map((name, index) => {
    const n = index + 1;
    const request: CardRequest = { kind: "send", url: `${base}&c=${n}`, caption: `Picked: ${name}`, subcaption: `Option ${n} of ${options.length}`, summary: `Picked ${name}` };
    const detail = [n === pick ? "Tex's pick" : "", n === chosen ? "Your pick" : ""].filter(Boolean).join(" · ");
    return button(`${n}. ${name}`, request, `That didn't send. Reply ${n} instead.`, n === (chosen ?? pick), detail);
  });
  const heading = chosen ? `You picked ${options[chosen - 1]}. Choose again?` : "Which one?";
  return { title: "Which one?", body: `<h1>${escaped(heading)}</h1>${buttons.join("")}`, size: "expanded" };
}

function askPage(query: URLSearchParams): Page {
  const key = query.get("k") ?? "";
  if (!ASK_KEY.test(key)) return noCard();
  const answered = query.get("c");
  const url = (c: number) => `${ORIGIN}/tex/ask?k=${key}&c=${c}`;
  const yes = button("Yes, go ahead", { kind: "send", url: url(1), caption: "Yes, go ahead", summary: "Yes" }, "That didn't send. Reply yes instead.", true);
  const no = button("Not now", { kind: "send", url: url(2), caption: "Not now", summary: "Not now" }, "That didn't send. Reply no instead.", false);
  const heading = answered === "1" ? "You said yes." : answered === "2" ? "You said not now." : "Go ahead with what Tex asked?";
  return { title: "Go ahead?", body: `<h1>${escaped(heading)}</h1>${answered === "1" || answered === "2" ? "" : yes + no}`, size: "compact" };
}

function drawerPage(): Page {
  const hello: CardRequest = { kind: "insert", url: `${ORIGIN}/tex/hello`, caption: "Context cards on", subcaption: "Tex can send cards to tap", summary: "Turned on Context cards" };
  return {
    title: "Context",
    body:
      "<h1>Context</h1><p>In your chat with Tex, cards let you answer with a tap: choose one of Tex's options, say yes to an email, or open a note.</p>" +
      button("Turn on cards with Tex", hello, "Open this from your chat with Tex in Messages.", true) +
      "<p class=\"small\">It goes in the text field. Send it to Tex to turn cards on.</p>",
  };
}

function helloPage(): Page {
  return { title: "Context cards on", body: "<h1>Cards are on</h1><p>Tex knows this phone has Context, so it sends cards you can tap.</p>" };
}

function noCard(): Page {
  return { title: "Context", body: "<h1>This card can't be answered here</h1><p>Reply to Tex in the chat instead.</p>" };
}

const STYLE = `:root{color-scheme:light dark;--fg:#000;--muted:#6e6e73;--line:#d1d1d6;--bg:#fff;--accent:#007aff;--accent-fg:#fff;--soft:#f0f6ff}
@media (prefers-color-scheme:dark){:root{--fg:#fff;--muted:#a1a1a6;--line:#3a3a3c;--bg:#1c1c1e;--accent:#0a84ff;--soft:#0a2540}}
body{margin:0;padding:16px 20px;background:var(--bg);color:var(--fg);font:16px/1.35 -apple-system,system-ui,sans-serif;display:flex;flex-direction:column;gap:10px}
h1{margin:0 0 4px;font-size:17px;font-weight:600}p{margin:0;color:var(--muted);font-size:15px}.small{font-size:12px}
button{display:flex;justify-content:space-between;align-items:center;gap:8px;min-height:50px;padding:0 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--fg);font:inherit;text-align:left}
button.primary{border:2px solid var(--accent);background:var(--soft)}button:disabled{opacity:.5}
.detail{font-size:13px;color:var(--muted)}#status{color:#c4314b;font-size:14px}`;

function render(page: Page): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${escaped(page.title)}</title><style>${STYLE}</style></head>` +
    `<body${page.size ? ` data-size="${page.size}"` : ""}>${page.body}<p id="status" role="status"></p>` +
    `<script>${BRIDGE_SCRIPT}</script></body></html>`
  );
}

/** The page for a `/messages/…` address, or null for any other path. */
export function messagesCardResponse(request: Request, url: URL): Response | null {
  if (!url.pathname.startsWith(MESSAGES_PREFIX)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  const kind = url.pathname.slice(MESSAGES_PREFIX.length);
  const page = kind === "pick" ? pickPage(url.searchParams) : kind === "ask" ? askPage(url.searchParams) : kind === "drawer" ? drawerPage() : kind === "hello" ? helloPage() : null;
  if (page === null) return new Response("Not found", { status: 404 });
  return new Response(request.method === "HEAD" ? null : render(page), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // A function of the address alone: safe to keep a few minutes, short enough that a change ships quickly.
      "Cache-Control": "public, max-age=300",
      "Content-Security-Policy": POLICY,
      "Content-Security-Policy-Report-Only": POLICY,
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
}
