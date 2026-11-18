#!/usr/bin/env node
/**
 * Are published websites still drawn, and still drawn with their own look?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Websites have gone unstyled or blank in production more than once, each
 * time through a different path: the design left out of the copy the edge
 * keeps for signed-out visitors (#1201), a stylesheet dropped while the
 * tree's facts lagged its note (#2335), a nested Website folder judged
 * private (#2053, #2098, #2102), a half-saved page answered "Nothing here"
 * (#944, #951). Every one passed its unit tests and was found by a person
 * looking at a site. This asks the way a visitor does, from outside, so the
 * next one is found by a red run instead.
 *
 * ── WHAT IT ASKS ───────────────────────────────────────────────────────────
 *
 * For each site in `SITES`, at `<handle>.ctxlc.site`:
 *
 *   1. The document: a 200 HTML shell with the app's root and its script, and
 *      no enforced style policy that would refuse the `<style>` a designed
 *      page draws its look with (`DesignedSite.web.tsx`).
 *   2. The app's script, from the site's own host: a site whose bundle does
 *      not load is a blank page however healthy its answers are.
 *   3. The home page's answer (`/_site/page?path=/`, exactly what the app
 *      asks): a page, not "unavailable"; with words or a layout to draw, so
 *      it is not blank; and, for a site that has a design, with its CSS.
 *   4. The same for every page the home page's menu names (up to
 *      `MAX_PAGES`), so a page that went missing from a working site is red.
 *      A members-only page ("authentication_required") is present, not
 *      missing.
 *
 * And for context.lc, that the homepage loads: a 200 HTML shell with the
 * app's root and its script. The homepage draws its own pages and is not
 * linked to the @context-lc site (decided by Seyi, 2026-11-18), so a document
 * that carries no site is the expected state, not a failure. If a site is
 * embedded (`homeSite.ts`), it must still be one the app can draw.
 *
 * ── WHAT "HONEST" MEANS HERE ───────────────────────────────────────────────
 *
 * As in `health-check-gateway.mjs`: no retry that averages a failure away,
 * a 200 is checked for what it claims to be, and `--self-test` runs first
 * and proves every check can still go red, against synthetic answers, with
 * no network.
 *
 * Only public addresses are asked, with no credential and no cookie: what
 * this reads is what anyone on the internet reads.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *
 *   node scripts/health-check-sites.mjs [--sites-domain ctxlc.site] [--home https://context.lc]
 *   node scripts/health-check-sites.mjs --self-test
 */

import { fileURLToPath } from "node:url";

const DEFAULT_SITES_DOMAIN = "ctxlc.site";
const DEFAULT_HOME = "https://context.lc";

/**
 * Sites watched, each one a real published website its owner keeps on.
 * `styled: true` says the site has a design (stylesheets, a frame or
 * layouts), so a page answered without one is red. Add a site here when it
 * matters that it stays up; a site turned off on purpose comes out in the
 * same pull request.
 */
export const SITES = [
  // Nested Website folder, all-HTML pages and a stylesheet.
  { handle: "seyi", styled: true },
  // Layouts (`chapter`, `cover`), a frame and two stylesheets.
  { handle: "public-worship", styled: true },
];

/** Pages per site past the home page. */
const MAX_PAGES = 12;
const TIMEOUT_MS = 15_000;

const KINDS = new Set(["page", "authentication_required", "unavailable", "legacy_short_link"]);

function asJson(body) {
  try {
    const json = JSON.parse(body);
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      return { problem: "body parsed but is not a JSON object" };
    }
    return { json };
  } catch {
    const opening = body.slice(0, 80).replace(/\s+/g, " ").trim();
    return { problem: `body is not JSON (starts: ${JSON.stringify(opening)})` };
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The directive a browser applies to a `<style>` element, from an enforced
 * policy: `style-src-elem`, else `style-src`, else `default-src`.
 */
export function styleElementSources(policy) {
  if (!nonEmpty(policy)) return null;
  const directives = new Map();
  for (const part of policy.split(",").join(";").split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!directives.has(key)) directives.set(key, sources);
  }
  return directives.get("style-src-elem") ?? directives.get("style-src") ?? directives.get("default-src") ?? null;
}

/**
 * Problems with the document a site's address answers. Exported for the
 * self-test and for the router's own test of the same rule.
 */
export function checkSiteDocument({ status, headers, body }) {
  if (status !== 200) return [`document: expected 200, got ${status}`];
  const problems = [];
  const type = headers.get("content-type") ?? "";
  if (!type.includes("text/html")) problems.push(`document: content type is ${JSON.stringify(type)}, not HTML`);
  if (!body.includes('id="root"')) problems.push("document: no app root (`id=\"root\"`), so nothing can draw");
  if (scriptOf(body) === null) problems.push("document: names no app script under /_expo/");
  // A nonce or a hash makes a browser ignore 'unsafe-inline', so either one
  // refuses the design's <style> element as surely as leaving it out.
  const sources = styleElementSources(headers.get("content-security-policy"));
  if (sources !== null) {
    const inline = sources.includes("'unsafe-inline'");
    const pinned = sources.some((source) => /^'(?:nonce|sha256|sha384|sha512)-/i.test(source));
    if (!inline || pinned) {
      problems.push(
        "document: the enforced Content-Security-Policy refuses inline <style>, " +
          "so every designed page would draw unstyled",
      );
    }
  }
  return problems;
}

/** The app script the shell loads, or null. */
export function scriptOf(body) {
  const match = /<script[^>]+src="(\/_expo\/static\/js\/[^"]+\.js)"/.exec(body);
  return match ? match[1] : null;
}

/**
 * Problems with one page's answer. `styled` says the site has a design, so
 * an answer without one is the site gone unstyled.
 */
export function checkPageAnswer({ status, body }, { label, styled }) {
  if (status !== 200) return [`${label}: expected 200, got ${status}`];
  const { json, problem } = asJson(body);
  if (problem) return [`${label}: ${problem}`];
  if (!KINDS.has(json.kind)) return [`${label}: answer kind ${JSON.stringify(json.kind)} is not one the app draws`];
  if (json.kind === "unavailable") return [`${label}: answered "unavailable", the page is missing`];
  if (json.kind !== "page") return [];
  const problems = [];
  const design = json.design && typeof json.design === "object" ? json.design : null;
  const drawable = nonEmpty(json.markdown) || nonEmpty(design?.template) || nonEmpty(design?.frame);
  if (!drawable) problems.push(`${label}: page has no words and no layout, so it draws blank`);
  if (styled) {
    if (design === null) problems.push(`${label}: page came without its design, so it draws unstyled`);
    else if (!nonEmpty(design.css) && !nonEmpty(design.frame) && !nonEmpty(design.template)) {
      problems.push(`${label}: page's design is empty, so it draws unstyled`);
    }
  }
  return problems;
}

/** The menu's addresses, each once, in order. */
export function menuPaths(body) {
  const { json } = asJson(body);
  const items = Array.isArray(json?.navigation) ? json.navigation : [];
  const paths = [];
  for (const item of items) {
    const path = item?.routePath;
    if (typeof path === "string" && path.startsWith("/") && path !== "/" && !paths.includes(path)) paths.push(path);
  }
  return paths.slice(0, MAX_PAGES);
}

/**
 * Problems with context.lc's homepage document. The homepage draws its own
 * pages, so no embedded site is expected; what must hold is that it loads.
 */
export function checkHomeDocument({ status, headers, body }) {
  if (status !== 200) return [`context.lc: expected 200, got ${status}`];
  const problems = [];
  const type = headers?.get("content-type") ?? "";
  if (!type.includes("text/html")) problems.push(`context.lc: content type is ${JSON.stringify(type)}, not HTML`);
  if (!body.includes('id="root"')) problems.push("context.lc: no app root (`id=\"root\"`), so nothing can draw");
  if (scriptOf(body) === null) problems.push("context.lc: names no app script under /_expo/");
  const match = /<script type="application\/json" id="context-home-site">([\s\S]*?)<\/script>/.exec(body);
  if (match) {
    const { json, problem } = asJson(match[1]);
    if (problem) problems.push(`context.lc: the homepage's embedded site is not JSON (${problem})`);
    else if (!Array.isArray(json.pages) || json.pages.length === 0) problems.push("context.lc: the homepage's embedded site has no pages");
  }
  return problems;
}

async function ask(fetchImpl, url, accept) {
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: accept, "User-Agent": "context-site-health" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: response.status, headers: response.headers, body: await response.text() };
  } catch (error) {
    return { status: 0, headers: new Headers(), body: "", error: String(error?.message ?? error) };
  }
}

function failed(label, answer) {
  return answer.status === 0 ? [`${label}: request failed (${answer.error})`] : null;
}

/** Every problem across every site, as lines. Empty means every check ran and held. */
export async function checkSites({ fetchImpl = fetch, sitesDomain = DEFAULT_SITES_DOMAIN, home = DEFAULT_HOME, sites = SITES } = {}) {
  const problems = [];
  for (const site of sites) {
    const origin = `https://${site.handle}.${sitesDomain}`;
    const prefix = (lines) => lines.map((line) => `${site.handle}: ${line}`);

    const document = await ask(fetchImpl, `${origin}/`, "text/html");
    const documentProblems = failed("document", document) ?? checkSiteDocument(document);
    problems.push(...prefix(documentProblems));
    const script = document.status === 200 ? scriptOf(document.body) : null;
    if (script !== null) {
      const bundle = await ask(fetchImpl, `${origin}${script}`, "*/*");
      const bad = failed("app script", bundle) ?? (bundle.status === 200 ? [] : [`app script: expected 200, got ${bundle.status}`]);
      problems.push(...prefix(bad));
    }

    const pageUrl = (path) => `${origin}/_site/page?${new URLSearchParams({ path }).toString()}`;
    const homeAnswer = await ask(fetchImpl, pageUrl("/"), "application/json");
    problems.push(...prefix(failed("page /", homeAnswer) ?? checkPageAnswer(homeAnswer, { label: "page /", styled: site.styled })));
    if (homeAnswer.status !== 200) continue;
    for (const path of menuPaths(homeAnswer.body)) {
      const answer = await ask(fetchImpl, pageUrl(path), "application/json");
      const label = `page ${path}`;
      problems.push(...prefix(failed(label, answer) ?? checkPageAnswer(answer, { label, styled: site.styled })));
    }
  }
  if (home !== null) {
    const answer = await ask(fetchImpl, `${home}/`, "text/html");
    problems.push(...(failed("context.lc", answer) ?? checkHomeDocument(answer)));
  }
  return problems;
}

// ── Self-test ──────────────────────────────────────────────────────────────

const SHELL = '<html><head></head><body><div id="root"></div><script src="/_expo/static/js/web/entry-abc.js" defer></script></body></html>';
const HOME_SHELL = SHELL;
const HOME_SHELL_WITH_SITE = SHELL.replace(
  "<head></head>",
  `<head><script type="application/json" id="context-home-site">${JSON.stringify({ pages: [{ path: "website/index.md" }] })}</script></head>`,
);
const STYLED_PAGE = {
  kind: "page",
  markdown: "# Hello",
  navigation: [{ title: "About", routePath: "/about" }, { title: "Members", routePath: "/members" }],
  design: { frame: "<main>{ content }</main>", template: null, css: ".ctx-site h1{color:red}", fonts: [] },
};

function fakeFetch(routes) {
  return async (url) => {
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    if (route instanceof Error) throw route;
    const { status = 200, type = "application/json", body = "", headers = {} } = route;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": type, ...headers },
    });
  };
}

function healthyRoutes() {
  const origin = "https://good.ctxlc.site";
  return {
    [`${origin}/`]: { type: "text/html; charset=utf-8", body: SHELL },
    [`${origin}/_expo/static/js/web/entry-abc.js`]: { type: "application/javascript", body: "1" },
    [`${origin}/_site/page?path=%2F`]: { body: STYLED_PAGE },
    [`${origin}/_site/page?path=%2Fabout`]: { body: { ...STYLED_PAGE, markdown: "About us" } },
    [`${origin}/_site/page?path=%2Fmembers`]: { body: { kind: "authentication_required", navigation: [] } },
    "https://home.test/": { type: "text/html", body: HOME_SHELL },
  };
}

async function selfTest() {
  const sites = [{ handle: "good", styled: true }];
  const run = (routes) => checkSites({ fetchImpl: fakeFetch(routes), home: "https://home.test", sites });
  const cases = [];
  const expect = async (name, routes, pattern) => {
    const problems = await run(routes);
    const ok = pattern === null ? problems.length === 0 : problems.some((line) => pattern.test(line));
    cases.push({ name, ok, problems });
  };

  await expect("a healthy site is green", healthyRoutes(), null);
  {
    const routes = healthyRoutes();
    routes["https://good.ctxlc.site/_site/page?path=%2Fabout"] = { body: { ...STYLED_PAGE, design: undefined } };
    await expect("a page without its design is red", routes, /about: page came without its design/);
  }
  {
    const routes = healthyRoutes();
    routes["https://good.ctxlc.site/_site/page?path=%2F"] = { body: { ...STYLED_PAGE, design: { ...STYLED_PAGE.design, css: "", frame: null } } };
    await expect("an empty design is red", routes, /page \/: page's design is empty/);
  }
  {
    const routes = healthyRoutes();
    routes["https://good.ctxlc.site/_site/page?path=%2Fabout"] = { body: { kind: "unavailable", navigation: [] } };
    await expect("a menu page gone missing is red", routes, /about: answered "unavailable"/);
  }
  {
    const routes = healthyRoutes();
    routes["https://good.ctxlc.site/_site/page?path=%2F"] = { body: { ...STYLED_PAGE, markdown: "", design: { css: "x{}", frame: null, template: null } } };
    await expect("a page with nothing to draw is red", routes, /draws blank/);
  }
  {
    const routes = healthyRoutes();
    routes["https://good.ctxlc.site/"] = { type: "text/html", body: SHELL, headers: { "Content-Security-Policy": "default-src 'self'; style-src 'self' 'nonce-abc'" } };
    await expect("an enforced style policy with a nonce is red", routes, /refuses inline <style>/);
  }
  {
    const routes = healthyRoutes();
    routes["https://good.ctxlc.site/"] = { type: "text/html", body: SHELL, headers: { "Content-Security-Policy": "frame-ancestors 'none'; form-action 'self'" } };
    await expect("a policy that leaves style alone is green", routes, null);
  }
  {
    const routes = healthyRoutes();
    delete routes["https://good.ctxlc.site/_expo/static/js/web/entry-abc.js"];
    await expect("a bundle that does not load on the site's host is red", routes, /app script: expected 200, got 404/);
  }
  {
    const routes = healthyRoutes();
    routes["https://good.ctxlc.site/"] = { type: "text/html", body: "<html>parked</html>" };
    await expect("a 200 that is not the app is red", routes, /no app root/);
  }
  {
    const routes = healthyRoutes();
    routes["https://good.ctxlc.site/_site/page?path=%2F"] = new Error("connection reset");
    await expect("a request that fails is red", routes, /page \/: request failed/);
  }
  {
    const routes = healthyRoutes();
    routes["https://good.ctxlc.site/_site/page?path=%2F"] = { status: 503, body: "{}" };
    await expect("a 503 is red", routes, /page \/: expected 200, got 503/);
  }
  {
    // The homepage draws its own pages: no embedded site is the expected state.
    const routes = healthyRoutes();
    routes["https://home.test/"] = { type: "text/html", body: HOME_SHELL };
    await expect("a homepage drawing its own pages is green", routes, null);
  }
  {
    const routes = healthyRoutes();
    routes["https://home.test/"] = { type: "text/html", body: HOME_SHELL_WITH_SITE };
    await expect("a homepage with a drawable embedded site is green", routes, null);
  }
  {
    const routes = healthyRoutes();
    routes["https://home.test/"] = { status: 502, type: "text/html", body: "bad gateway" };
    await expect("a homepage that does not load is red", routes, /context\.lc: expected 200, got 502/);
  }
  {
    const routes = healthyRoutes();
    routes["https://home.test/"] = new Error("connection reset");
    await expect("a homepage request that fails is red", routes, /context\.lc: request failed/);
  }
  {
    const routes = healthyRoutes();
    routes["https://home.test/"] = { type: "text/html", body: "<html>parked</html>" };
    await expect("a homepage 200 that is not the app is red", routes, /context\.lc: no app root/);
  }
  {
    const routes = healthyRoutes();
    routes["https://home.test/"] = { type: "text/html", body: SHELL.replace("<head></head>", '<head><script type="application/json" id="context-home-site">{"pages":[]}</script></head>') };
    await expect("a homepage with an empty embedded site is red", routes, /embedded site has no pages/);
  }

  let failures = 0;
  for (const result of cases) {
    console.log(`${result.ok ? "ok  " : "FAIL"} ${result.name}`);
    if (!result.ok) {
      failures++;
      console.log(`     got: ${JSON.stringify(result.problems)}`);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} self-test case(s) failed: the probe no longer catches what it claims to.`);
    process.exit(1);
  }
  console.log(`\nself-test: ${cases.length} cases, every one as expected.`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function main() {
  if (process.argv.includes("--self-test")) return await selfTest();
  const sitesDomain = argument("--sites-domain") ?? DEFAULT_SITES_DOMAIN;
  const home = argument("--home") ?? DEFAULT_HOME;
  if (!/^[a-z0-9.-]+$/.test(sitesDomain) || !/^https:\/\/[a-z0-9.-]+$/.test(home)) {
    console.error("--sites-domain must be a hostname and --home an https origin");
    process.exit(2);
  }
  const problems = await checkSites({ sitesDomain, home });
  if (problems.length > 0) {
    console.error(`Websites are not being drawn as published (${problems.length}):`);
    for (const line of problems) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log(`Every watched site answered, drawn and styled (${SITES.map((site) => site.handle).join(", ")}, and context.lc).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
