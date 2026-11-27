/**
 * `manage area` (`set_area`): an area's settings (its owner and delegate among them), its metric and its bots, changed in one call
 * (Dev2, 2026-11-25: "someone should be able to make updates to the areas, the area settings, assign metrics, update
 * bot configs easily through tex or through the mcp"). Everything here is front matter the app's area panel writes
 * too (`apps/mobile/features/console/files/folderPage/areas/seat.ts`), so the two never disagree:
 *
 *   - the area's `about.md`: owner, delegate, modes, approvals and its one metric (`metrics: [<name> · target <x>]`,
 *     with any older `metric:` and `target:` lines taken away, since they would win over it);
 *   - a bot's card, `bots/<bot>/about.md` beside the Areas folder (or in it, where bots lived first, or its older `people/<bot>.md`, changed where it is): its `bot`,
 *     `belongs_to`, `reach`, `avatar`, `avatar-dark` and `works_in`, the areas its person lets it work in with each one's cap on its
 *     week (`docs/decisions/app-and-console/area-routines.md`);
 *   - the areas' own `about.md` `agents:` list, for a bot named for the first time.
 *
 * A webhook is the one thing that is not a note: it goes sealed to the control plane (`/gateway/bots/hook`,
 * `apps/convex/functions/botHooks.ts`), and the answer names only its host and its header's last four characters.
 * Every note is read and written at this connection's own clearance, with the version it read, so a concurrent edit
 * is caught and an area it cannot see answers like one that does not exist.
 */

import areaBots from "../../../../../packages/shared/src/areaBots.cjs";
import areaRoutines from "../../../../../packages/shared/src/areaRoutines.cjs";
import { setNoteProperty } from "../../lists/setProperty.js";
import { normalizePath } from "../../notes/paths.js";
import { factJobs, factProps } from "../../tree/facts.js";
import { isVisibleTextFile } from "../../orient/survey.js";
import { toolError, toolText } from "../results.js";
import { toolReadNote } from "./read.js";
import { toolWriteNote } from "./write.js";
import { attachProjects } from "./attachProjects.js";
import { toolBindBot, toolSetupBot } from "./botBind.js";
import { areaPulse } from "./areaPulse.js";
import { makeMailNote } from "./mailNoteMade.js";

const { BOT_KINDS, MODE_ORDER, botLabel, knownModes, mailJoinName } = areaBots;
const { botCardPaths, botShortName, parseWorksInEntry, worksInLine } = areaRoutines;

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
async function change(store, scope, rules, overrides, path, changes, { create = false, images } = {}) {
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
    const written = await toolWriteNote(store, scope, rules, overrides, { path, content: text, ...(opened.etag ? { expected_etag: opened.etag } : {}), ...(images ? { images } : {}) });
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
  // Blank is the field left empty, not a clear: a client that fills every field it is shown sends owner: "" and
  // delegate: "" beside the one change it means (Grok, 2026-11-25), and that unseated the area. null clears.
  if (value === undefined || (typeof value === "string" && value.trim() === "")) return { skip: true };
  if (value === null) return { value: null };
  if (typeof value !== "string" || /[\r\n]/.test(value) || value.trim().length > MAX_TEXT) return { error: `${what} is one line of text. Pass it on one line, then try again.` };
  return { value: value.trim() };
}

/**
 * `bot.works_in` as the card writes it: a list of `{area, cap?}` or `"<area> · 20%"`, each under the Areas folder,
 * an empty list (or null) for none. `{lines}` or `{error}`.
 */
function worksInOf(value, root) {
  if (value === null) return { lines: [] };
  if (!Array.isArray(value) || value.length > 50) return { error: 'invalid: bot.works_in is a list of the areas it may work in, each { area, cap } (cap a whole percent of its week, or left out for none), like [{ area: "areas/finance", cap: 20 }]. Pass it that way, then try again.' };
  const lines = [];
  for (const item of value) {
    const entry =
      typeof item === "string"
        ? parseWorksInEntry(item)
        : item && typeof item === "object" && typeof item.area === "string"
          ? { area: normalizePath(item.area.replace(/\/about\.md$/i, "").replace(/\/+$/, "")), cap: item.cap === undefined || item.cap === null ? null : Number(item.cap) }
          : null;
    if (entry === null || entry.area === "" || /[\r\n·]/.test(entry.area)) return { error: 'invalid: each bot.works_in entry is { area, cap? }, like { area: "areas/finance", cap: 20 }. Fix that entry, then try again.' };
    if (entry.cap !== null && (!Number.isInteger(entry.cap) || entry.cap < 0 || entry.cap > 100)) return { error: `invalid: the cap for ${entry.area} is a whole percent of the bot's week, from 0 to 100. Pass it that way, then try again.` };
    if (entry.area !== root && !entry.area.startsWith(`${root}/`)) return { error: `invalid: ${entry.area} is not under the areas folder (${root}/). Pass an area as orient { area } lists it, then try again.` };
    const line = worksInLine(entry);
    if (!lines.some((seen) => seen.toLowerCase().split(" · ")[0] === entry.area.toLowerCase())) lines.push(line);
  }
  return { lines };
}

/**
 * @param {any} store the routed store; `store.botHooks(request)` reaches the control plane where it is bound.
 * @param {string} scope
 * @param {any} rules
 * @param {any} overrides
 * @param {Record<string, any>} args
 */
export async function toolSetArea(store, scope, rules, overrides, args) {
  // A bot binding its own login needs no area (`botBind.js`); with an area, the rest is done first.
  // A bot's whole setup in one call, from its own main chat (`botBind.js` `toolSetupBot`); it takes no area.
  if (args?.setup_bot !== undefined) return await toolSetupBot(store, scope, rules, overrides, args.setup_bot);
  if (args?.bind_bot !== undefined && (args.area === undefined || args.area === null || args.area === "")) return await toolBindBot(store, scope, rules, overrides, args.bind_bot);
  // A webhook is the bot's, not an area's, so saving or testing one alone needs no area (Dev, 2026-11-27: the setup
  // prompt is only "connect, then setup_bot", whose answer hands the webhook step with no area to name).
  const hookOnly = (args?.webhook !== undefined || args?.test_webhook !== undefined) && Object.keys(args).every((key) => ["webhook", "test_webhook", "context", "area"].includes(key));
  const named = normalizePath(String(args?.area ?? "").replace(/\/about\.md$/i, "").replace(/\/+$/, ""));
  const jobs = named || hookOnly ? await factJobs(store) : null;
  const area = named || (hookOnly ? (jobs?.jobs?.areas ?? "areas") : "");
  if (!area) return toolError('invalid: area is the area\'s folder. Pass it like "areas/finance".');
  const root = jobs?.jobs?.areas ?? area.split("/")[0];
  if (area !== root && !area.startsWith(`${root}/`)) return toolError(`invalid: ${area} is not under the areas folder (${root}/). Pass an area under ${root}/, as orient { area } lists them.`);
  const done = [];
  const problems = [];

  // The area's own settings.
  const seat = [];
  // Helper is gone (the owner, 2026-11-25): an area has an owner and, when a person owns it, at most one delegate.
  if (args.helper !== undefined) return toolError("invalid: an area has no helper any more. Pass delegate: the one bot or Tex that acts for the area's person owner here, then try again.");
  const ownerLine = oneLine(args.owner, "owner");
  if (ownerLine.error) return toolError("invalid: owner is a person's @handle or a bot's name, on one line. Pass it that way, then try again.");
  if (!ownerLine.skip) seat.push(["owner", ownerLine.value]);
  // The old shape, { person, to }, set who answered for a person everywhere; a delegate is per area now.
  if (args.delegate !== undefined && args.delegate !== null && typeof args.delegate === "object") {
    return toolError(`invalid: delegate is the name of the one bot (or Tex) that acts for this area's owner here, like delegate: "Finance", or null for none. Pass it once per area, then try again.`);
  }
  const delegateLine = oneLine(args.delegate, "delegate");
  if (delegateLine.error) return toolError("invalid: delegate is a bot's name or Tex, on one line, or null. Pass it that way, then try again.");
  // People are @handles; a bot or Tex is a name. Either a person owns and has one delegate, or a bot owns outright.
  const isPerson = (word) => typeof word === "string" && word.trim().startsWith("@");
  const isBot = (word) => typeof word === "string" && word.trim() !== "" && !isPerson(word);
  const owner = !ownerLine.skip ? ownerLine.value : (await factProps(store, [`${area}/about.md`]))?.get(`${area}/about.md`)?.props?.properties?.owner;
  if (!delegateLine.skip) {
    const to = delegateLine.value;
    if (isPerson(to)) {
      return toolError(`refused: a person is never a delegate. Make ${to} the owner (owner: "${to}"), or pass a bot's name or Tex as delegate, then try again.`);
    }
    if (to !== null && isBot(owner)) {
      return toolError(`refused: ${owner} owns ${area} outright, so it has no delegate. Make a person the owner with ${to} as delegate (owner: "@handle", delegate: "${to}"), or leave out the delegate, then try again.`);
    }
    if (to !== null && !isPerson(owner)) return toolError(`refused: ${area} has no owner, so nobody to act for. Pass owner: "@handle" too, then try again.`);
    seat.push(["delegate", to]);
  }
  // A bot taking the area holds it outright: any delegate goes, as the panel does. The old helper line goes with any change to who acts.
  if (!ownerLine.skip && isBot(owner) && delegateLine.skip) seat.push(["delegate", null]);
  if (seat.some(([key]) => key === "delegate")) seat.push(["helper", null]);
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
    done.push(wrote.unchanged ? `${area}: already so` : `${area}: set ${seat.map(([key]) => key).filter((key) => key !== "metric" && key !== "target" && key !== "helper").join(", ")}`);
    // The bot that now holds the area gets its mail note there at once, so its first routine answer has somewhere to
    // land (Dev, 2026-11-27; `mailNoteMade.js`). Tex reads its mail another way.
    const seated = seat.find(([key, value]) => (key === "owner" || key === "delegate") && typeof value === "string" && isBot(value) && value.toLowerCase() !== "tex");
    if (seated !== undefined) {
      const mailPath = `${area}/mail/${mailJoinName(seated[1])}.md`;
      const made = await makeMailNote(store, scope, rules, overrides, mailPath);
      if (made === "made") done.push(`${mailPath}: made`);
    }
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
    const card = [["kind", "agent"], ["bot", kind]];
    if (bot.reach !== undefined) card.push(["reach", bot.reach]);
    // Its logo, stored in the workspace by the write itself: `avatar:` names it, as a page's photo: does (`uploadedImages.js`).
    // `avatar-dark:` is the logo drawn on a dark screen, for a logo that does not read on both (Dev, 2026-11-27: a black
    // mark vanishes on dark, a white one on light); `avatar:` draws wherever no dark one is named.
    let images;
    for (const [field, key, leaf] of [["avatar", "avatar", "logo"], ["avatar_dark", "avatar-dark", "logo-dark"]]) {
      if (bot[field] === undefined) continue;
      const from = bot[field] ?? {};
      const url = typeof from.url === "string" ? from.url.trim() : "";
      const data = typeof from.data === "string" ? from.data.trim() : "";
      if ((url === "") === (data === "")) return toolError(`invalid: bot.${field} takes url (an https address) or data (base64), one of them. Pass one, then try again.`);
      card.push([key, leaf]);
      (images ??= []).push({ name: leaf, ...(url !== "" ? { url } : { data }) });
    }
    // Where it works and how much of its week each area may spend: the whole list, as its person sets it.
    let works;
    if (bot.works_in !== undefined) {
      const worksIn = worksInOf(bot.works_in, root);
      if (worksIn.error) return toolError(worksIn.error);
      works = worksIn.lines;
      card.push(["works_in", works.length === 0 ? null : works]);
    }
    // A bot's card is `bots/<bot>/about.md` beside the Areas folder (the owner, 2026-11-25: "top level bots yes"); one
    // still in the Areas folder's `bots/` or `people/` is changed where it is.
    const paths = botCardPaths(root, name);
    const found = await factProps(store, paths);
    const cardAt = paths.find((path) => found?.get(path)?.props) ?? paths[0];
    // The words its card already says stay (Tex Quality, 2026-11-26: called "Tex Quality", its card's "Tex Quality ·
    // Tex reply quality" was cut back to that); a new card says the name it was made with.
    const said = found?.get(cardAt)?.props?.properties?.holder;
    if (typeof said !== "string" || said.trim() === "") card.unshift(["holder", name]);
    // Its kind likewise: left as the card says unless it is new or bot.kind was passed.
    const saidKind = found?.get(cardAt)?.props?.properties?.bot;
    if (bot.kind === undefined && typeof saidKind === "string" && saidKind.trim() !== "") card.splice(card.findIndex(([key]) => key === "bot"), 1);
    /*
      WHOSE BOT IT IS IS NOT ANOTHER EDITOR'S TO SAY (2026-11-27). `bind_bot` binds a card to the connection the card
      names, and to nobody else's (`botBind.js`): what that connection writes is signed by the bot, and its reads say
      the bot. So `belongs_to` on a card already here is the owner's line, or the line of the person it names, who may
      clear it or hand the bot on. An editor who could rewrite it on somebody else's card would bind their bot, and a
      card that names nobody is an owner's to bind, so claiming one is an owner's too. A card this call makes says
      whom it was made for.
    */
    const already = found?.get(cardAt)?.props?.properties ?? null;
    if (whose !== undefined && already !== null) {
      const named = typeof already.belongs_to === "string" ? already.belongs_to.trim().toLowerCase() : "";
      const me = typeof store.actor?.name === "string" ? store.actor.name.trim().toLowerCase() : "";
      if (store.actor?.role !== "owner" && !(named !== "" && named === me)) {
        return toolError(
          named === ""
            ? `refused: ${name}'s card is already here and names nobody, so only an owner of this workspace says whose bot it is. Ask an owner to set belongs_to.`
            : `refused: ${name} is ${already.belongs_to}'s bot, so only they or an owner change that. Ask one of them, then try again.`,
        );
      }
    }
    if (whose !== undefined) card.push(["belongs_to", whose === "" ? null : whose]);
    // A cards folder inside the Areas folder says `area: false`, so it is never drawn as an area; the one beside it needs none.
    const folderOf = (path) => path.split("/").slice(0, path.endsWith("/about.md") ? -2 : -1).join("/");
    const cardsFolder = folderOf(cardAt);
    if (cardsFolder !== folderOf(paths[0])) {
      const folderAbout = await openNote(store, scope, rules, overrides, `${cardsFolder}/about.md`);
      if (folderAbout.missing) await change(store, scope, rules, overrides, `${cardsFolder}/about.md`, [["area", "false"]], { create: true });
    }
    const wrote = await change(store, scope, rules, overrides, cardAt, card, { create: true, images });
    if (wrote.error) return toolError(wrote.error);
    const listing = await openNote(store, scope, rules, overrides, `${root}/about.md`);
    const agents = (await factProps(store, [`${root}/about.md`]))?.get(`${root}/about.md`)?.props?.properties?.agents;
    const have = Array.isArray(agents) ? agents.map(String) : typeof agents === "string" ? agents.split(",").map((item) => item.trim()).filter(Boolean) : [];
    // Listed once, by its folder's name: `Tex Quality · Tex reply quality` is already there as Tex Quality.
    const listed = botShortName(name) ?? name;
    const known = (agent) => [name, listed].some((each) => agent.toLowerCase() === each.toLowerCase());
    if (!have.some(known) && !listing.error) {
      const added = await change(store, scope, rules, overrides, `${root}/about.md`, [["agents", [...have, listed]]], { create: true });
      if (added.error) problems.push(added.error);
    }
    done.push(`${typeof said === "string" && said.trim() !== "" ? said.trim() : name}: ${botLabel(bot.kind === undefined && typeof saidKind === "string" && saidKind.trim() !== "" ? saidKind.trim() : kind)}${whose ? ` of ${whose}` : ""}${bot.reach ? `, reached by ${bot.reach === "webhook" ? "its webhook" : "checking its mail"}` : ""}${images ? ", with its logo" : ""}${works === undefined ? "" : works.length === 0 ? ", working wherever an area names it" : `, working in ${works.join(", ")}`} (card ${cardAt})`);
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
    if (hook.header_from_shell !== undefined) {
      // The bot sends the header's value itself, from its shell, so no model or chat sees it (`http/botHookUpload.js`).
      const headerName = String(hook.header_from_shell).trim();
      if (hook.header || hook.signing_key) return toolError("invalid: header_from_shell replaces header and signing_key. Leave those out, pass only the header's name (Authorization), then try again.");
      if (!/^[A-Za-z0-9-]{1,64}$/.test(headerName)) return toolError("invalid: header_from_shell is the header's name, like Authorization. Pass just the name, then try again.");
      if (typeof store.botHookUrl !== "string") return toolError("sending a header from a shell isn't available on this connection. Ask the person to set it in the Context app's area panel, under the bot's Reach.");
      const minted = await store.botHooks({ action: "ticket", bot: hookBot, address: hook.address, headerName }).catch(() => ({ error: "the control plane could not be reached. Wait a moment, then try again." }));
      if (minted?.error || typeof minted?.ticket !== "string") return toolError(`webhook not saved: ${minted?.error ?? "no command was made."} Fix that, then try again.`);
      done.push(
        `${hookBot}: nothing saved yet. Run this once in your shell within ${minted.minutes ?? 10} minutes, with $WEBHOOK_SECRET replaced by the environment variable that holds your secret (keep the double quotes, and never print it):\n` +
          `  curl -sS --fail-with-body -X PUT -H 'Authorization: Bearer ${minted.ticket}' --data-binary "Bearer $WEBHOOK_SECRET" ${store.botHookUrl}\n` +
          `It sends ${headerName}: Bearer <your secret> straight to Context, which seals it; drop "Bearer " if your webhook takes the bare secret. Then call manage area with test_webhook: "${hookBot}".`,
      );
    } else {
      const answer = await store
        .botHooks({ action: "set", bot: hookBot, address: hook.address, ...(hook.header ? { header: String(hook.header) } : {}), ...(hook.signing_key ? { signingKey: String(hook.signing_key) } : {}) })
        .catch(() => ({ error: "the control plane could not be reached. Wait a moment, then try again." }));
      if (answer?.error) return toolError(`webhook not saved: ${answer.error} Fix that, then try again.`);
      done.push(
        `${hookBot}: webhook saved sealed for ${answer.host}${answer.headerEnds ? ` (header ends ${answer.headerEnds})` : ""}. ` +
          (answer.keyMade
            ? "Context made its signing key, which nobody can see: to let the bot check signatures, set one with webhook.signing_key (ctxbot_ and 64 hex characters from a random source) or press Replace on the area panel."
            : "Calls are signed with the key you passed."),
      );
    }
  }
  if (args.test_webhook !== undefined) {
    const answer = await store.botHooks({ action: "test", bot: hookBot }).catch(() => ({ error: "the control plane could not be reached. Wait a moment, then try test_webhook again." }));
    if (answer?.error) problems.push(`test: ${answer.error}`);
    else done.push(answer.ok ? `${hookBot}: test call answered (${answer.status})` : `${hookBot}: test call ${answer.status === 0 ? "didn't reach it" : `answered ${answer.status}`}`);
    // A webhook that answers its test is how Context reaches the bot, so its card says so: a bot set up from its
    // prompt saved the webhook but never wrote `reach: webhook`, and its card went on saying it checks its mail (Dev,
    // 2026-11-27: "these bots say they setup their webhooks but it still shows as setup in mail").
    if (answer?.ok === true) {
      const paths = botCardPaths(root, hookBot.trim());
      const found = await factProps(store, paths);
      const cardAt = paths.find((path) => found?.get(path)?.props);
      if (cardAt !== undefined && found.get(cardAt).props.properties?.reach !== "webhook") {
        const wrote = await change(store, scope, rules, overrides, cardAt, [["reach", "webhook"]]);
        if (wrote.error) problems.push(`card: ${wrote.error}`);
      }
    }
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

  // Pulse checks: the area's routines written from the templates, or paused (`areaPulse.js`).
  if (args.pulse !== undefined) {
    const pulsed = await areaPulse(
      {
        store,
        scope,
        rules,
        overrides,
        area,
        modes: args.modes === undefined ? undefined : knownModes(Array.isArray(args.modes) ? args.modes : []),
        change: (path, changes, options) => change(store, scope, rules, overrides, path, changes, options),
      },
      args.pulse,
    );
    if (pulsed.refused) return pulsed.refused;
    done.push(...pulsed.done);
    problems.push(...pulsed.problems);
  }

  if (args.bind_bot !== undefined) {
    const bound = await toolBindBot(store, scope, rules, overrides, args.bind_bot);
    if (bound.isError) problems.push(textOf(bound));
    else done.push(textOf(bound).replace(/^- /, ""));
  }

  if (done.length === 0 && problems.length === 0) {
    return toolError("invalid: nothing to change; pass owner, delegate, modes, approvals, metric, bot, webhook, test_webhook, bind_bot, setup_bot, pulse, attach or detach");
  }
  return toolText([...done.map((line) => `- ${line}`), ...problems.map((line) => `- not done: ${line}`)].join("\n"));
}

export { mailJoinName };
