/**
 * `manage area { bind_bot }`: a bot's own connection says which bot it is in this workspace, and Context mails it a
 * check (Dev, 2026-11-26: "At connect time Context should bind the bot's connector login to its bot card ... Context
 * sends one test mail as the last step and marks the connection healthy only when the reply comes from the bot's own
 * identity within a few minutes"; `packages/shared/src/botRelay.cjs`).
 *
 *   - The card must be there (`bots/<bot>/about.md`, or where bots lived before), and a card that names whose bot it
 *     is (`belongs_to:`) is bound only by that person's own connection, or an owner's.
 *   - Only an owner's or editor's connection binds, and only itself. The workspace's own object keeps the binding by
 *     grant (`mail/boundBot.js`, `workspaceStore/mailBots.js`), never the control plane (Dev, 2026-11-26: Convex is
 *     for sign-in, everything else on Cloudflare).
 *   - The check is a mail line from `context` in `<card folder>/mail/context.md`, which the workspace object tells
 *     the bot's webhook like any other (`workspaceStore/botMail.js`). The bot answers there, signed by its bound name;
 *     the app reads that note to say "not answering" (`apps/mobile/.../areas/areaMail.ts` `checkOf`).
 */

import areaBots from "../../../../../packages/shared/src/areaBots.cjs";
import areaRoutines from "../../../../../packages/shared/src/areaRoutines.cjs";
import mail from "../../../../../packages/shared/src/mail.cjs";
import { factJobs, factProps } from "../../tree/facts.js";
import { toolError, toolText } from "../results.js";
import { toolReadNote } from "./read.js";
import { toolWriteNote } from "./write.js";
import comments from "../../../../../packages/shared/src/comments.cjs";
import { bindBot } from "../../mail/boundBot.js";
import botRelay from "../../../../../packages/shared/src/botRelay.cjs";
import botApps from "../../../../../packages/shared/src/botApps.cjs";

const { mailJoinName } = areaBots;
const { botCardPaths, botShortName } = areaRoutines;
const { appendMail } = mail;
const { setupAnswer } = botRelay;
const { reachOf } = botApps;

const CHECK_TEXT =
  "Setup check from Context: answer here with one line from your main chat, as yourself, so Context knows your webhook relay wakes you and your login is bound. If no answer comes within 5 minutes, your card says you are not answering.";

const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? "").join("\n");

/** The card a bot's name has here, as this connection sees it: `{path, props}` or null. */
export async function botCardOf(store, name) {
  const jobs = await factJobs(store);
  const root = jobs?.jobs?.areas ?? "areas";
  const paths = botCardPaths(root, name);
  const found = await factProps(store, paths);
  // A person's card (`people/<name>.md`) shares the path shape; only a bot's says `bot:` or `kind: agent`.
  const isBot = (props) => {
    const properties = props?.properties ?? {};
    return (typeof properties.bot === "string" && properties.bot.trim() !== "") || properties.kind === "agent";
  };
  const path = paths.find((each) => isBot(found?.get(each)?.props));
  return path === undefined ? null : { path, props: found.get(path).props?.properties ?? {} };
}

/** Appends the check line to `path`, made when missing; null, or why not. */
async function mailCheck(store, scope, rules, overrides, path, holder) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const read = await toolReadNote(store, scope, rules, overrides, path);
    const text = textOf(read);
    const missing = read.isError && /not found/i.test(text);
    if (read.isError && !missing) return text;
    let body = `# Mail with ${holder}\n`;
    let etag;
    if (!missing) {
      const split = text.indexOf("\n\n");
      body = split === -1 ? "" : text.slice(split + 2);
      etag = /^etag:\s*(\S+)/m.exec(split === -1 ? text : text.slice(0, split))?.[1];
    }
    const outcome = appendMail(body, { from: "context", app: "Context", kind: "mail", to: "everyone", text: CHECK_TEXT, at: new Date().toISOString() });
    if (outcome.error) return outcome.error;
    const written = await toolWriteNote(
      store,
      scope,
      rules,
      overrides,
      { path, content: comments.applyChanges(body, outcome.changes), ...(etag ? { expected_etag: etag } : {}), summary: "Context's setup check" },
      { mailOwn: true },
    );
    if (written.isError && /^conflict/.test(textOf(written)) && attempt === 0) continue;
    return written.isError ? textOf(written) : null;
  }
  return "the note kept changing";
}

/** Binds this connection to the card named `raw` and mails it the check: `{refused}` (its answer) or `{holder, bot, card, checkPath, failed}`. */
async function bindCard(store, scope, rules, overrides, raw, field) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name === "" || name.startsWith("@") || name.length > 60) return { refused: toolError(`invalid: ${field} is the bot's name as its card says it. Pass it like ${field}: "Grok Bot", then try again.`) };
  // Setting up a workspace's bots is an owner's or an editor's, as setting their webhooks is.
  if (store?.actor?.role !== "owner" && store?.actor?.role !== "editor") return { refused: toolError("refused: only an owner or editor of this workspace binds its bots. Ask one to bind it, or to make you an editor.") };
  const card = await botCardOf(store, name);
  if (card === null) return { refused: toolError(`no card for ${name} here, or this connection can't see it. Make it first with manage area { bot: { name: "${name}" } }, then try again.`) };
  // A card that says whose bot it is is that person's to bind (or an owner's): nobody else's login becomes their bot.
  // A card that names nobody is an owner's, because binding is an identity: what the bound login writes is signed by
  // the bot, its reads say the bot, and its answer marks the bot answering, so any connection that could see an
  // unnamed card would have spoken as it.
  const whose = typeof card.props.belongs_to === "string" ? card.props.belongs_to.trim().toLowerCase() : "";
  const me = typeof store.actor?.name === "string" ? store.actor.name.trim().toLowerCase() : "";
  if (!(me !== "" && whose === me) && store.actor?.role !== "owner") {
    return {
      refused: toolError(
        whose === ""
          ? `refused: ${name}'s card names nobody, so only an owner's connection binds it. Put belongs_to on the card as whose bot it is, or ask an owner to bind it.`
          : `refused: ${name} is ${card.props.belongs_to}'s bot, so only their own connection binds it. Ask them to connect it.`,
      ),
    };
  }
  const holder = typeof card.props.holder === "string" && card.props.holder.trim() !== "" ? card.props.holder.trim() : name;
  // Its mail name is its card's folder (`bots/tex-quality/about.md` → `tex-quality`), whatever words it was called by.
  const folderName = /\/([^/]+)\/about\.md$/.exec(card.path)?.[1];
  const bot = mailJoinName(folderName ?? botShortName(name) ?? name);
  const answer = await bindBot(store, { bot, name: holder });
  if (answer.ok !== true) return { refused: toolError(`not bound: ${answer.error}. Fix that, then try again.`) };
  // A card in a folder (`bots/<bot>/about.md`) has its mail beside it; an old one-note card has none, so no check.
  const folder = card.path.endsWith("/about.md") ? card.path.slice(0, -"/about.md".length) : null;
  if (folder === null) return { holder, bot, card, checkPath: null, failed: null };
  const checkPath = `${folder}/mail/context.md`;
  const failed = await mailCheck(store, scope, rules, overrides, checkPath, holder);
  return { holder, bot, card, checkPath, failed };
}

const boundLine = ({ holder, bot }) =>
  `- ${holder}: this connection is now ${holder} here (as well as any bot it was already); what it writes in ${holder}'s folder is signed ${holder}, and elsewhere it passes as: "${bot}" when it is several bots.`;

export async function toolBindBot(store, scope, rules, overrides, raw) {
  const bound = await bindCard(store, scope, rules, overrides, raw, "bind_bot");
  if (bound.refused) return bound.refused;
  if (bound.checkPath === null) return toolText(boundLine(bound));
  return toolText(
    [
      boundLine(bound),
      bound.failed === null
        ? `- check: mailed to ${bound.checkPath}. Answer it there from your main chat within 5 minutes: write { action: "mail", path: "${bound.checkPath}", args: { text, used } }.`
        : `- not done: the check mail (${bound.failed}). Ask the person to mail you from the app's bot page instead.`,
    ].join("\n"),
  );
}

/**
 * `manage area { setup_bot }`: the whole of a bot's setup in one call (Dev, 2026-11-27: "could we make a context mcp
 * action that makes it easier?", after none of @shyoh's seven bots finished the pasted steps). It binds as `bind_bot`
 * does, mails the check, and answers with every step left, filled in for this bot: answer the check, the `as:` name
 * to keep, the relay routine when its card says `reach: webhook`, and its picture (`botRelay.cjs` `pictureStep`, the
 * same words the app's Refresh used). The pasted prompt and Refresh are one line that names this call.
 */
export async function toolSetupBot(store, scope, rules, overrides, raw) {
  const bound = await bindCard(store, scope, rules, overrides, raw, "setup_bot");
  if (bound.refused) return bound.refused;
  const slug = typeof store?.actor?.workspaceSlug === "string" ? store.actor.workspaceSlug.trim().replace(/^@/, "") : "";
  // Its card's reach, else its app's way (`botApps.cjs`: Grok by webhook, Muse and Instinct by checking in).
  const webhook = reachOf(bound.card.props.reach, bound.card.props.bot) === "webhook";
  // A bot Context wakes by webhook gets its check as a test routine, so setup passes only when a routine wake reaches
  // its main chat and gets done (`/gateway/bots/hook` `routine: true`, which names only this bot's check note).
  let routineTest;
  if (webhook && bound.checkPath !== null && bound.failed === null && typeof store.botHooks === "function") {
    const sent = await store.botHooks({ action: "test", bot: bound.bot, routine: true }).catch(() => null);
    // Why not, as the control plane said it, or the status the webhook gave; `setupAnswer` words the rest.
    routineTest = sent?.ok === true ? "sent" : typeof sent?.error === "string" ? sent.error : sent === null ? "" : `status ${sent.status ?? 0}`;
  }
  const rest = setupAnswer({ ...bound, card: bound.card.path, kind: bound.card.props.bot, webhook, workspace: slug === "" ? undefined : `@${slug}`, routineTest });
  return toolText([boundLine(bound), "", rest].join("\n"));
}
