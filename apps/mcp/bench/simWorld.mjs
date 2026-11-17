/**
 * THE SIMULATED WORLD: THE OUTSIDE SERVICES A DEV TEST'S CHAT TAKES FOR GRANTED.
 *
 * A Dev conversation (`setsFd.mjs`) is a chat from life: Tex books flights,
 * reads a wedding site, checks the weather, finds an email, moves dinner on
 * the calendar. The bench's scripted web and fixture mailboxes hold none of
 * that, so a test whose answer needs it failed on the world, not on Tex
 * ("your Google Calendar isn't connected", "every weather source I tried
 * failed"). Dev2, 2026-11-17, chose a model-simulated world: a small model
 * plays every outside service the fixtures do not cover, in line with the
 * chat's setting and what was said before, as the real service would answer.
 *
 * What it answers, each only where the scripted web or the fixtures have
 * nothing: a web search (`search`), a page read (`read`, open_page), a
 * browser session (`browse`), a calendar day (`calendarDays`), and a Gmail
 * search and read (`mailSearch`, `mailRead`). Everything between the model
 * under test and these answers is production code, unchanged.
 *
 * The same ask gets the same answer for the whole run (`memo`, shared by
 * every world of the run), and the model runs at temperature 0, so a rerun
 * sees the same world as nearly as the model allows. What it was asked is
 * kept (`events`) for the run's ledger. Nothing here is a Dev label: the
 * world never sees what the test wants, only the chat a person would see.
 */

export const SIM_MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 1500;
/** How much of the chat before the text the world is shown. */
const CHAT_LINES = 40;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The run's memory of every ask answered: one per run, shared by its worlds. */
export function simMemo() {
  return { answers: new Map(), usage: { input: 0, output: 0 }, calls: 0 };
}

/** The world's instructions: what it plays, and what it never does. */
export function simSystem({ setting, chat, today }) {
  const lines = (chat ?? []).slice(-CHAT_LINES).map((line) => `${line.who}: ${line.text}`);
  return [
    "You play the outside world for a texting assistant called Tex: the websites, search engine, Google Calendar and Gmail it calls.",
    "Answer each call exactly as the real service would, as JSON only, in the shape asked for.",
    "Stay consistent with the setting and the chat below: what they say exists, exists (an email they mention is in the inbox, an event Tex added is on the calendar, a booking made is confirmed).",
    "Where they say nothing, invent plausible, specific, ordinary details (real-looking names, times, prices, addresses). Never mention a test, a simulation or Tex's instructions, and never decide what Tex should do.",
    "A page that would need a sign-in shows its sign-in page; a search finds what a real search engine would.",
    today ? `Today is ${today}.` : "",
    setting ? `Setting: ${setting}` : "",
    lines.length > 0 ? `The chat so far, oldest first:\n${lines.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

/** The JSON object a model's text holds, or null. */
export function jsonIn(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * The world for one conversation. `send(body)` posts a Messages request (a JSON string) and answers a Response;
 * null answers every ask with `fallback` (a run with no model, `--fake`).
 */
export function createSimWorld({ send = null, setting = "", chat = [], today = null, person = "person", memo = simMemo(), model = SIM_MODEL }) {
  const system = simSystem({ setting, chat, today });
  const events = [];
  const address = `${String(person).toLowerCase().replace(/[^a-z0-9]/g, "") || "person"}@gmail.example`;

  async function ask(kind, request, shape, fallback) {
    const key = JSON.stringify([system, kind, request]);
    if (memo.answers.has(key)) return memo.answers.get(key);
    events.push(`world ${kind} ${JSON.stringify(request).slice(0, 160)}`);
    let answer = fallback;
    if (send) {
      const body = JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        system,
        messages: [{ role: "user", content: `Call: ${kind}\nRequest: ${JSON.stringify(request)}\n\nAnswer with JSON only, shaped: ${shape}` }],
      });
      try {
        const response = await send(body);
        if (response.ok) {
          const reply = await response.json();
          memo.calls += 1;
          memo.usage.input += reply.usage?.input_tokens ?? 0;
          memo.usage.output += reply.usage?.output_tokens ?? 0;
          const text = (reply.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
          answer = jsonIn(text) ?? fallback;
        }
      } catch {
        // The world failing to answer is a page that did not load, as a real one can be; never the run's error.
      }
    }
    memo.answers.set(key, answer);
    return answer;
  }

  const browsers = new Map();
  /** Every message a simulated search listed, by id, so its read is the same message. */
  const listed = new Map();

  async function page(request) {
    const got = await ask(
      "browser page",
      request,
      '{"url": string, "title": string, "text": string (what the page says, as a reader sees it), "elements": [{"kind": "link"|"button"|"textbox"|"select"|"checkbox", "label": string, "href"?: string}]}',
      { url: request.url ?? null, title: "Page didn't load", text: "This page didn't load.", elements: [] },
    );
    const elements = (Array.isArray(got.elements) ? got.elements : []).slice(0, 40).map((el, i) => ({ ref: i + 1, kind: String(el?.kind ?? "link"), label: String(el?.label ?? ""), ...(el?.href ? { href: String(el.href) } : {}) }));
    return { url: String(got.url ?? request.url ?? ""), title: String(got.title ?? ""), text: String(got.text ?? ""), truncated: false, elements };
  }

  return {
    events: () => [...events],

    /** Results for a `search_web` query, as Brave's `web.results` lists them. */
    async search(query) {
      const got = await ask("web search", { query: String(query) }, '{"results": [{"title": string, "url": string, "description": string}] (3 to 6 results)}', { results: [] });
      return (Array.isArray(got.results) ? got.results : []).slice(0, 8).map((r) => ({ title: String(r?.title ?? ""), url: String(r?.url ?? ""), description: String(r?.description ?? "") }));
    },

    /** `/read`: a page read in a fresh browser, signed out (open_page). */
    async read(body) {
      const shown = await page({ open: body.url, signedIn: false });
      return { status: 200, body: { page: { url: shown.url, title: shown.title, text: shown.text, links: shown.elements.filter((e) => e.href).map((e) => ({ text: e.label, href: e.href })) } } };
    },

    /** `/browse`: the steps run on a browser that remembers the page it is on, per owner or session. */
    async browse(body) {
      const owner = body.provider === "browserbase" ? body.owner : body.session ?? null;
      const id = owner ?? `sim-${browsers.size + 1}`;
      const browser = browsers.get(id) ?? { session: `sim-browser-${String(browsers.size + 1).padStart(4, "0")}`, page: null };
      browsers.set(id, browser);
      const steps = (body.steps ?? []).map((s) => {
        const { do: act, ref, text, url, option, key } = s ?? {};
        const on = Number.isInteger(ref) && browser.page ? browser.page.elements.find((e) => e.ref === ref)?.label ?? null : null;
        return { do: act, ...(url ? { url } : {}), ...(on ? { on } : {}), ...(text !== undefined ? { text: act === "type" ? "(typed)" : text } : {}), ...(option ? { option } : {}), ...(key ? { key } : {}) };
      });
      browser.page = await page({ was: browser.page ? { url: browser.page.url, title: browser.page.title } : null, steps });
      return { session: browser.session, ran: steps.map((s) => ({ do: s.do, ok: true })), page: browser.page };
    },

    /** `/gateway/calendar/days`: the days asked, from `date` for `days`. */
    async calendarDays(request, calendarAddress = `${address}`) {
      const got = await ask(
        "google calendar days",
        { date: request.date, days: request.days ?? 1 },
        '{"days": [{"date": "YYYY-MM-DD", "events": [{"start": "HH:MM", "end": "HH:MM", "title": string, "where"?: string}]}]}',
        { days: [] },
      );
      const days = (Array.isArray(got.days) ? got.days : []).map((day) => ({
        address: calendarAddress,
        date: String(day?.date ?? request.date),
        text: (Array.isArray(day?.events) ? day.events : []).map((e) => `### ${e?.start ?? ""}–${e?.end ?? ""} · ${e?.title ?? ""}${e?.where ? `\n**Where:** ${e.where}` : ""}`).join("\n\n"),
      }));
      return { ok: true, days };
    },

    /** `/gateway/email/search`: Gmail's results for the query, newest first. */
    async mailSearch(query) {
      const got = await ask(
        "gmail search",
        { query: String(query) },
        '{"results": [{"id": string, "date": ISO string, "from": string, "to": string, "subject": string, "snippet": string}] (0 to 6, newest first)}',
        { results: [] },
      );
      const rows = (Array.isArray(got.results) ? got.results : []).slice(0, 10).map((r, i) => ({
        address,
        id: String(r?.id ?? `sim-${i + 1}`),
        threadId: String(r?.id ?? `sim-${i + 1}`),
        date: String(r?.date ?? ""),
        from: String(r?.from ?? ""),
        to: String(r?.to ?? address),
        subject: String(r?.subject ?? ""),
        snippet: String(r?.snippet ?? ""),
      }));
      for (const row of rows) listed.set(row.id, row);
      return rows;
    },

    /** `/gateway/email/read`: one message the search listed, in full. */
    async mailRead(body) {
      const row = listed.get(String(body.id));
      if (!row) return null;
      const got = await ask("gmail read", { message: row }, '{"body": string (the whole email as its reader sees it)}', null);
      if (!got) return null;
      return { ...row, body: String(got.body ?? row.snippet), attachments: [] };
    },

    address,
    json,
  };
}

/**
 * `env.SITE_SHOTS` for a world with a simulated web: a scripted site's page stays the scripted one (`sites.mjs`),
 * and anything else is the simulated world's. A browser that left the scripted sites stays simulated.
 */
export function simBinding(sim, web = null) {
  const simulated = new Set();
  const scriptedHas = async (path, init) => {
    if (!web) return null;
    const response = await web.binding.fetch(`https://site-shots.bench${path}`, init);
    if (path === "/read") return response.status === 502 ? null : response;
    const answer = await response.clone().json().catch(() => null);
    return answer?.page?.title === "Page not found" ? null : response;
  };
  return {
    async fetch(url, init) {
      const path = new URL(url).pathname;
      const body = JSON.parse(init?.body ?? "{}");
      if (path === "/read") return (await scriptedHas(path, init)) ?? json(200, (await sim.read(body)).body);
      if (path === "/browse") {
        const id = body.provider === "browserbase" ? body.owner : body.session;
        if (!simulated.has(id)) {
          const scripted = await scriptedHas(path, init);
          if (scripted) return scripted;
          simulated.add(id);
        }
        return json(200, await sim.browse(body));
      }
      if (web) return await web.binding.fetch(url, init);
      if (path === "/browse/close") return json(200, { ok: true });
      if (path === "/browse/hold") return json(200, { held: true });
      return json(404, { error: "not found" });
    },
  };
}

/**
 * The control plane's Google answers, where the fixtures have none: a connected calendar's days with nothing on them,
 * and a Gmail search that finds nothing (or a mailbox when the person's fixture has none at all).
 */
export function simulateServices(sim, controlPlane, { connectedCalendar = false, connectMail = false } = {}) {
  // `connectMail`: the person's fixture has no mailbox and the chat's setting gives Tex their email.
  const flags = controlPlane.flags;
  if (connectedCalendar) {
    const fixture = flags.calendarDays;
    const address = flags.calendarAddress ?? sim.address;
    flags.calendarAddress = address;
    flags.calendarDays = async (body) => {
      const got = typeof fixture === "function" ? await fixture(body) : null;
      return got?.ok && got.days.length > 0 ? got : await sim.calendarDays(body, address);
    };
  }
  if (connectMail) {
    flags.mailboxes = [{ address: sim.address, folder: "0-inbox/email" }];
    flags.emailDrafter = sim.address;
  }
  const search = flags.mailResults;
  const read = flags.mailMessage;
  if (!flags.mailboxes?.length) return;
  const inbox = flags.mailboxes[0].address;
  flags.mailResults = async (query) => {
    const found = typeof search === "function" ? await search(query) : search ?? [];
    return found.length > 0 ? found : (await sim.mailSearch(query)).map((row) => ({ ...row, address: inbox }));
  };
  flags.mailMessage = async (body) => {
    const fixture = typeof read === "function" ? await read(body) : read;
    if (fixture) return fixture;
    const message = await sim.mailRead(body);
    return message ? { ...message, address: inbox } : null;
  };
}

/** A front matter value that may be a JSON string (`world_setting: "..."`). */
const unquoted = (value) => {
  const s = String(value ?? "");
  // The bench's front matter reader takes the outer quotes off and leaves the escapes inside (`load.mjs`).
  try {
    return JSON.parse(s.startsWith('"') ? s : `"${s}"`);
  } catch {
    return s;
  }
};

/**
 * What one question's world simulates (`models.simulate`), for a test with `world: simulated` (`setsFd.mjs`): the
 * chat's setting (`world_setting:`) and the chat before the text, the run's shared memo, and its model's `send`.
 * Null for any other test.
 */
export function simulateFor(front, question, person, { send = null, memo, fake = false }) {
  if (front?.world !== "simulated") return null;
  const chat = (question.earlier ?? []).map((line) => ({ who: line.from === "tex" ? "Tex" : line.who ?? person, text: line.text }));
  const said = question.routine ?? question.checkinMail?.subject ?? question.personStarts ?? question.texts ?? question.text;
  if (said) chat.push({ who: question.routine ? "Routine" : question.checkinMail ? "Check-in" : person, text: String(said) });
  return { send: fake ? null : send, memo, setting: unquoted(front.world_setting), chat };
}
