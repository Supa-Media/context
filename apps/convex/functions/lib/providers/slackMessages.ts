import { slackCall } from "./slack";

/**
 * Slack's messages, read the way a person reads them: who said what, by name.
 *
 * Raw `conversations.history` answers 1–2 KB per message (blocks, attachments,
 * profile copies) and names people only by id, so a channel's default hundred
 * messages ran past what one answer may carry and Tex could not say who wrote
 * what. Here each message is cut to its words and what hangs off it (thread,
 * reactions, files), every author and `<@U…>` mention is named, and a search
 * hit says which channel it is in. A channel may be named as `#name`.
 */

type Answer = { status: number; body: unknown };
type Entry = Record<string, unknown>;

/** What a message's words may take; past this a long post is cut and says so. */
const MAX_TEXT = 3_000;
/** People named per answer; past this an author is left as their id. */
const MAX_NAMES = 40;
/** Messages read when none is asked for: a channel's last day or so, under the answer cap. */
const DEFAULT_MESSAGES = 50;
/** Pages of channels read to find one by name. */
const MAX_CHANNEL_PAGES = 10;

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

function compact(entry: Entry): Entry {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined && value !== false && value !== ""));
}

function fold(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** A refusal in Slack's own shape, so the gateway says it like any other. */
function refused(error: string, extra: Entry = {}): Answer {
  return { status: 200, body: { ok: false, error, ...extra } };
}

/**
 * The id of the channel called `#name` (any the person is in or can see, open
 * or private), or Slack's `channel_not_found` when none is.
 *
 * **A destination is resolved exactly, never by the search fold.** `fold`
 * strips accents and folds compatibility forms so that "Ségun" is found by
 * "segun", which is right for `match` over a listing and wrong for deciding
 * where a message goes: Slack channel names may hold any script, so anyone in
 * that Slack can make a channel whose folded name equals another's. Taking
 * whichever Slack listed first would deliver a post the person said yes to for
 * `#general` somewhere else, and answer a read of `#general` with that other
 * channel. So the exact name wins outright — Slack's own names are unique
 * case-insensitively, so one is all there can be — and the fold is only a
 * fallback, used when it picks out exactly one channel and refused as
 * `channel_ambiguous` when it picks out more.
 */
export async function channelIdByName(accessToken: string, given: string): Promise<{ id: string } | { answer: Answer }> {
  const asked = given.replace(/^#/, "").trim();
  const wanted = fold(asked);
  const alike: Entry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CHANNEL_PAGES; page++) {
    const answer = await slackCall(accessToken, "conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const body = (answer.body ?? {}) as Entry;
    if (body.ok !== true) return { answer };
    const channels = Array.isArray(body.channels) ? (body.channels as Entry[]) : [];
    const exact = channels.find(
      (channel) => typeof channel.name === "string" && typeof channel.id === "string" && channel.name.toLowerCase() === asked.toLowerCase(),
    );
    if (exact) return { id: exact.id as string };
    for (const channel of channels) {
      if (typeof channel.name === "string" && typeof channel.id === "string" && fold(channel.name) === wanted) alike.push(channel);
    }
    const next = ((body.response_metadata ?? {}) as Entry).next_cursor;
    if (typeof next !== "string" || next === "") break;
    cursor = next;
  }
  if (alike.length === 1) return { id: alike[0].id as string };
  if (alike.length > 1) {
    return {
      answer: refused("channel_ambiguous", {
        channel: given,
        hint: `More than one channel is spelled like that (${alike.map((channel) => `#${String(channel.name)}`).join(", ")}). Ask which one, then pass its id.`,
      }),
    };
  }
  return { answer: refused("channel_not_found", { channel: given, hint: "No open channel has that name; conversations.list {match} finds the right one." }) };
}

/** Each id's display name, from `users.info`; an id Slack won't name is left out. */
async function namesOf(accessToken: string, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    ids.slice(0, MAX_NAMES).map(async (id) => {
      try {
        const { body } = await slackCall(accessToken, "users.info", { user: id });
        const user = ((body ?? {}) as Entry).user as Entry | undefined;
        const profile = (user?.profile ?? {}) as Entry;
        const name = [profile.display_name, profile.real_name, user?.real_name, user?.name].find((value) => typeof value === "string" && value.trim() !== "");
        if (typeof name === "string") names.set(id, name.trim());
      } catch {
        // A name is a nicety: the id stays.
      }
    }),
  );
  return names;
}

function mentioned(text: string): string[] {
  return [...text.matchAll(MENTION)].map((match) => match[1]);
}

function named(text: string, names: Map<string, string>): string {
  const plain = text.replace(MENTION, (whole, id: string) => (names.has(id) ? `@${names.get(id)}` : whole));
  return plain.length > MAX_TEXT ? `${plain.slice(0, MAX_TEXT)}… [cut; ${plain.length} characters]` : plain;
}

function slimMessage(raw: Entry, names: Map<string, string>): Entry {
  const user = typeof raw.user === "string" ? raw.user : undefined;
  const bot = ((raw.bot_profile ?? {}) as Entry).name ?? raw.username;
  const reactions = Array.isArray(raw.reactions)
    ? (raw.reactions as Entry[]).map((reaction) => `${String(reaction.name)}×${Number(reaction.count) || 1}`).join(" ")
    : undefined;
  const files = Array.isArray(raw.files) ? (raw.files as Entry[]).map((file) => String(file.name ?? file.title ?? "a file")) : undefined;
  return compact({
    ts: raw.ts,
    from: user === undefined ? (typeof bot === "string" ? bot : undefined) : (names.get(user) ?? user),
    user,
    text: typeof raw.text === "string" ? named(raw.text, names) : undefined,
    // A reply carries its thread; a thread's first message carries its count.
    thread_ts: typeof raw.thread_ts === "string" && raw.thread_ts !== raw.ts ? raw.thread_ts : undefined,
    reply_count: typeof raw.reply_count === "number" && raw.reply_count > 0 ? raw.reply_count : undefined,
    reactions: reactions || undefined,
    files: files && files.length > 0 ? files : undefined,
    edited: raw.edited !== undefined,
    subtype: typeof raw.subtype === "string" && raw.subtype !== "thread_broadcast" ? raw.subtype : undefined,
  });
}

/** `conversations.history` and `conversations.replies`, trimmed and named. */
export async function readMessages(accessToken: string, method: string, args: Record<string, unknown>): Promise<Answer> {
  const asked = Number(args.limit);
  const answer = await slackCall(accessToken, method, { ...args, limit: asked > 0 ? Math.floor(asked) : DEFAULT_MESSAGES });
  const body = (answer.body ?? {}) as Entry;
  if (body.ok !== true) return answer;
  const raws = Array.isArray(body.messages) ? (body.messages as Entry[]) : [];
  const ids = new Set<string>();
  for (const raw of raws) {
    if (typeof raw.user === "string") ids.add(raw.user);
    if (typeof raw.text === "string") for (const id of mentioned(raw.text)) ids.add(id);
  }
  const names = await namesOf(accessToken, [...ids]);
  const next = ((body.response_metadata ?? {}) as Entry).next_cursor;
  return {
    status: answer.status,
    body: compact({
      ok: true,
      messages: raws.map((raw) => slimMessage(raw, names)),
      count: raws.length,
      order: method === "conversations.history" ? "newest first" : "oldest first",
      more: body.has_more === true && typeof next === "string" && next !== "" ? `pass cursor ${next} for older messages` : undefined,
    }),
  };
}

/** `search.messages`, each hit with its channel, author, words and link. */
export async function searchMessages(accessToken: string, args: Record<string, unknown>): Promise<Answer> {
  const answer = await slackCall(accessToken, "search.messages", { count: 20, ...args });
  const body = (answer.body ?? {}) as Entry;
  if (body.ok !== true) return answer;
  const found = (body.messages ?? {}) as Entry;
  const matches = Array.isArray(found.matches) ? (found.matches as Entry[]) : [];
  const ids = new Set<string>();
  for (const match of matches) if (typeof match.text === "string") for (const id of mentioned(match.text)) ids.add(id);
  const names = await namesOf(accessToken, [...ids]);
  return {
    status: answer.status,
    body: compact({
      ok: true,
      total: typeof found.total === "number" ? found.total : matches.length,
      matches: matches.map((match) => {
        const channel = (match.channel ?? {}) as Entry;
        return compact({
          channel: typeof channel.name === "string" ? `#${channel.name}` : undefined,
          channel_id: channel.id,
          from: match.username,
          user: match.user,
          ts: match.ts,
          text: typeof match.text === "string" ? named(match.text, names) : undefined,
          permalink: match.permalink,
        });
      }),
    }),
  };
}
