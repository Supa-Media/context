/**
 * The two card pages that show the person's own data
 * (docs/decisions/texting-assistant/visual-answers.md):
 *
 * - `/messages/inbox`: the newest mail in their inbox. They tap the emails
 *   Tex should take care of and send one card back,
 *   `https://context.lc/tex/inbox?m=<address>/<id>&m=…`, which reaches Tex as
 *   "Please take care of these emails: …" (`apps/agent/src/dataCards.ts`).
 * - `/messages/times`: the next five days, with every busy time shaded. They
 *   tap up to five free times and send `https://context.lc/tex/times?d=<minutes>&z=<zone>&s=<instant>&s=…`,
 *   which reaches Tex, or a friend in that chat, as the times written out.
 *
 * The page never holds a credential and never fetches anything itself (its
 * policy has no `connect-src`). It asks the extension (`fetch`), which adds
 * the card key and asks the gateway's `/cards/` routes. A sender and a
 * subject are whoever wrote the email, so every word from the data is set
 * with `textContent`, never as markup. Nothing fetched is sent anywhere
 * unless the person taps Send, and then only the ids or times they chose,
 * in a card the page builds.
 *
 * A card that came back (one with `m=` or `s=`) is shown as what was sent,
 * read from its address, and fetches nothing: whoever taps it in the chat
 * sees what was chosen, not their own inbox or week.
 */

import { escaped, type Page } from "./messagesPage";

const MAX_SENT = 10;
const MAILBOX_ID = /^[^\s@/]{1,64}@[^\s/]{1,255}\/[A-Za-z0-9_-]{1,64}$/;

/** The data pages' one script, a constant allowed by its hash (`messagesCards.test.ts` checks it). */
export const DATA_SCRIPT = `(function () {
  var handlers = window.webkit && window.webkit.messageHandlers;
  var bridge = handlers && handlers.context;
  var shell = window.contextShell;
  var view = document.body.getAttribute("data-view");
  var list = document.getElementById("list");
  var status = document.getElementById("status");
  var send = document.getElementById("send");
  if (!list || !send) return;
  function say(text) { status.textContent = text; }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  if (!bridge || !shell || shell.abilities.indexOf("fetch") < 0) {
    say("Update the Context app to see this here.");
    return;
  }
  bridge.postMessage({ kind: "size", style: "expanded" });
  var waiting = {};
  var next = 0;
  window.contextCardResponse = function (id, code, text) {
    var answer = waiting[id];
    delete waiting[id];
    if (!answer) return;
    var body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    answer(code, body);
  };
  function ask(path, answer) {
    next += 1;
    var id = "r" + next;
    waiting[id] = answer;
    bridge.postMessage({ kind: "fetch", id: id, path: path });
  }
  function trouble(code, body) {
    if (code === 401) return "Open the Context app once, then try again.";
    if (code === 0) return "You're offline. Try again in a moment.";
    var refused = body && body.refused;
    if (refused === "no_calendar") return "Your Google Calendar isn't connected. Ask Tex to connect it.";
    if (refused === "not_allowed" || refused === "no_mailbox") return "Connect your Gmail first. Ask Tex to connect it.";
    if (refused === "reconnect_required") return "Your Google sign-in stopped working. Ask Tex to reconnect it.";
    return "Google didn't answer just now. Try again in a moment.";
  }
  var chosen = [];
  window.contextCardDone = function (ok) {
    if (ok) return;
    send.disabled = chosen.length === 0;
    say("That didn't send. Try again, or tell Tex in words.");
  };
  function toggle(button, value, most) {
    var at = chosen.indexOf(value);
    if (at >= 0) chosen.splice(at, 1);
    else if (chosen.length < most) chosen.push(value);
    else { say("That's the most one card can hold."); return; }
    say("");
    button.className = (button.className.replace(/ ?on$/, "")) + (at >= 0 ? "" : " on");
    button.setAttribute("aria-pressed", at >= 0 ? "false" : "true");
    send.disabled = chosen.length === 0;
    label();
  }

  /* ---------------- the inbox ---------------- */
  function inbox() {
    ask("/cards/inbox", function (code, body) {
      list.textContent = "";
      if (code !== 200 || !body || body.ok !== true) { say(trouble(code, body)); return; }
      if (body.messages.length === 0) { list.appendChild(el("p", "", "Nothing new in your inbox from the last two weeks.")); return; }
      body.messages.forEach(function (message) {
        var row = el("button", "mail");
        row.type = "button";
        row.setAttribute("aria-pressed", "false");
        row.appendChild(el("b", "line", String(message.from).replace(/\\s*<[^>]*>$/, "")));
        row.appendChild(el("span", "line", message.subject || "(no subject)"));
        if (message.snippet) row.appendChild(el("span", "line detail", message.snippet));
        var value = message.address + "/" + message.id;
        row.addEventListener("click", function () { toggle(row, value, ${MAX_SENT}); });
        list.appendChild(row);
      });
    });
  }

  /* ---------------- the week ---------------- */
  var zone = "UTC";
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { zone = "UTC"; }
  var minutes = 30;
  var busy = [];
  var DAYS = 5;
  function localDate(at) {
    return at.getFullYear() + "-" + ("0" + (at.getMonth() + 1)).slice(-2) + "-" + ("0" + at.getDate()).slice(-2);
  }
  function free(start) {
    var end = start + minutes * 60000;
    for (var i = 0; i < busy.length; i++) if (busy[i][0] < end && busy[i][1] > start) return false;
    return true;
  }
  function clock(at) { return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  function dayName(at) { return new Date(at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); }
  function drawWeek() {
    list.textContent = "";
    chosen = [];
    send.disabled = true;
    label();
    var now = Date.now();
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    for (var d = 0; d < DAYS; d++) {
      var day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + d);
      list.appendChild(el("div", "day", dayName(day.getTime())));
      var slots = el("div", "slots");
      var shown = 0;
      for (var half = 18; half + minutes / 30 <= 36; half++) {
        var start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(half / 2), (half % 2) * 30).getTime();
        if (start < now || !free(start)) continue;
        var slot = el("button", "", clock(start));
        slot.type = "button";
        slot.setAttribute("aria-pressed", "false");
        (function (button, value) { button.addEventListener("click", function () { toggle(button, value, 5); }); })(slot, new Date(start).toISOString());
        slots.appendChild(slot);
        shown += 1;
      }
      if (shown === 0) slots.appendChild(el("span", "detail", "No free time between 9 and 6."));
      list.appendChild(slots);
    }
  }
  function week() {
    var bar = document.getElementById("length");
    if (bar) {
      var options = bar.querySelectorAll("button[data-minutes]");
      for (var i = 0; i < options.length; i++) {
        options[i].addEventListener("click", function (event) {
          minutes = Number(event.currentTarget.getAttribute("data-minutes"));
          for (var j = 0; j < options.length; j++) options[j].className = options[j] === event.currentTarget ? "on" : "";
          drawWeek();
        });
      }
    }
    ask("/cards/week?from=" + localDate(new Date()) + "&days=" + DAYS, function (code, body) {
      list.textContent = "";
      if (code !== 200 || !body || body.ok !== true) { say(trouble(code, body)); return; }
      busy = [];
      body.days.forEach(function (day) {
        day.busy.forEach(function (block) { busy.push([Date.parse(block.start), Date.parse(block.end)]); });
      });
      if (body.unanswered && body.unanswered.length) say("Google didn't answer for " + body.unanswered.join(", ") + ", so those calendars aren't shown.");
      drawWeek();
    });
  }

  function label() {
    var n = chosen.length;
    if (view === "inbox") send.textContent = n === 0 ? "Tap the emails for Tex" : "Hand Tex " + n + (n === 1 ? " email" : " emails");
    else send.textContent = n === 0 ? "Tap times that work" : "Send " + n + (n === 1 ? " time" : " times");
  }
  send.addEventListener("click", function () {
    if (chosen.length === 0) return;
    send.disabled = true;
    var n = chosen.length;
    var request;
    if (view === "inbox") {
      request = {
        kind: "send",
        url: "https://context.lc/tex/inbox?" + chosen.map(function (m) { return "m=" + encodeURIComponent(m); }).join("&"),
        caption: "For Tex: " + n + (n === 1 ? " email" : " emails"),
        subcaption: "Please take care of these",
        summary: "Handed Tex " + n + (n === 1 ? " email" : " emails"),
      };
    } else {
      var sorted = chosen.slice().sort();
      var words = sorted.map(function (at) { return dayName(Date.parse(at)) + " " + clock(Date.parse(at)); }).join(", ");
      request = {
        kind: "send",
        url: "https://context.lc/tex/times?d=" + minutes + "&z=" + encodeURIComponent(zone) + "&" + sorted.map(function (at) { return "s=" + encodeURIComponent(at); }).join("&"),
        caption: n + (n === 1 ? " time" : " times") + " that work for me",
        subcaption: words.length > 100 ? words.slice(0, 99) + "…" : words,
        summary: "Times that work for me",
      };
    }
    bridge.postMessage(request);
  });
  label();
  if (view === "inbox") inbox();
  else if (view === "times") week();
})();`;

/** `DATA_SCRIPT`'s sha256, which the data pages' policy allows. */
export const DATA_SCRIPT_HASH = "sha256-pNSRUWi6Oqegf6gUZGZhR+74lMp0KVBUkMkWXUVLQ4k=";

function sentPage(title: string, heading: string, lines: string[]): Page {
  return {
    title,
    body: `<h1>${escaped(heading)}</h1>${lines.map((line) => `<p>${escaped(line)}</p>`).join("")}`,
    size: "compact",
  };
}

export function inboxPage(query: URLSearchParams): Page {
  const sent = query.getAll("m").filter((m) => MAILBOX_ID.test(m)).slice(0, MAX_SENT);
  if (sent.length > 0) return sentPage("For Tex", `Handed Tex ${sent.length} ${sent.length === 1 ? "email" : "emails"}`, ["Tex reads each one and takes it from there."]);
  return {
    title: "Your inbox",
    body: '<h1>Which of these should Tex take care of?</h1><div id="list"><p>Loading your inbox…</p></div><button type="button" id="send" class="primary" disabled></button>',
    size: "expanded",
    script: "data",
    view: "inbox",
  };
}

export function timesPage(query: URLSearchParams): Page {
  const sent = query
    .getAll("s")
    .map((at) => Date.parse(at))
    .filter(Number.isFinite)
    .slice(0, 5);
  if (sent.length > 0) {
    const zone = validZone(query.get("z")) ?? "UTC";
    const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return sentPage("Times", "Times that work", [...sent.map((at) => format.format(at)), `In ${zone}.`]);
  }
  return {
    title: "Pick times",
    body:
      "<h1>When works? Tap a few free times.</h1>" +
      '<div class="bar" id="length"><button type="button" data-minutes="30" class="on">30 min</button><button type="button" data-minutes="60">1 hour</button></div>' +
      '<div id="list"><p>Loading your week…</p></div><button type="button" id="send" class="primary" disabled></button>',
    size: "expanded",
    script: "data",
    view: "times",
  };
}

/** An IANA zone this runtime knows, or null. */
export function validZone(value: string | null): string | null {
  if (value === null || value.length > 64 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}
