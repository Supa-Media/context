/**
 * SCRIPTED SITES: THE WEB A GOLDEN TASK IS DONE ON.
 *
 * A golden task (`tests/tasks.md`, decided by the owner 2026-10-11) is a job
 * the texting assistant must always get right, and most of them happen on a
 * website: connect ChatGPT to Context, save a login, check a page. A run
 * cannot sign in to the real chatgpt.com, and a result that depends on what
 * a live site shows today measures the site. So a task runs on scripted
 * pages, one file per site in `sites/`, served by a stand-in for the
 * screenshot Worker (`infra/site-shots`) on the same `SITE_SHOTS` binding the
 * gateway calls. Everything between the model and that binding (the address
 * guard, the typing rule, the handoff link, `browserProviders.js`) is the
 * production code, unchanged.
 *
 * A site file:
 *
 *   ---
 *   site: chatgpt.com
 *   sign_in: https://chatgpt.com/auth/login
 *   search: chatgpt, openai
 *   ---
 *
 *   ## https://chatgpt.com/plugins
 *   title: Plugins | ChatGPT
 *   signed in only
 *   text: Plugins you've added.
 *   text (connected context): Context: connected.
 *   - button: Add -> https://chatgpt.com/plugins/new
 *   - button: Create -> https://mcp.context.lc/authorize [needs Name, MCP server URL = https://mcp.context.lc/mcp] [sets connected context]
 *   - download: Download September invoice [file Invoice-2026-09.pdf]
 *
 * - `signed in only`: a browser that is signed out lands on `sign_in`
 *   instead, and goes on to the page it wanted once the person signs in.
 * - `text (flag):` lines and `- button (flag):` elements show only once the
 *   flag is set; `(!flag)` shows only while it is unset, and `(a, !b)` needs
 *   all of them. `[sets flag]` on a button sets it when the button goes through.
 * - A select's choice is kept for the conversation, by page and label, so a
 *   setting chosen once is still chosen when the page is loaded again.
 * - `[needs Label, Label = value]`: the button goes nowhere until those boxes
 *   are filled (or hold that value, or that option is chosen, or that box is
 *   ticked), and the page then says what is missing.
 * - `popup (flag): words`: while the flag is set, the page is covered by a
 *   popup that says those words (a seat map, 2026-10-26). The reading says
 *   so (`popup: true`, as `infra/site-shots/src/popups.ts` does), a click or
 *   typing on the page under it does nothing, Escape doesn't close it, and a
 *   `close_popup` step does, unsetting the flag.
 * - `- filler: 90`: that many links in a row ("Timetable 1" ...), each back
 *   to the page, to push what follows past a reading's first elements.
 * - `[sets flag]` sets it on any button that goes through, with or without
 *   `->`.
 * - `- download:` is a button that saves a file, `[file name]`: a browse
 *   `download` step naming it gets a small PDF of that name back.
 * - `search:` words: a `search_web` query with one of them lists the site's
 *   pages, so finding a site is part of the task.
 * - `captcha: 2` (or `captcha: always`): the page shows a "verify you are
 *   human" wall, and nothing else, on its first two loads in the
 *   conversation, and the run answers `captcha: "unsolved"` as the screenshot
 *   Worker does once Browserbase's solver gave up (`infra/site-shots/src/captcha.ts`).
 *   The gateway's reload is the second load and its fresh browser
 *   (`fresh: true`) the third (`apps/mcp/src/agent/captchaLadder.js`), so
 *   `captcha: 1` clears on the reload, `2` on the fresh browser, and
 *   `always` only when the person solves it through a handoff.
 *
 * The person signs in only through a handoff: once a turn handed the browser
 * over, the next text from the person comes after they signed in on that
 * site, the way someone taking over at their `/tex/<handle>` page would. The
 * `liveUrl` this stand-in answers with is what an older screenshot Worker
 * sent; the gateway must never pass it on.
 *
 * What the browser did is recorded (`events`), and a task's checks read it:
 * which pages it reached, where it handed over, what it typed, which flags it
 * set. Nothing here sees a model or a note.
 */

import { normalize, parseFront } from "./frontMatter.mjs";

export const LIVE_VIEW_ORIGIN = "https://live.bench.invalid";

const ELEMENT = /^- (link|button|textbox|select|checkbox|password|download)(?:\s+\(([^)]+)\))?:\s*(.*)$/;

/** An address without its scheme or trailing slash: how a check names a page. */
export const placeOf = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.host.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch {
    return String(url);
  }
};

/**
 * A `(flag)` condition as a list of `{name, not}`, every one of which must
 * hold; null when the line has none.
 */
export function readFlags(raw, where) {
  if (raw === undefined || raw === null) return null;
  return raw.split(",").map((part) => {
    const name = part.trim().replace(/^!\s*/, "");
    if (!name) throw new Error(`${where}: an empty flag in "(${raw})"`);
    return { name, not: part.trim().startsWith("!") };
  });
}

/** Whether a line or element with condition `when` shows, given the flags set. */
export const shows = (when, flags) => when === null || when.every(({ name, not }) => flags.has(name) !== not);

function readElement(kind, when, rest, where) {
  let text = rest.trim();
  const needs = [];
  const sets = [];
  let file = null;
  for (;;) {
    const tail = text.match(/\s*\[(needs|sets|file)\s+([^\]]+)\]\s*$/);
    if (!tail) break;
    if (tail[1] === "file") file = tail[2].trim();
    else if (tail[1] === "sets") sets.unshift(tail[2].trim());
    else {
      for (const part of tail[2].split(",")) {
        const [label, value] = part.split("=").map((s) => s.trim());
        if (!label) throw new Error(`${where}: a [needs] item has no label`);
        needs.push({ label, value: value === undefined || value === "" ? null : value });
      }
    }
    text = text.slice(0, tail.index).trim();
  }
  let href = null;
  const arrow = text.match(/(?:^|\s)->\s+(\S+)$/);
  if (arrow) {
    href = arrow[1];
    text = text.slice(0, arrow.index).trim();
    if (!/^https:\/\//.test(href)) throw new Error(`${where}: "${href}" is not an https address`);
  }
  let options = null;
  const listed = text.match(/^(.*?)\s*\(([^)]*)\)$/);
  if (kind === "select") {
    if (!listed) throw new Error(`${where}: a select lists its options, as "Label (One, Two)"`);
    text = listed[1].trim();
    options = listed[2].split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (!text) throw new Error(`${where}: an element needs a label`);
  if (kind === "download" && !file) throw new Error(`${where}: a download names its file, as "Label [file name.pdf]"`);
  return { kind, when, label: text, href, needs, sets, options, file };
}

/** One site file, parsed. Throws with the line that is wrong. */
export function parseSite(raw, label = "site") {
  const lines = normalize(raw).split("\n");
  if (lines[0] !== "---") throw new Error(`${label}: a site file starts with front matter`);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error(`${label}: the front matter is not closed`);
  const front = parseFront(lines.slice(1, end), 2);
  if (!front.site) throw new Error(`${label}: front matter needs site:`);
  const site = {
    host: String(front.site).toLowerCase(),
    signIn: front.sign_in || null,
    search: String(front.search ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    pages: new Map(),
  };
  let page = null;
  lines.slice(end + 1).forEach((line, i) => {
    const where = `${label} line ${end + 2 + i}`;
    const t = line.trim();
    const heading = line.match(/^## (https:\/\/\S+)\s*$/);
    if (heading) {
      page = { url: heading[1], title: "", text: [], signedInOnly: false, elements: [], captcha: 0, popup: null };
      site.pages.set(placeOf(heading[1]), page);
      return;
    }
    if (!page || t === "" || t.startsWith("# ")) return;
    let m;
    if ((m = t.match(/^title:\s*(.*)$/))) page.title = m[1];
    else if (t === "signed in only") page.signedInOnly = true;
    else if ((m = t.match(/^captcha:\s*(\d+|always)$/))) page.captcha = m[1] === "always" ? Infinity : Number(m[1]);
    else if ((m = t.match(/^text(?:\s+\(([^)]+)\))?:\s*(.*)$/))) page.text.push({ when: readFlags(m[1], where), line: m[2] });
    else if ((m = t.match(/^popup\s+\(([^)]+)\):\s*(.*)$/))) page.popup = { when: readFlags(m[1], where), line: m[2] };
    else if ((m = t.match(/^- filler:\s*(\d{1,3})$/))) {
      for (let n = 1; n <= Number(m[1]); n++) page.elements.push({ kind: "link", when: null, label: `Timetable ${n}`, href: page.url, needs: [], sets: [], options: null, file: null });
    }
    else if ((m = t.match(ELEMENT))) page.elements.push(readElement(m[1], readFlags(m[2], where), m[3], where));
    else throw new Error(`${where}: cannot read "${t}"`);
  });
  if (site.pages.size === 0) throw new Error(`${label}: no pages`);
  if (site.signIn && !site.pages.has(placeOf(site.signIn))) throw new Error(`${label}: sign_in ${site.signIn} is not one of its pages`);
  return site;
}

/**
 * The web for one conversation: every site, one browser per person that
 * outlives a question (as Browserbase's does), who is signed in where, the
 * flags set, and what happened. `binding` is what `env.SITE_SHOTS` is set to.
 */
export function createWeb(sites) {
  const byHost = new Map(sites.map((site) => [site.host, site]));
  const signedIn = new Set();
  const flags = new Set();
  // A select's choice, by page and label: the site remembers a setting across loads.
  const chosen = new Map();
  const events = [];
  const browsers = new Map();
  // A captcha page's loads this conversation, and the ones the person solved.
  const loads = new Map();
  const solved = new Set();
  let handedOff = null;
  let sessions = 0;

  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  };
  const siteFor = (url) => byHost.get(hostOf(url)) ?? null;
  const pageFor = (url) => {
    const site = siteFor(url);
    if (!site) return null;
    const exact = site.pages.get(placeOf(url));
    if (exact) return exact;
    const bare = new URL(url);
    bare.search = "";
    return site.pages.get(placeOf(bare.toString())) ?? null;
  };

  /** Where a browser that asked for `url` ends up, given who is signed in. */
  function land(browser, url) {
    const page = pageFor(url);
    const site = siteFor(url);
    if (page?.signedInOnly && site && !signedIn.has(site.host) && site.signIn) {
      browser.returnTo = url;
      browser.url = site.signIn;
    } else browser.url = url;
    browser.values = new Map();
    browser.history.push(browser.url);
    events.push(`open ${placeOf(browser.url)}`);
    const place = placeOf(browser.url);
    loads.set(place, (loads.get(place) ?? 0) + 1);
  }

  /** Whether the page the browser is on still stands behind its captcha. */
  function walled(browser) {
    const page = browser.url === null ? null : pageFor(browser.url);
    if (!page || page.captcha === 0) return false;
    const place = placeOf(browser.url);
    return !solved.has(place) && (loads.get(place) ?? 0) <= page.captcha;
  }

  /** The page's elements whose flags hold (or that have none), with their place in the file. */
  const visible = (page) => page.elements.map((el, i) => ({ el, i })).filter(({ el }) => shows(el.when, flags));
  const choiceKey = (page, el) => `${placeOf(page.url)} ${el.label.toLowerCase()}`;
  /** What an element holds: a select's kept choice (else its first option), or what this page load typed or ticked. */
  const valueOf = (browser, page, i) => {
    const el = page.elements[i];
    return el.kind === "select" ? chosen.get(choiceKey(page, el)) ?? el.options[0] : browser.values.get(i);
  };

  function reading(browser, note = "") {
    const page = pageFor(browser.url);
    if (!page) return { url: browser.url, title: "Page not found", text: "This page doesn't exist.", truncated: false, elements: [] };
    if (walled(browser)) return { url: browser.url, title: "Just a moment...", text: "Verify you are human by completing the action below.", truncated: false, elements: [] };
    const text = page.text.filter((t) => shows(t.when, flags)).map((t) => t.line);
    const covered = popupShows(page);
    if (covered) text.unshift(page.popup.line);
    if (note) text.unshift(note);
    const elements = visible(page).map(({ el, i }, shown) => {
      const value = valueOf(browser, page, i);
      const item = { ref: shown + 1, kind: el.kind === "password" ? "textbox (password)" : el.kind === "download" ? "button" : el.kind, label: el.kind === "select" ? `${el.label} (now: ${value})` : el.label };
      if (el.href) item.href = el.href;
      if (el.kind === "checkbox") item.checked = value === true;
      else if ((el.kind === "textbox" || el.kind === "password") && value) item.filled = true;
      return item;
    });
    return { url: browser.url, title: page.title, text: text.join("\n"), truncated: false, elements, ...(covered ? { popup: true } : {}) };
  }

  /** Whether the page's popup covers it now. */
  const popupShows = (page) => page?.popup != null && shows(page.popup.when, flags);

  /** The [needs] a button's page does not meet, as words for the page. */
  function missing(browser, page, element) {
    const out = [];
    for (const need of element.needs) {
      const index = page.elements.findIndex((el) => shows(el.when, flags) && el.label.toLowerCase() === need.label.toLowerCase());
      const el = page.elements[index];
      const value = index < 0 ? undefined : valueOf(browser, page, index);
      const ok =
        el?.kind === "checkbox"
          ? value === true
          : need.value === null
            ? typeof value === "string" && value.trim() !== ""
            : typeof value === "string" && value.trim().toLowerCase() === need.value.toLowerCase();
      if (!ok) out.push(need.value === null ? need.label : `${need.label} (${need.value})`);
    }
    return out;
  }

  function step(browser, s) {
    // Behind a captcha wall, nothing on the page can be pressed.
    const page = walled(browser) ? null : pageFor(browser.url);
    // A ref numbers the elements the last reading showed; values are kept by place in the file.
    const picked = page && Number.isInteger(s.ref) ? visible(page)[s.ref - 1] ?? null : null;
    const el = picked?.el ?? null;
    const at = picked?.i ?? -1;
    switch (s.do) {
      case "goto":
        land(browser, s.url);
        return { ok: true, moved: true };
      case "read":
      case "scroll":
      case "press":
        return { ok: true };
      case "close_popup": {
        if (!popupShows(page)) return { ok: false, reason: "nothing on the page looks like a popup; look to see what is in the way" };
        for (const { name, not } of page.popup.when) if (!not) flags.delete(name);
        events.push(`close popup ${placeOf(browser.url)}`);
        return { ok: true, reason: "pressed its close button" };
      }
      case "back":
        if (browser.history.length < 2) return { ok: false, reason: "nothing to go back to" };
        browser.history.pop();
        browser.url = browser.history.at(-1);
        browser.values = new Map();
        return { ok: true, moved: true };
      case "click": {
        if (!el) return { ok: false, reason: "no such element" };
        // Under a popup the press lands on its cover: nothing happens, and nothing says so.
        if (popupShows(page)) {
          events.push(`blocked click ${placeOf(browser.url)} "${el.label}"`);
          return { ok: true };
        }
        events.push(`click ${placeOf(browser.url)} "${el.label}"`);
        if (el.kind === "checkbox") {
          browser.values.set(at, browser.values.get(at) !== true);
          return { ok: true };
        }
        const short = missing(browser, page, el);
        if (short.length > 0) return { ok: true, note: `Fill in: ${short.join(", ")}.` };
        for (const flag of el.sets) {
          flags.add(flag);
          events.push(`set ${flag}`);
        }
        if (!el.href) return { ok: true };
        land(browser, el.href);
        return { ok: true, moved: true };
      }
      case "type": {
        if (!el || (el.kind !== "textbox" && el.kind !== "password")) return { ok: false, reason: "that is not a box to type in" };
        if (Array.isArray(s.onlyOn) && !s.onlyOn.includes(hostOf(browser.url))) return { ok: false, reason: "not on a site the person named" };
        // The popup keeps the focus, so the keys never reach the box.
        if (popupShows(page)) return { ok: true };
        browser.values.set(at, String(s.text ?? ""));
        events.push(`type ${placeOf(browser.url)} "${String(s.text ?? "").slice(0, 120)}"`);
        return { ok: true };
      }
      case "download": {
        // By number, or by the words on it, as the real browser takes it.
        const named = el ?? (page && typeof s.text === "string" ? visible(page).find(({ el: e }) => e.label.toLowerCase() === s.text.trim().toLowerCase())?.el ?? null : null);
        if (!named?.file) return { ok: false, reason: "no file came from that; look at the page to see what it did, or name the download button or link itself" };
        events.push(`download ${placeOf(browser.url)} "${named.file}"`);
        const data = Buffer.from(`%PDF-1.4 ${hostOf(browser.url)} ${named.label}`, "latin1").toString("base64");
        return { ok: true, file: { name: named.file, type: "application/pdf", data } };
      }
      case "select": {
        if (!el || el.kind !== "select") return { ok: false, reason: "that is not a list" };
        const option = el.options.find((o) => o.toLowerCase() === String(s.option ?? "").toLowerCase());
        if (!option) return { ok: false, reason: "no such option" };
        chosen.set(choiceKey(page, el), option);
        events.push(`select ${placeOf(browser.url)} "${el.label}: ${option}"`);
        return { ok: true };
      }
      case "fill":
        return { ok: false, reason: "no saved login in this world" };
      default:
        return { ok: false, reason: "unknown step" };
    }
  }

  function browse(body) {
    const owner = body.provider === "browserbase" ? body.owner : null;
    // A fresh browser: the running one is let go, sign-ins come back from the jar (`signedIn` is the site's).
    if (owner && body.fresh === true && browsers.has(owner)) {
      browsers.delete(owner);
      events.push("fresh browser");
    }
    let browser = owner ? browsers.get(owner) : body.session ? [...browsers.values()].find((b) => b.session === body.session) : null;
    if (!browser) {
      sessions += 1;
      browser = { session: `bench-browser-${String(sessions).padStart(4, "0")}`, url: null, history: [], values: new Map(), returnTo: null };
      browsers.set(owner ?? browser.session, browser);
    }
    const ran = [];
    let note = "";
    let file = null;
    for (const [i, s] of (body.steps ?? []).entries()) {
      if (browser.url === null && s.do !== "goto") {
        ran.push({ do: s.do, ok: false, reason: "no page open" });
        continue;
      }
      const result = step(browser, s);
      ran.push({ do: s.do, ok: result.ok, ...(result.reason ? { reason: result.reason } : {}) });
      // A refused step, with the element number it named: why a driver's form never filled.
      if (!result.ok) events.push(`refused ${s.do} ${placeOf(browser.url)}${Number.isInteger(s.ref) ? ` [${s.ref}]` : ""}: ${result.reason}`);
      if (result.note) note = result.note;
      // One file a call, and the steps after a download are left for the next, as the real browser does.
      if (s.do === "download") {
        file = result.file ?? null;
        break;
      }
      // A click that changed the page leaves the steps after it for the next call.
      if (result.moved && s.do !== "goto" && i < body.steps.length - 1) {
        ran.push({ do: "read", ok: true, reason: "the page changed, so the steps after this one were not run" });
        break;
      }
    }
    let liveUrl = null;
    if (body.handoff === true && owner) {
      liveUrl = `${LIVE_VIEW_ORIGIN}/${browser.session}`;
      handedOff = browser;
      events.push(`handoff ${hostOf(browser.url ?? "")}`);
    }
    // The screenshot Worker's answer once Browserbase's solver has had its wait; never on a handoff, which skips it.
    const captcha = body.handoff !== true && walled(browser) ? "unsolved" : null;
    if (captcha) events.push(`captcha ${placeOf(browser.url)}`);
    return {
      session: browser.session,
      ran,
      page: browser.url === null ? null : reading(browser, note),
      ...(liveUrl ? { liveUrl } : {}),
      ...(file ? { file } : {}),
      ...(captcha ? { captcha } : {}),
    };
  }

  function read(body) {
    // `open_page` reads in a fresh browser: signed out everywhere.
    const page = pageFor(body.url);
    if (!page) return { status: 502, body: { error: "unreadable" } };
    const browser = { url: body.url, values: new Map(), history: [] };
    if (page.signedInOnly && siteFor(body.url)?.signIn) browser.url = siteFor(body.url).signIn;
    events.push(`read ${placeOf(browser.url)}`);
    const shown = reading(browser);
    return { status: 200, body: { page: { url: shown.url, title: shown.title, text: shown.text, links: shown.elements.filter((e) => e.href).map((e) => ({ text: e.label, href: e.href })) } } };
  }

  const BLANK_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  return {
    binding: {
      async fetch(url, init) {
        const path = new URL(url).pathname;
        const body = JSON.parse(init?.body ?? "{}");
        if (path === "/read") {
          const answer = read(body);
          return json(answer.status, answer.body);
        }
        if (path === "/browse") return json(200, browse(body));
        if (path === "/browse/close") return json(200, { ok: true });
        // A card drawn (`draw_visual`): the bench has no browser to photograph it, so a blank picture
        // stands in. Without it every card failed to draw and the bench scored "the card won't draw".
        if (path === "/render") return json(200, { png: BLANK_PNG, width: body.width ?? 600, height: body.height ?? 800, blocked: [] });
        return json(404, { error: "not found" });
      },
    },

    /** Results for a `search_web` query: every page of a site one of whose words it has. */
    search(query) {
      const words = new Set(String(query).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
      const results = [];
      for (const site of sites) {
        if (!site.search.some((word) => words.has(word))) continue;
        for (const page of site.pages.values()) results.push({ title: page.title || page.url, url: page.url, description: page.text.find((t) => t.when === null)?.line ?? "" });
      }
      events.push(`search "${String(query).slice(0, 80)}"`);
      return results;
    },

    /**
     * The person did what the last handoff asked: signed in on the site the
     * browser was on. Called before their next text.
     */
    personSignsIn() {
      if (!handedOff) return;
      const browser = handedOff;
      handedOff = null;
      const site = siteFor(browser.url ?? "");
      if (!site) return;
      if (walled(browser)) {
        solved.add(placeOf(browser.url));
        events.push(`solved captcha ${placeOf(browser.url)}`);
      }
      signedIn.add(site.host);
      events.push(`signed in ${site.host}`);
      if (site.signIn && placeOf(browser.url) === placeOf(site.signIn) && browser.returnTo) {
        const back = browser.returnTo;
        browser.returnTo = null;
        land(browser, back);
      }
    },

    events: () => [...events],
  };
}
