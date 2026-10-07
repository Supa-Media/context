/**
 * The texts simulator's one page: a made-up iPhone running Messages, served by
 * the staging assistant at /texts-simulator. It is self-contained (no network
 * but its own API, see simulator.ts) so the page's Content-Security-Policy can
 * refuse everything else. Outside /texts-simulator, for a design preview, the
 * same page plays a scripted demo instead of calling the API.
 */
export const SIMULATOR_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Texts Simulator</title>
<style>
/* Layout: a control column beside one life-size iPhone running Messages; on a phone, the iPhone is the page. */
:root {
  --ground: #eef0f4;
  --panel: #ffffff;
  --ink: #15171c;
  --muted: #646b78;
  --line: #dcdfe6;
  --accent: #2563eb;
  --bezel: #1b1c1f;
  --screen: #ffffff;
  --bar: rgba(246, 246, 248, 0.92);
  --bubble-in: #e9e9eb;
  --bubble-in-ink: #0b0b0c;
  --bubble-out: #0a84ff;
  --bubble-out-ink: #ffffff;
  --card-top: #f4f2ec;
  --card-bottom: #e3e3e6;
  --field: #ffffff;
  --field-line: #c9cbd1;
  --stamp: #8a8d93;
  --warn: #b45309;
  --font-ios: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
  --font-ui: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #0e1014; --panel: #171a20; --ink: #eceef3; --muted: #9aa1ae; --line: #2a2e37;
    --accent: #6ea0ff; --bezel: #050506; --screen: #000000; --bar: rgba(22, 22, 24, 0.92);
    --bubble-in: #262628; --bubble-in-ink: #ffffff; --bubble-out: #0a84ff; --bubble-out-ink: #ffffff;
    --card-top: #2b2a27; --card-bottom: #3a3a3c; --field: #000000; --field-line: #3a3a3c;
    --stamp: #8d8d93; --warn: #f59e0b; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --ground: #0e1014; --panel: #171a20; --ink: #eceef3; --muted: #9aa1ae; --line: #2a2e37;
  --accent: #6ea0ff; --bezel: #050506; --screen: #000000; --bar: rgba(22, 22, 24, 0.92);
  --bubble-in: #262628; --bubble-in-ink: #ffffff; --bubble-out: #0a84ff; --bubble-out-ink: #ffffff;
  --card-top: #2b2a27; --card-bottom: #3a3a3c; --field: #000000; --field-line: #3a3a3c;
  --stamp: #8d8d93; --warn: #f59e0b; color-scheme: dark;
}
html, body { height: 100%; }
body { background: var(--ground); color: var(--ink); font-family: var(--font-ui); margin: 0; }
.stage { min-height: 100%; box-sizing: border-box; display: flex; gap: 40px; align-items: center; justify-content: center; align-content: center; padding-block: 24px; padding-inline: 16px; flex-wrap: wrap; }

/* ── control column ─────────────────────────────── */
.controls { width: 320px; max-width: 100%; display: grid; gap: 20px; align-content: start; }
.controls h1 { font-size: 22px; line-height: 1.2; margin: 0; letter-spacing: -0.01em; text-wrap: balance; }
.tag { display: inline-block; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--warn); border: 1px solid currentColor; border-radius: 4px; padding: 1px 6px; margin-left: 8px; vertical-align: 3px; }
.lede { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
.group { display: grid; gap: 8px; }
.label { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.number { font-family: var(--font-mono); font-size: 17px; font-variant-numeric: tabular-nums; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
button.ctl { font: inherit; font-size: 13px; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 7px 12px; cursor: pointer; }
button.ctl:hover { border-color: var(--muted); }
button.chip { font: inherit; font-size: 13px; color: var(--accent); background: transparent; border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; cursor: pointer; }
button.chip:hover { border-color: var(--accent); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.note { font-size: 13px; line-height: 1.5; color: var(--muted); margin: 0; }
.status { font-size: 13px; color: var(--muted); min-height: 1.5em; }
.status.error { color: var(--warn); }

/* ── the iPhone ─────────────────────────────────── */
.phone { width: 390px; max-width: 100%; height: min(844px, calc(100vh - 48px)); min-height: 560px; background: var(--bezel); border-radius: 56px; padding: 12px; box-sizing: border-box; box-shadow: 0 30px 60px -20px rgba(15, 20, 35, 0.35); flex: none; }
.screen { position: relative; height: 100%; background: var(--screen); border-radius: 44px; overflow: hidden; display: flex; flex-direction: column; font-family: var(--font-ios); color: var(--bubble-in-ink); }
.island { position: absolute; top: 11px; left: 50%; transform: translateX(-50%); width: 120px; height: 34px; background: #000; border-radius: 20px; z-index: 3; }
.statusbar { height: 50px; flex: none; display: flex; align-items: flex-end; justify-content: space-between; padding: 0 30px 6px 40px; font-size: 16px; font-weight: 600; background: var(--bar); color: var(--ink); }
.statusbar .icons { display: flex; gap: 6px; align-items: center; }
.statusbar svg { display: block; fill: currentColor; }
.navbar { flex: none; background: var(--bar); border-bottom: 0.5px solid var(--field-line); display: grid; grid-template-columns: 60px 1fr 60px; align-items: start; padding: 4px 8px 8px; color: var(--ink); }
.back { color: var(--bubble-out); font-size: 17px; display: flex; align-items: center; gap: 2px; padding-top: 14px; }
.back svg { stroke: currentColor; }
.who { display: grid; justify-items: center; gap: 4px; }
.avatar { width: 52px; height: 52px; border-radius: 50%; background: #1f6bff; display: grid; place-items: center; color: #fff; font-family: var(--font-mono); font-size: 26px; font-weight: 700; }
.name { font-size: 12px; display: flex; align-items: center; gap: 2px; }
.name svg { stroke: var(--stamp); }
.thread > * { flex: none; }
.thread { flex: 1; overflow-y: auto; padding: 12px 14px 10px; display: flex; flex-direction: column; gap: 2px; scroll-behavior: smooth; }
.stamp { text-align: center; font-size: 11px; color: var(--stamp); margin: 10px 0 8px; }
.stamp b { font-weight: 600; }
.msg { max-width: 76%; font-size: 17px; line-height: 1.29; padding: 7px 13px 8px; border-radius: 19px; position: relative; overflow-wrap: anywhere; white-space: pre-wrap; }
.msg.in { align-self: flex-start; background: var(--bubble-in); color: var(--bubble-in-ink); }
.msg.out { align-self: flex-end; background: var(--bubble-out); color: var(--bubble-out-ink); }
.msg.in.tail { border-bottom-left-radius: 6px; }
.msg.out.tail { border-bottom-right-radius: 6px; }
.gap { height: 8px; flex: none; }
.msg a { color: inherit; }
.card { align-self: flex-start; width: 250px; max-width: 76%; border-radius: 19px; overflow: hidden; text-decoration: none; color: var(--bubble-in-ink); display: block; }
.card .hero { background: var(--card-top); aspect-ratio: 1.91 / 1; display: grid; place-items: center; }
.card .hero span { font-family: Georgia, "Times New Roman", serif; font-size: 34px; font-weight: 700; color: var(--bubble-in-ink); letter-spacing: -0.02em; }
.card .hero i { color: #1f6bff; font-style: normal; }
.card .meta { background: var(--card-bottom); padding: 8px 12px 10px; display: grid; gap: 1px; }
.card .meta b { font-size: 14px; font-weight: 600; }
.card .meta small { font-size: 13px; color: var(--stamp); }
.receipt { align-self: flex-end; font-size: 11px; color: var(--stamp); margin: 2px 4px 0 0; }
.typing { align-self: flex-start; background: var(--bubble-in); border-radius: 19px; border-bottom-left-radius: 6px; padding: 12px 14px; display: flex; gap: 5px; margin-top: 8px; }
.typing span { width: 8px; height: 8px; border-radius: 50%; background: var(--stamp); animation: blink 1.2s infinite; }
.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink { 0%, 60%, 100% { opacity: 0.35; } 30% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .typing span { animation: none; opacity: 0.7; } .thread { scroll-behavior: auto; } }
.compose { flex: none; display: flex; align-items: flex-end; gap: 8px; padding: 8px 10px 28px; background: var(--screen); }
.plus { width: 34px; height: 34px; border-radius: 50%; background: var(--bubble-in); display: grid; place-items: center; flex: none; color: var(--stamp); }
.field { flex: 1; min-width: 0; display: flex; align-items: center; border: 1px solid var(--field-line); border-radius: 18px; background: var(--field); padding: 3px 3px 3px 12px; }
.field input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: inherit; font-size: 17px; color: var(--bubble-in-ink); padding: 4px 0; }
.field input::placeholder { color: var(--stamp); }
.send { width: 28px; height: 28px; border-radius: 50%; border: 0; background: var(--bubble-out); display: grid; place-items: center; cursor: pointer; flex: none; padding: 0; }
.send:disabled { opacity: 0; pointer-events: none; }
.send svg { stroke: #fff; }

@media (max-width: 760px) {
  .stage { gap: 16px; padding-block: 12px; align-content: start; }
  .controls { width: 390px; gap: 12px; }
  .controls .lede, .controls .note { display: none; }
  .phone { height: calc(100vh - 220px); }
}
</style>
</head>
<body>
<main class="stage">
  <section class="controls" aria-label="Simulator controls">
    <h1>Texts simulator<span class="tag">Staging</span></h1>
    <p class="lede">Text the staging assistant from a made-up phone number. It runs the same code as a real iMessage, but nothing goes through Linq and no real number is used.</p>
    <div class="group">
      <span class="label">This phone</span>
      <span class="number" id="number">+1 (415) 555-0142</span>
      <div class="row">
        <button class="ctl" id="new-number" type="button">New number</button>
        <button class="ctl" id="clear" type="button">Clear chat</button>
      </div>
    </div>
    <div class="group">
      <span class="label">Try</span>
      <div class="row">
        <button class="chip" type="button" data-say="hi">hi</button>
        <button class="chip" type="button" data-say="What's on my list today?">What's on my list today?</button>
        <button class="chip" type="button" data-say="UNLINK">UNLINK</button>
      </div>
    </div>
    <p class="note">The first text from a new number gets a sign-in link. Open it while signed in to staging, then text back the code it shows. After that, this number answers from that account.</p>
    <div class="status" id="status" role="status"></div>
  </section>

  <div class="phone" aria-label="Simulated iPhone">
    <div class="screen">
      <div class="island"></div>
      <div class="statusbar">
        <span id="clock">9:41</span>
        <span class="icons" aria-hidden="true">
          <svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
          <svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 2.2c2.3 0 4.4.9 6 2.4l1.2-1.3A10.4 10.4 0 0 0 8 .4C5.2.4 2.7 1.5.8 3.3L2 4.6a8.6 8.6 0 0 1 6-2.4Zm0 3.6c1.3 0 2.5.5 3.4 1.3l1.2-1.3A6.7 6.7 0 0 0 8 4c-1.8 0-3.4.7-4.6 1.8l1.2 1.3c.9-.8 2.1-1.3 3.4-1.3Zm0 3.5-2 2.1L8 12l2-2.6-2-.1Z"/></svg>
          <svg width="27" height="13" viewBox="0 0 27 13"><rect x="0.5" y="0.5" width="22" height="12" rx="3.5" fill="none" stroke="currentColor" opacity="0.4"/><rect x="2" y="2" width="19" height="9" rx="2"/><rect x="24" y="4.5" width="2" height="4" rx="1" opacity="0.4"/></svg>
        </span>
      </div>
      <div class="navbar">
        <span class="back" aria-hidden="true"><svg width="12" height="20" viewBox="0 0 12 20" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2 2 10l8 8"/></svg></span>
        <div class="who">
          <div class="avatar" aria-hidden="true">#</div>
          <span class="name">Context <svg width="6" height="10" viewBox="0 0 6 10" fill="none" stroke-width="1.6" stroke-linecap="round"><path d="m1 1 4 4-4 4"/></svg></span>
        </div>
        <span></span>
      </div>
      <div class="thread" id="thread" aria-live="polite"></div>
      <form class="compose" id="compose">
        <span class="plus" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 1v12M1 7h12"/></svg></span>
        <label class="field">
          <input id="text" type="text" autocomplete="off" placeholder="iMessage" aria-label="Message" maxlength="2000">
          <button class="send" id="send" type="submit" aria-label="Send" disabled><svg width="14" height="16" viewBox="0 0 14 16" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14V2M2 7l5-5 5 5"/></svg></button>
        </label>
      </form>
    </div>
  </div>
</main>

<script>
(function () {
  "use strict";
  var API = "/texts-simulator/api";
  // Served by the staging assistant, the page talks to it. Anywhere else (a
  // design preview) it plays a scripted demo so the screen can be reviewed.
  var LIVE = location.pathname.indexOf("/texts-simulator") === 0;

  var thread = document.getElementById("thread");
  var input = document.getElementById("text");
  var sendButton = document.getElementById("send");
  var statusLine = document.getElementById("status");
  var numberLine = document.getElementById("number");

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } }
  };

  function randomHex(bytes) {
    var a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  // 555-0100 to 555-0199 is set aside for fiction in every North American
  // area code, so these numbers can never belong to a real phone.
  function newPhone() {
    var areas = ["415", "212", "312", "646", "206", "512", "617", "303"];
    var a = new Uint8Array(2);
    crypto.getRandomValues(a);
    return "+1" + areas[a[0] % areas.length] + "55501" + String(a[1] % 100).padStart(2, "0");
  }
  function pretty(phone) {
    return "+1 (" + phone.slice(2, 5) + ") " + phone.slice(5, 8) + "-" + phone.slice(8);
  }

  var phone = store.get("sim.phone");
  var key = store.get("sim.key");
  if (!phone || !key) { phone = newPhone(); key = randomHex(24); store.set("sim.phone", phone); store.set("sim.key", key); }
  numberLine.textContent = pretty(phone);

  var messages = [];
  var typing = false;

  function say(text, isError) {
    statusLine.textContent = text || "";
    statusLine.className = isError ? "status error" : "status";
  }

  function timeLabel(at) {
    var d = new Date(at);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  var LINK_ONLY = /^https:\/\/\S+$/;

  function render() {
    var nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    thread.textContent = "";
    var lastAt = 0;
    var lastOut = -1;
    messages.forEach(function (m, i) { if (m.dir === "out") lastOut = i; });
    messages.forEach(function (m, i) {
      if (m.at - lastAt > 15 * 60 * 1000) {
        var s = document.createElement("div");
        s.className = "stamp";
        var b = document.createElement("b");
        b.textContent = "Today";
        s.appendChild(b);
        s.appendChild(document.createTextNode(" " + timeLabel(m.at)));
        thread.appendChild(s);
      } else if (i > 0 && messages[i - 1].dir !== m.dir) {
        var g = document.createElement("div");
        g.className = "gap";
        thread.appendChild(g);
      }
      lastAt = m.at;
      var next = messages[i + 1];
      var tail = !next || next.dir !== m.dir;
      var text = m.text.trim();
      if (m.dir === "in" && LINK_ONLY.test(text)) {
        var card = document.createElement("a");
        card.className = "card";
        card.href = text;
        card.target = "_blank";
        card.rel = "noopener";
        var hero = document.createElement("div");
        hero.className = "hero";
        var word = document.createElement("span");
        word.textContent = "Context";
        var dot = document.createElement("i");
        dot.textContent = ".";
        word.appendChild(dot);
        hero.appendChild(word);
        var meta = document.createElement("div");
        meta.className = "meta";
        var title = document.createElement("b");
        title.textContent = "Connect your phone";
        var host = document.createElement("small");
        try { host.textContent = new URL(text).host; } catch (e) { host.textContent = text; }
        meta.appendChild(title);
        meta.appendChild(host);
        card.appendChild(hero);
        card.appendChild(meta);
        thread.appendChild(card);
      } else {
        var bubble = document.createElement("div");
        bubble.className = "msg " + m.dir + (tail ? " tail" : "");
        bubble.textContent = text;
        thread.appendChild(bubble);
      }
      if (i === lastOut && !messages.slice(i + 1).some(function (n) { return n.dir === "in"; })) {
        var r = document.createElement("div");
        r.className = "receipt";
        r.textContent = "Delivered";
        thread.appendChild(r);
      }
    });
    if (typing) {
      var t = document.createElement("div");
      t.className = "typing";
      t.setAttribute("aria-label", "Context is typing");
      t.innerHTML = "<span></span><span></span><span></span>";
      thread.appendChild(t);
    }
    if (nearBottom || typing) thread.scrollTop = thread.scrollHeight;
  }

  function call(path, method, body) {
    return fetch(API + path, {
      method: method,
      headers: { "content-type": "application/json", "x-simulator-key": key },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (res.status === 409) throw new Error("taken");
      if (!res.ok) throw new Error("status " + res.status);
      return res.json();
    });
  }

  var polling = null;
  function refresh() {
    return call("/thread?phone=" + encodeURIComponent(phone), "GET").then(function (data) {
      messages = data.messages;
      typing = data.typing;
      render();
      say("");
    }).catch(function (e) {
      if (e.message === "taken") { switchNumber(); return; }
      say("Can't reach the assistant. Retrying.", true);
    });
  }
  function schedule() {
    clearTimeout(polling);
    polling = setTimeout(function () { refresh().then(schedule, schedule); }, typing ? 900 : 2500);
  }

  function switchNumber() {
    phone = newPhone();
    key = randomHex(24);
    store.set("sim.phone", phone);
    store.set("sim.key", key);
    numberLine.textContent = pretty(phone);
    messages = [];
    typing = false;
    render();
    say("New number. Its first text gets a fresh sign-in link.");
  }

  // ── scripted demo, for design review outside staging ──────────────────
  var demoLinked = false;
  function demoReply(text) {
    var t = text.trim();
    if (/^unlink[.!]?$/i.test(t)) {
      var was = demoLinked;
      demoLinked = false;
      return [was ? "Done. This phone is no longer connected to your Context. Text me anytime to connect again." : "This phone isn't connected to any account."];
    }
    if (/^link\s+[a-z0-9]{6,10}[.!]?$/i.test(t)) {
      demoLinked = true;
      return ["You're connected to @seyi's Context. Text me anything and I'll answer from your notes. If that isn't your account, text UNLINK."];
    }
    if (!demoLinked) {
      return ["Hi, I'm your Context. Tap the link below to connect your account, then text me the code it shows you.", "https://staging.context.lc/texts/65a0a84b-fa0bc610b0924837"];
    }
    return ["Three things today:\n1. Review the texting assistant PR\n2. Publish the week 6 devlog\n3. Call Priya about the pricing page"];
  }
  function demoSend(text) {
    messages.push({ dir: "out", text: text, at: Date.now() });
    typing = true;
    render();
    var replies = demoReply(text);
    setTimeout(function () {
      typing = false;
      replies.forEach(function (r) { messages.push({ dir: "in", text: r, at: Date.now() }); });
      render();
    }, 1400);
  }

  function send(text) {
    text = text.trim();
    if (!text) return;
    input.value = "";
    sendButton.disabled = true;
    if (!LIVE) { demoSend(text); return; }
    messages.push({ dir: "out", text: text, at: Date.now() });
    typing = true;
    render();
    call("/send", "POST", { phone: phone, text: text }).then(function () {
      return refresh();
    }).then(schedule, function (e) {
      if (e.message === "taken") { switchNumber(); say("That number was in use in another browser, so you have a new one. Send again.", true); return; }
      say("That text didn't send. Try again.", true);
    });
  }

  document.getElementById("compose").addEventListener("submit", function (e) {
    e.preventDefault();
    send(input.value);
  });
  input.addEventListener("input", function () { sendButton.disabled = input.value.trim() === ""; });
  Array.prototype.forEach.call(document.querySelectorAll("[data-say]"), function (b) {
    b.addEventListener("click", function () { send(b.getAttribute("data-say")); });
  });
  document.getElementById("new-number").addEventListener("click", switchNumber);
  document.getElementById("clear").addEventListener("click", function () {
    if (!LIVE) { messages = []; render(); return; }
    call("/clear", "POST", { phone: phone }).then(function () { messages = []; render(); say("Chat cleared. The number stays connected; text UNLINK to disconnect it."); },
      function () { say("Couldn't clear the chat. Try again.", true); });
  });

  function tick() {
    var d = new Date();
    document.getElementById("clock").textContent = (d.getHours() % 12 || 12) + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  tick();
  setInterval(tick, 30000);

  if (LIVE) { refresh().then(schedule, schedule); }
  else {
    var t0 = Date.now() - 4 * 60 * 1000;
    messages = [
      { dir: "out", text: "hi", at: t0 },
      { dir: "in", text: "Hi, I'm your Context. Tap the link below to connect your account, then text me the code it shows you.", at: t0 + 2000 },
      { dir: "in", text: "https://staging.context.lc/texts/65a0a84b-fa0bc610b0924837", at: t0 + 2600 },
      { dir: "out", text: "link K7QM4PZX", at: t0 + 90000 },
      { dir: "in", text: "You're connected to @seyi's Context. Text me anything and I'll answer from your notes. If that isn't your account, text UNLINK.", at: t0 + 92000 },
      { dir: "out", text: "What's on my list today?", at: t0 + 120000 }
    ];
    demoLinked = true;
    typing = true;
    render();
    setTimeout(function () {
      typing = false;
      messages.push({ dir: "in", text: "Three things today:\n1. Review the texting assistant PR\n2. Publish the week 6 devlog\n3. Call Priya about the pricing page", at: Date.now() });
      render();
    }, 2200);
  }
})();
</script>
</body>
</html>
`;
