/**
 * A bot's helper by name (`docs/decisions/app-and-console/bot-helpers.md`): it signs mail as
 * `<helper>-via-<bot>-<4 of its id>` (`claude-via-grok-bot-a3f1`, `@context/shared/src/botHelpers.cjs`
 * `helperMailName`), the bot part cut to fit mail's 24-character names, and is shown as "Claude via Grok Bot", never a
 * bare "Claude". These read either spelling back; the bot part may be only the start of its slug.
 */

export interface HelperParts {
  /** "claude". */
  readonly helper: string;
  /** "grok-bot", or the start of it when the name was cut. */
  readonly bot: string;
}

const SLUG = /^([a-z0-9]+)-via-([a-z0-9][a-z0-9-]*?)(?:-[0-9a-f]{4})?$/;
const WORDS = /^(\S+) via (.+)$/;

/** `claude-via-grok-bot-a3f1` or "Claude via Grok Bot" → its parts; null for any other name. */
export function helperParts(name: string | null | undefined): HelperParts | null {
  const raw = String(name ?? "").trim();
  const slug = SLUG.exec(raw);
  if (slug !== null) return { helper: slug[1]!, bot: slug[2]! };
  const words = WORDS.exec(raw);
  if (words === null) return null;
  const bot = words[2]!.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return bot === "" ? null : { helper: words[1]!.toLowerCase(), bot };
}

/** Whether a helper's bot part names this bot: its slug, or the start of it. */
export function helperOfBot(parts: HelperParts | null, botSlug: string): boolean {
  return parts !== null && parts.bot !== "" && (botSlug === parts.bot || botSlug.startsWith(`${parts.bot}-`) || (parts.bot.length >= 4 && botSlug.startsWith(parts.bot)));
}

const title = (slug: string) =>
  slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

/** "Claude via Grok Bot", from either spelling; `botName` (its card's words) when the bot is known. Null for a non-helper. */
export function helperWords(name: string | null | undefined, botName?: string | null): string | null {
  const parts = helperParts(name);
  if (parts === null) return null;
  const words = WORDS.exec(String(name ?? "").trim());
  const helper = words !== null ? words[1]! : title(parts.helper);
  const bot = typeof botName === "string" && botName.trim() !== "" ? botName.trim() : words !== null ? words[2]!.trim() : title(parts.bot);
  return `${helper} via ${bot}`;
}
