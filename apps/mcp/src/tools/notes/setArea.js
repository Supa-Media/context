/**
 * `manage area` (`set_area`): an area's settings, its metric, its bots and a person's delegate, changed in one call
 * (Dev2, 2026-11-25: "someone should be able to make updates to the areas, the area settings, assign metrics, update
 * bot configs easily through tex or through the mcp"). Everything here is front matter the app's area panel writes
 * too (`apps/mobile/features/console/files/folderPage/areas/seat.ts`), so the two never disagree:
 *
 *   - the area's `about.md`: owner, helper, modes, approvals and its one metric (`metrics: [<name> · target <x>]`,
 *     with any older `metric:` and `target:` lines taken away, since they would win over it);
 *   - a holder's card in the areas' `people/` folder: a bot's `bot`, `belongs_to` and `reach`, a person's `delegation`;
 *   - the areas' own `about.md` `agents:` list, for a bot named for the first time.
 *
 * A webhook is the one thing that is not a note: it goes sealed to the control plane (`/gateway/bots/hook`,
 * `apps/convex/functions/botHooks.ts`), and the answer names only its host and its header's last four characters.
 * Every note is read and written at this connection's own clearance, with the version it read, so a concurrent edit
 * is caught and an area it cannot see answers like one that does not exist.
 */

import areaBots from "../../../../../packages/shared/src/areaBots.cjs";
import { setNoteProperty } from "../../lists/setProperty.js";
import { normalizePath } from "../../notes/paths.js";
import { factJobs, factProps } from "../../tree/facts.js";
import { isVisibleTextFile } from "../../orient/survey.js";
import { toolError, toolText } from "../results.js";
import { toolReadNote } from "./read.js";
import { toolWriteNote } from "./write.js";
import { attachProjects } from "./attachProjects.js";

const { BOT_KINDS, MODE_ORDER, botLabel, knownModes, mailJoinName } = areaBots;

const REACHES = new Set(["webhook", "mail"]);
const MAX_RULES = 20;
const MAX_TEXT = 300;

const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? "").join("\n");

/** `@dev2` → `dev2`, `Finance Bot` → `finance-bot`: the note a holder's card is kept under, as the app names it. */
export function cardSlug(holder) {
  const slug = String(holder ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "someone" : slug;
}

/** The app's metric line: no commas inside, a thousands comma dropped (`seat.ts` `metricLine`). */
export function metricLine(name, target) {
  const plain = String(name ?? "").trim().replace(/,/g, "");
  const goal = String(target ?? "").trim().replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/,/g, "");
  return goal === "" ? plain : `${plain} · target ${goal}`;
}

const metricKey = (name) => String(name ?? "").trim().replace(/,/g, "").replace(/\s+/g, " ").toLowerCase();

/** A note as this connection reads it: `{path, etag, body}`, `{missing}` when it is not there for it, or `{error}`. */
async function openNote(store, scope, rules, overrides, path) {
  const result = await toolReadNote(store, scope, rules, overrides, path);
  const text = textOf(result);
  if (result.isError) {
    if (/^(not found|no note)/i.test(text) || /not found/i.test(text)) return { missing: true };
    return { error: text };
  }
  const split = text.indexOf("\n\n");
  const header = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? "" : text.slice(split + 2);
  const etag = /^etag:\s*(\S+)/m.exec(header)?.[1];
  return { path, etag, body };
}

/** Applies `[key, value]` changes to one note (made when `create`), with one retry on a concurrent edit. */
async function change(store, scope, rules, overrides, path, changes, { create = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const opened = await openNote(store, scope, rules, overrides, path);
    if (opened.error) return { error: `${path}: ${opened.error}. Check the area's path with orient { area }, then try again.` };
    if (opened.missing && !create) return { error: `${path} isn't there, or this connection can't see it. Check the area with orient { area }, or pass create: true to make a sub-area.` };
    let text = opened.missing ? "" : opened.body;
    for (const [key, value] of changes) {
      const next = setNoteProperty(text, key, value);
      if (next.error) return { error: `${path}: ${next.error}. Fix that note's front matter with write, then try again.` };
      text = next.text;
    }
    if (!opened.missing && text === opened.body) return { unchanged: true };
    const written = await toolWriteNote(store, scope, rules, overrides, { path, content: text, ...(opened.etag ? { expected_etag: opened.etag } : {}) });
    if (written.isError && textOf(written).startsWith("conflict") && attempt === 0) continue;
    if (written.isError) return { error: `${path}: ${textOf(written)}. Read the note, then try again.` };
    return { wrote: true, created: opened.missing === true };
  }
  return { error: `${path} kept changing, so nothing more was written. Wait a moment, then try again.` };
}

/** The workspace's metrics, by name, from the data folder's `metrics/` notes this connection can see. */
async function metricNames(store, scope, rules, overrides) {
  if (typeof store?.treeEntries !== "function") return null;
  const entries = (await store.treeEntries().catch(() => [])).filter(
    ({ key }) => /(^|\/)metrics\/[^/]+\.md$/.test(key) && isVisibleTextFile(key, scope, rules, overrides),
  );
  const props = await factProps(store, entries.map(({ key }) => key));
  if (props === null) return null;
  const names = [];
  for (const [, fact] of props) {
    const name = typeof fact?.props?.properties?.metric === "string" ? fact.props.properties.metric.trim() : "";
    if (name !== "") names.push(name);
  }
  return names;
}

function oneLine(value, what) {
  if (value === undefined) return { skip: true };
  if (value === null || value === "") return { value: null };
  if (typeof value !== "string" || /[\r\n]/.test(value) || value.trim().length > MAX_TEXT) return { error: `${what} is one line of text. Pass it on one line, then try again.` };
  return { value: value.trim() };
}

/**
 * @param {any} store the routed store; `store.botHooks(request)` reaches the control plane where it is bound.
 * @param {string} scope
 * @param {any} rules
 * @param {any} overrides
 * @param {Record<string, any>} args
 */
export async function toolSetArea(store, scope, rules, overrides, args) {
  const area = normalizePath(String(args?.area ?? "").replace(/\/about\.md$/i, "").replace(/\/+$/, ""));
  if (!area) return toolError('invalid: area is the area\'s folder. Pass it like "areas/finance".');
  const jobs = await factJobs(store);
  const root = jobs?.jobs?.areas ?? area.split("/")[0];
  if (area !== root && !area.startsWith(`${root}/`)) return toolError(`invalid: ${area} is not under the areas folder (${root}/). Pass an area under ${root}/, as orient { area } lists them.`);
  const done = [];
  const problems = [];

  // The area's own settings.
  const seat = [];
  for (const key of ["owner", "helper"]) {
    const line = oneLine(args[key], key);
    if (line.error) return toolError(`invalid: ${key} is a person's @handle or a bot's name, on one line. Pass it that way, then try again.`);
    if (!line.skip) seat.push([key, line.value]);
  }
  if (args.modes !== undefined) {
    const asked = Array.isArray(args.modes) ? args.modes : [];
    const modes = knownModes(asked);
    if (modes.length !== asked.length) return toolError(`invalid: modes are ${MODE_ORDER.join(", ")}. Pick from those, then try again.`);
    seat.push(["modes", modes.length === 0 ? null : modes]);
  }
  if (args.approvals !== undefined) {
    const rules_ = Array.isArray(args.approvals) ? args.approvals.map((rule) => String(rule ?? "").trim()).filter((rule) => rule !== "") : null;
    if (rules_ === null || rules_.length > MAX_RULES || rules_.some((rule) => rule.length > MAX_TEXT || /[\r\n]/.test(rule))) {
      return toolError(`invalid: approvals is a list of up to ${MAX_RULES} one-line rules. Pass them as a list, one rule each.`);
    }
    seat.push(["approvals", rules_.length === 0 ? null : rules_]);
  }
  if (args.metric !== undefined) {
    // One metric per area (Dev2: a second number is a sub-area).
    if (args.metric === null || args.metric?.name === null || args.metric?.name === "") {
      seat.push(["metrics", null], ["metric", null], ["target", null]);
    } else {
      const name = typeof args.metric?.name === "string" ? args.metric.name.trim() : "";
      if (name === "") return toolError("invalid: metric is { name, target? }. Pass the name of a metric in the data folder's metrics/.");
      const known = await metricNames(store, scope, rules, overrides);
      const match = known?.find((existing) => metricKey(existing) === metricKey(name));
      if (known !== null && match === undefined) {
        return toolError(
          known.length === 0
            ? `no metric named "${name}": this workspace has no metrics yet; write one in the data folder's metrics/ first`
            : `no metric named "${name}"; the metrics here are: ${known.join(", ")}`,
        );
      }
      seat.push(["metrics", [metricLine(match ?? name, args.metric.target)]], ["metric", null], ["target", null]);
    }
  }
  if (seat.length > 0) {
    const wrote = await change(store, scope, rules, overrides, `${area}/about.md`, seat, { create: area !== root && args.create === true });
    if (wrote.error) return toolError(wrote.error);
    done.push(wrote.unchanged ? `${area}: already so` : `${area}: set ${seat.map(([key]) => key).filter((key) => key !== "metric" && key !== "target").join(", ")}`);
  }

  // A bot: its card, and its name on the agents list.
  if (args.bot !== undefined) {
    const bot = args.bot ?? {};
    const name = typeof bot.name === "string" ? bot.name.trim() : "";
    if (name === "" || name.startsWith("@") || name.length > 60) return toolError("invalid: bot.name is the bot's name, not an @handle. Pass it like Finance.");
    const kind = bot.kind === undefined ? "grok" : String(bot.kind).toLowerCase();
    if (!BOT_KINDS.includes(kind)) return toolError(`invalid: bot.kind is one of ${BOT_KINDS.join(", ")}. Pick one, or leave it out for grok.`);
    if (bot.reach !== undefined && !REACHES.has(bot.reach)) return toolError('invalid: bot.reach is "webhook" or "mail". Pick one, then try again.');
    const whose = bot.whose === undefined ? undefined : String(bot.whose).trim();
    if (whose !== undefined && whose !== "" && !/^@[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(whose)) return toolError("invalid: bot.whose is the @handle of the person it belongs to. Pass it like @seyi.");
    const card = [["holder", name], ["kind", "agent"], ["bot", kind]];
    if (whose !== undefined) card.push(["belongs_to", whose === "" ? null : whose]);
    if (bot.reach !== undefined) card.push(["reach", bot.reach]);
    const people = `${root}/people`;
    const peopleAbout = await openNote(store, scope, rules, overrides, `${people}/about.md`);
    if (peopleAbout.missing) await change(store, scope, rules, overrides, `${people}/about.md`, [["area", "false"]], { create: true });
    const wrote = await change(store, scope, rules, overrides, `${people}/${cardSlug(name)}.md`, card, { create: true });
    if (wrote.error) return toolError(wrote.error);
    const listing = await openNote(store, scope, rules, overrides, `${root}/about.md`);
    const agents = (await factProps(store, [`${root}/about.md`]))?.get(`${root}/about.md`)?.props?.properties?.agents;
    const have = Array.isArray(agents) ? agents.map(String) : typeof agents === "string" ? agents.split(",").map((item) => item.trim()).filter(Boolean) : [];
    if (!have.some((agent) => agent.toLowerCase() === name.toLowerCase()) && !listing.error) {
      const added = await change(store, scope, rules, overrides, `${root}/about.md`, [["agents", [...have, name]]], { create: true });
      if (added.error) problems.push(added.error);
    }
    done.push(`${name}: ${botLabel(kind)}${whose ? ` of ${whose}` : ""}${bot.reach ? `, reached by ${bot.reach === "webhook" ? "its webhook" : "checking its mail"}` : ""} (card ${people}/${cardSlug(name)}.md)`);
  }

  // A person's delegate: who answers for them.
  if (args.delegate !== undefined) {
    const person = typeof args.delegate?.person === "string" ? args.delegate.person.trim() : "";
    if (!/^@[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(person)) return toolError("invalid: delegate is { person: \"@handle\", to: \"<bot name>\" | \"Tex\" | null }. Pass the person as an @handle.");
    const to = args.delegate.to === null || args.delegate.to === "" ? null : String(args.delegate.to ?? "").trim();
    if (to !== null && (to.length > 60 || /[\r\n]/.test(to))) return toolError("invalid: delegate.to is a bot's name, Tex, or null. Pass one of those.");
    const wrote = await change(store, scope, rules, overrides, `${root}/people/${cardSlug(person)}.md`, [["holder", person], ["kind", "person"], ["delegation", to]], { create: true });
    if (wrote.error) return toolError(wrote.error);
    done.push(to === null ? `${person}: nobody answers for them` : `${person}: ${to} answers for them`);
  }

  // A webhook, sealed by the control plane; never echoed.
  const hookBot = args.webhook?.bot ?? args.bot?.name ?? args.test_webhook;
  if (args.webhook !== undefined || args.test_webhook !== undefined) {
    if (typeof store?.botHooks !== "function") return toolError("bot webhooks are not available on this connection. Ask the person to set it in the Context app's area panel, under the bot's Reach.");
    if (typeof hookBot !== "string" || hookBot.trim() === "") return toolError("invalid: name the bot (webhook.bot, or bot.name)");
  }
  if (args.webhook !== undefined) {
    const hook = args.webhook ?? {};
    if (typeof hook.address !== "string") return toolError("invalid: webhook is { address, header?, signing_key? }. Pass the bot's https address.");
    const answer = await store
      .botHooks({ action: "set", bot: hookBot, address: hook.address, ...(hook.header ? { header: String(hook.header) } : {}), ...(hook.signing_key ? { signingKey: String(hook.signing_key) } : {}) })
      .catch(() => ({ error: "the control plane could not be reached; try again" }));
    if (answer?.error) return toolError(`webhook not saved: ${answer.error} Fix that, then try again.`);
    done.push(
      `${hookBot}: webhook saved sealed for ${answer.host}${answer.headerEnds ? ` (header ends ${answer.headerEnds})` : ""}. ` +
        (answer.keyMade
          ? "Context made its signing key, which nobody can see: to let the bot check signatures, set one with webhook.signing_key (ctxbot_ and 64 hex characters from a random source) or press Replace on the area panel."
          : "Calls are signed with the key you passed."),
    );
  }
  if (args.test_webhook !== undefined) {
    const answer = await store.botHooks({ action: "test", bot: hookBot }).catch(() => ({ error: "the control plane could not be reached. Wait a moment, then try test_webhook again." }));
    if (answer?.error) problems.push(`test: ${answer.error}`);
    else done.push(answer.ok ? `${hookBot}: test call answered (${answer.status})` : `${hookBot}: test call ${answer.status === 0 ? "didn't reach it" : `answered ${answer.status}`}`);
  }

  // Which projects serve this area: one `area:` line in each project's front note.
  const projects = await attachProjects(
    {
      store,
      scope,
      rules,
      overrides,
      area,
      projectsRoot: jobs?.jobs?.projects ?? "projects",
      change: (path, changes, options) => change(store, scope, rules, overrides, path, changes, options),
    },
    args,
  );
  if (projects.error) return toolError(projects.error);
  done.push(...projects.done);
  problems.push(...projects.problems);

  if (done.length === 0 && problems.length === 0) {
    return toolError("invalid: nothing to change; pass owner, helper, modes, approvals, metric, bot, delegate, webhook, test_webhook, attach or detach");
  }
  return toolText([...done.map((line) => `- ${line}`), ...problems.map((line) => `- not done: ${line}`)].join("\n"));
}

export { mailJoinName };
