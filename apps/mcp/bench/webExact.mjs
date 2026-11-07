#!/usr/bin/env node
/**
 * `node bench/webExact.mjs [--dry] [--only id,id] [--out file.json]`: twenty
 * questions, each with one exact value on a live web page, asked through
 * Tex's real turn (`runTurn`) with the web tools `computer.js` builds
 * (`webSession`: `open_page`, `search_web`, and `browse` when there is a
 * browser). Each answer is scored on:
 *
 *   exact    the gold value, after the question's normalizer, is in the answer
 *   cited    the answer (or a step's sources) names one of the question's URLs
 *   browser  whether the turn used `browse` (a real browser, not a page read)
 *   ms       wall time of the turn, tokens: input + output from `usage`
 *
 * GOLD VALUES DRIFT. Each was read from its live page on the date in
 * `checked` (UTC). Recheck every one before each live run: prices, release
 * dates, versions and download counts change, and a stale gold scores a right
 * answer as wrong.
 *
 * LIVE (spends: each question is several Claude calls and up to a few Brave
 * searches; never run in CI):
 *   AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID, AI_GATEWAY_TOKEN   the product's gateway
 *     (`src/agent/aiGateway.js`), plus ANTHROPIC_CREDIT_KEY when it holds no key
 *   BRAVE_SEARCH_API_KEY   for `search_web` (`src/agent/search.js`)
 *   SITE_SHOTS_URL         optional: a `wrangler dev --remote` of infra/site-shots
 *     (Cloudflare Browser Rendering). That Worker has no public route, so this is
 *     the only way to reach the product's browser from here; with it the turn gets
 *     the real `open_page` and `browse`. Without it, `open_page` reads the page
 *     with a plain fetch and `browse` is not offered (JS pages will then fail,
 *     which is part of what the baseline measures).
 *   WEB_EXACT_MODEL        overrides the model (default: the product's gateway default)
 *
 * The web is opened the way an open-web setup opens it (`trust([], { openWeb:
 * true })`), so `open_page` may open any address: the questions never contain
 * the source URL.
 *
 * DRY (`--dry`, no key, no network): the same `runTurn` and `webSession`, with a
 * scripted model that opens the question's first URL and answers with the
 * question's fixture, and a computer that serves the fixture's page text. It
 * proves the plumbing and the scorer; it measures nothing about Tex.
 */

import { writeFile } from "node:fs/promises";
import { runTurn } from "../src/agent/turn.js";
import { BUILTIN_PROVIDER, DEFAULT_GATEWAY_MODEL } from "../src/agent/builtin.js";
import { aiGatewayConfig } from "../src/agent/aiGateway.js";
import { webSession } from "../src/agent/computer.js";
import { siteShotsComputer } from "../src/agent/browserProviders.js";
import { searcherFor } from "../src/agent/search.js";

const CHECKED = "2026-11-04T03:00Z";

/**
 * `norm` picks how an answer is read: `number` (every gold number appears),
 * `date` (the ISO date appears in any common spelling), `version` (the version
 * appears, with or without a leading v). `cite` lists URL prefixes that count
 * as the right source. `fixture` is the page text and answer the dry run uses.
 */
export const QUESTIONS = [
  {
    id: "ts-latest",
    kind: "release date (/releases/latest)",
    question: "On what date was the latest TypeScript release published on GitHub? Answer with the date and the page you read it on.",
    gold: "2026-08-20",
    norm: "date",
    cite: ["https://github.com/microsoft/TypeScript/releases/latest", "https://github.com/microsoft/TypeScript/releases/tag/v7.0.2"],
    note: "v7.0.2, published 2026-08-20T18:09:49Z. The /releases list shows a newer beta and a vscode-typescript tag above it.",
    fixture: { page: "Release TypeScript 7.0.2 · microsoft/TypeScript. Latest. Aug 20, 2026", answer: "TypeScript 7.0.2 was released on August 20, 2026." },
  },
  {
    id: "ts-releases",
    kind: "release date (/releases list)",
    question: "On GitHub's TypeScript releases list, what is the newest pre-release and on what date was it published?",
    gold: "2026-10-20",
    norm: "date",
    cite: ["https://github.com/microsoft/TypeScript/releases"],
    note: "v7.1-beta, 2026-10-20T17:38:20Z, marked Pre-release.",
    fixture: { page: "TypeScript 7.1 Beta. v7.1-beta. Pre-release. Oct 20, 2026", answer: "The newest pre-release is v7.1-beta, published 2026-10-20." },
  },
  {
    id: "notion-plus",
    kind: "pricing, monthly vs yearly",
    question: "What does Notion's Plus plan cost per seat per month when billed monthly, and per month when billed yearly, in USD?",
    gold: ["12", "10"],
    norm: "number",
    cite: ["https://www.notion.com/pricing", "https://www.notion.so/pricing"],
    note: "Page JSON: plus month unit_amount 1200, year 12000. The page shows $10 by default (yearly).",
    fixture: { page: "Plus $10 per seat/month billed annually. $12 billed monthly.", answer: "Plus is $12 per seat a month billed monthly, or $10 a month billed yearly." },
  },
  {
    id: "coda-doc-maker",
    kind: "pricing behind a redirect",
    question: "Coda's pricing page: what does the Pro plan cost per Doc Maker per month when billed monthly, in USD?",
    gold: "15",
    norm: "number",
    cite: ["https://superhuman.com/plans/docs", "https://coda.io/pricing"],
    note: "coda.io/pricing redirects to superhuman.com/plans/docs. Pro: $12 per Doc Maker billed annually, $15 billed monthly. Only Doc Makers are billed; Editors and Viewers are free.",
    fixture: { page: "Pro $12 USD / month per Doc Maker, billed annually. $15 when billed monthly.", answer: "Pro is $15 per Doc Maker per month billed monthly." },
  },
  {
    id: "vite-changelog",
    kind: "changelog date",
    question: "What is the date of the newest entry in Vite's CHANGELOG.md for the vite package?",
    gold: "2026-10-21",
    norm: "date",
    cite: ["https://github.com/vitejs/vite/blob/main/packages/vite/CHANGELOG.md", "https://raw.githubusercontent.com/vitejs/vite/main/packages/vite/CHANGELOG.md"],
    note: "8.3.5 (2026-10-21).",
    fixture: { page: "## 8.3.5 (2026-10-21)", answer: "The newest entry is 8.3.5, dated 2026-10-21." },
  },
  {
    id: "pypi-requests",
    kind: "PyPI version",
    question: "What is the latest version of the requests package on PyPI?",
    gold: "2.34.2",
    norm: "version",
    cite: ["https://pypi.org/project/requests", "https://pypi.org/pypi/requests"],
    fixture: { page: "requests 2.34.2. pip install requests", answer: "The latest is requests 2.34.2." },
  },
  {
    id: "npm-react-weekly",
    kind: "npm weekly downloads",
    question: "How many downloads did the react package have on npm last week (exact figure)?",
    gold: "244554752",
    norm: "number",
    cite: ["https://www.npmjs.com/package/react", "https://api.npmjs.org/downloads/point/last-week/react"],
    note: "Week 2026-10-27 to 2026-11-02. Changes every day: recheck on the run day or this cannot match.",
    fixture: { page: '{"downloads":244554752,"start":"2026-10-27","end":"2026-11-02","package":"react"}', answer: "react had 244,554,752 downloads last week." },
  },
  {
    id: "rpi5-clock",
    kind: "specs table value",
    question: "What is the CPU clock speed of the Raspberry Pi 5, per Raspberry Pi's product page?",
    gold: "2.4",
    norm: "number",
    cite: ["https://www.raspberrypi.com/products/raspberry-pi-5"],
    note: "BCM2712 quad-core Cortex-A76 @ 2.4GHz. The page refuses a plain fetch (403) and opens in a browser.",
    fixture: { page: "Broadcom BCM2712 quad-core Arm Cortex A76 processor @ 2.4GHz", answer: "It runs at 2.4GHz." },
  },
  {
    id: "copilot-business",
    kind: "pricing tab",
    question: "On GitHub Copilot's plans page, what does the Business plan cost per user per month in USD?",
    gold: "19",
    norm: "number",
    cite: ["https://github.com/features/copilot/plans"],
    note: "Behind the 'For businesses' tab; the individual tab shows Pro $10, Pro+ $39.",
    fixture: { page: "Business. $19 USD per user / month", answer: "Copilot Business is $19 per user per month." },
  },
  {
    id: "petstore-version",
    kind: "JS-rendered docs page",
    question: "What API version does the Swagger Petstore documentation at petstore.swagger.io show?",
    gold: "1.0.7",
    norm: "version",
    cite: ["https://petstore.swagger.io"],
    note: "Swagger UI renders in the browser; the HTML is a 1 KB shell. Same value in /v2/swagger.json info.version.",
    fixture: { page: "Swagger Petstore 1.0.7 OAS2", answer: "The Petstore docs show version 1.0.7." },
  },
  {
    id: "transformer-bleu",
    kind: "PDF figure",
    question: "In the 'Attention Is All You Need' paper, what BLEU score does Transformer (big) get on WMT 2014 English-to-German?",
    gold: "28.4",
    norm: "number",
    cite: ["https://arxiv.org/pdf/1706.03762", "https://arxiv.org/abs/1706.03762"],
    fixture: { page: "establishing a new state-of-the-art BLEU score of 28.4", answer: "Transformer (big) scores 28.4 BLEU on EN-DE." },
  },
  {
    id: "everest-elevation",
    kind: "Wikipedia infobox",
    question: "What elevation in metres does the English Wikipedia infobox give for Mount Everest?",
    gold: "8848.86",
    norm: "number",
    cite: ["https://en.wikipedia.org/wiki/Mount_Everest"],
    fixture: { page: "Elevation 8,848.86 m (29,031.7 ft)", answer: "The infobox gives 8,848.86 m." },
  },
  {
    id: "aa-first-bag",
    kind: "airline baggage fee",
    question: "On American Airlines, what is the first checked bag fee for a Main Cabin ticket within the U.S., when paid online?",
    gold: "45",
    norm: "number",
    cite: ["https://www.aa.com/i18n/travel-info/baggage/checked-baggage-policy.jsp"],
    note: "$50 at the airport, $45 online. Basic Economy is $55 / $50.",
    fixture: { page: "1st checked bag fee is $50 ($45 if you pay online)", answer: "It is $45 paid online." },
  },
  {
    id: "stripe-card",
    kind: "Stripe fee",
    question: "What is Stripe's standard US fee per successful transaction for domestic cards?",
    gold: ["2.9", "30"],
    norm: "number",
    cite: ["https://stripe.com/pricing", "https://stripe.com/us/pricing"],
    fixture: { page: "2.9% + 30¢ per successful transaction for domestic cards", answer: "2.9% + 30¢ per successful domestic card charge." },
  },
  {
    id: "cf-workers-free",
    kind: "Cloudflare limit",
    question: "How many requests per day does the Cloudflare Workers Free plan allow?",
    gold: "100000",
    norm: "number",
    cite: ["https://developers.cloudflare.com/workers/platform/limits"],
    fixture: { page: "Accounts on the Workers Free plan have a daily request limit of 100,000 requests", answer: "100,000 requests a day." },
  },
  {
    id: "opus-output-price",
    kind: "model price",
    question: "What is the output token price of Claude Opus 5.5 per million tokens on Anthropic's pricing page?",
    gold: "20",
    norm: "number",
    cite: ["https://platform.claude.com/docs/en/about-claude/pricing", "https://docs.claude.com/en/docs/about-claude/pricing", "https://www.anthropic.com/pricing"],
    note: "Input $4, output $20, 5m cache write $5, 1h $8, hits $0.20 per MTok. docs.claude.com redirects to platform.claude.com.",
    fixture: { page: "Claude Opus 5.5 | $4 / MTok | ... | Output tokens $20 / MTok", answer: "Opus 5.5 output is $20 per million tokens." },
  },
  {
    id: "node-keepalive",
    kind: "library default",
    question: "What is the default value of server.keepAliveTimeout in Node.js's http module, in milliseconds?",
    gold: "5000",
    norm: "number",
    cite: ["https://nodejs.org/api/http.html"],
    fixture: { page: "server.keepAliveTimeout Type: <number> Timeout in milliseconds. Default: 5000 (5 seconds).", answer: "The default is 5000 ms." },
  },
  {
    id: "copilot-credit",
    kind: "accordion FAQ answer",
    question: "In GitHub Copilot's plans FAQ, how much is one GitHub AI credit worth in USD?",
    gold: "0.01",
    norm: "number",
    cite: ["https://github.com/features/copilot/plans"],
    note: "In the 'Plans & pricing' FAQ tab, collapsed by default.",
    fixture: { page: "What are GitHub AI Credits? ... 1 AI credit = $0.01 USD.", answer: "One AI credit is $0.01." },
  },
  {
    id: "ruff-utc-date",
    kind: "timezone-sensitive date",
    question: "On what UTC date was the latest release of Ruff (astral-sh/ruff) published on GitHub?",
    gold: "2026-10-27",
    norm: "date",
    cite: ["https://github.com/astral-sh/ruff/releases"],
    note: "0.17.3 at 2026-10-27T00:35:07Z, which GitHub shows as Oct 26 to a viewer in any US time zone.",
    fixture: { page: "0.17.3 Latest. 2026-10-27T00:35:07Z", answer: "Ruff 0.17.3 was published on 2026-10-27 (UTC)." },
  },
  {
    id: "spiegel-hrb",
    kind: "cookie-wall site",
    question: "Per DER SPIEGEL's Impressum, what is the commercial register number (HRB) of its general partner (Komplementärin)?",
    gold: "13105",
    norm: "number",
    cite: ["https://www.spiegel.de/impressum"],
    note: "HRB 13 105, Hamburg. spiegel.de loads a Sourcepoint consent frame (seen from a US check on the homepage; shown as a wall to EU visitors).",
    fixture: { page: "Komplementärin ... GmbH, Sitz und Registergericht Hamburg, HRB 13 105", answer: "It is HRB 13 105 (Hamburg)." },
  },
].map((q) => ({ ...q, checked: CHECKED }));

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Every number in the text, thousands separators (",", " ", narrow spaces) removed, as canonical strings. */
function numbersIn(text) {
  return [...text.matchAll(/\d{1,3}(?:[,   ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((m) => String(Number(m[0].replace(/[,   ]/g, ""))));
}

/** Every date in the text as YYYY-MM-DD: ISO, "Oct 27, 2026", "27 October 2026". */
function datesIn(text) {
  const pad = (n) => String(n).padStart(2, "0");
  const out = [...text.matchAll(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g)].map((m) => `${m[1]}-${pad(m[2])}-${pad(m[3])}`);
  for (const m of text.matchAll(/([a-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})/gi)) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month >= 0) out.push(`${m[3]}-${pad(month + 1)}-${pad(m[2])}`);
  }
  for (const m of text.matchAll(/(\d{1,2})(?:st|nd|rd|th)?\.? ([a-z]{3})[a-z]*\.?,? (\d{4})/gi)) {
    const month = MONTHS.indexOf(m[2].toLowerCase());
    if (month >= 0) out.push(`${m[3]}-${pad(month + 1)}-${pad(m[1])}`);
  }
  return out;
}

/** Every dotted version in the text, without a leading v. */
function versionsIn(text) {
  return [...text.matchAll(/v?(\d+(?:\.\d+)+)/gi)].map((m) => m[1]);
}

export const NORMALIZERS = { number: numbersIn, date: datesIn, version: versionsIn };

/** One answered turn against its question. */
export function scoreAnswer(q, turn, ms) {
  const answer = typeof turn?.answer === "string" ? turn.answer : "";
  const found = new Set(NORMALIZERS[q.norm](answer));
  const gold = Array.isArray(q.gold) ? q.gold : [q.gold];
  const steps = Array.isArray(turn?.steps) ? turn.steps : [];
  const urls = [...(answer.match(/https?:\/\/[^\s)\]>"']+/g) ?? []), ...steps.flatMap((s) => (Array.isArray(s.sources) ? s.sources : []))];
  const bare = (url) => url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/.,;]+$/, "");
  return {
    id: q.id,
    exact: gold.every((value) => found.has(value)),
    cited: urls.some((url) => q.cite.some((prefix) => bare(url).startsWith(bare(prefix)))),
    browser: steps.some((s) => s.tool === "browse"),
    ms,
    tokens: (turn?.usage?.input ?? 0) + (turn?.usage?.output ?? 0),
    tools: steps.map((s) => s.tool),
    answer,
  };
}

/** The dry run's model: open the question's first source, then answer with the fixture and that URL. */
function scriptedModel(q) {
  const reply = (content, stop) =>
    new Response(JSON.stringify({ content, stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 20 } }), { headers: { "content-type": "application/json" } });
  return async (_url, init) => {
    const last = JSON.parse(init.body).messages.at(-1);
    const answered = Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result");
    return answered
      ? reply([{ type: "text", text: `${q.fixture.answer} Source: ${q.cite[0]}` }], "end_turn")
      : reply([{ type: "tool_use", id: "toolu_dry", name: "open_page", input: { url: q.cite[0] } }], "tool_use");
  };
}

/** A page read with a plain fetch, in `readPage`'s shape: for a live run without SITE_SHOTS_URL. */
async function fetchPage(url) {
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (bench webExact)" }, redirect: "follow" });
  if (!response.ok) throw new Error(`page ${response.status}`);
  const html = await response.text();
  const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { url: response.url, title: html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? "", text: text.slice(0, 60_000), truncated: text.length > 60_000, links: [] };
}

/** The computer a live run gets: the product's (through a local site-shots) or a plain-fetch reader. */
function liveComputer(env) {
  if (!env.SITE_SHOTS_URL) return { provider: "fetch", readPage: fetchPage };
  const base = env.SITE_SHOTS_URL.replace(/\/$/, "");
  const SITE_SHOTS = { fetch: (url, init) => fetch(`${base}${new URL(url).pathname}`, init) };
  return siteShotsComputer({ ...env, SITE_SHOTS }, {});
}

/** Asks one question through `runTurn` and scores it. */
export async function askOne(q, { dry, env }) {
  const computer = dry ? { provider: "fixture", readPage: async (url) => ({ url, title: q.id, text: q.fixture.page, truncated: false, links: [] }) } : liveComputer(env);
  const opened = webSession(computer, q.question, { search: dry ? null : searcherFor(env) });
  opened.trust([], { openWeb: true });
  const turnEnv = dry
    ? { AGENT_BUILTIN_MODEL: DEFAULT_GATEWAY_MODEL, AI_GATEWAY_ACCOUNT_ID: "0".repeat(32), AI_GATEWAY_ID: "bench", AI_GATEWAY_TOKEN: "bench-gateway-token-not-a-real-one" }
    : { ...env, AGENT_BUILTIN_MODEL: env.WEB_EXACT_MODEL ?? DEFAULT_GATEWAY_MODEL };
  const started = Date.now();
  try {
    const turn = await runTurn({
      question: q.question,
      credential: { provider: BUILTIN_PROVIDER, apiKey: null },
      tools: opened.tools,
      env: turnEnv,
      providerOptions: { gateway: aiGatewayConfig(turnEnv), ...(dry ? { fetchImpl: scriptedModel(q) } : {}) },
      texting: true,
      callTool: (name, args) => opened.call(name, args),
    });
    return scoreAnswer(q, turn, Date.now() - started);
  } catch (error) {
    // A failed turn is a row, not a crash: the rest of the set still runs.
    return { ...scoreAnswer(q, null, Date.now() - started), error: String(error?.message ?? error) };
  } finally {
    await opened.close?.();
  }
}

/** Runs the set (or `only` of it) one question at a time and returns the rows and totals. */
export async function runSet({ dry = false, only = null, env = process.env } = {}) {
  const rows = [];
  for (const q of QUESTIONS.filter((x) => only === null || only.includes(x.id))) rows.push(await askOne(q, { dry, env }));
  const count = (key) => rows.filter((r) => r[key]).length;
  return { dry, at: new Date().toISOString(), rows, exact: count("exact"), cited: count("cited"), browser: count("browser"), of: rows.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const dry = args.includes("--dry");
  if (!dry && aiGatewayConfig(process.env) === null) {
    process.stderr.write("Set AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN, and BRAVE_SEARCH_API_KEY (see this file's header), or pass --dry.\n");
    process.exit(1);
  }
  const result = await runSet({ dry, only: flag("--only")?.split(",") ?? null });
  for (const r of result.rows) {
    process.stdout.write(`${r.id.padEnd(20)} exact=${r.exact ? "Y" : "n"} cited=${r.cited ? "Y" : "n"} browser=${r.browser ? "Y" : "n"} ${String(r.ms).padStart(6)}ms ${String(r.tokens).padStart(7)}tok ${r.error ?? ""}\n`);
  }
  process.stdout.write(`exact ${result.exact}/${result.of}, cited ${result.cited}/${result.of}, browser ${result.browser}/${result.of}\n`);
  if (flag("--out")) await writeFile(flag("--out"), JSON.stringify(result, null, 2));
}
