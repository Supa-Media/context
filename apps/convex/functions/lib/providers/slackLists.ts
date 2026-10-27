import { slackCall } from "./slack";
import { channelIdByName, readMessages, searchMessages } from "./slackMessages";

/**
 * Slack's two directory listings, read the way a person asks about them.
 *
 * `users.list` answers ~3 KB per account, deactivated ones and bots first, a
 * page at a time; twenty accounts fill a model's whole answer and a workspace
 * of a few hundred takes dozens of calls, so "find Segun" ended with Tex
 * reading ten deactivated accounts and giving up. Here every page is read in
 * one call, each entry is cut to what identifies it, and only active people
 * (and open channels) come back unless `include_inactive` asks for all.
 * `match` keeps only entries whose names or email hold every word of it.
 *
 * `match` and `include_inactive` are ours, never sent to Slack. `limit` is how
 * many entries to return, not Slack's page size.
 */

type Answer = { status: number; body: unknown };
type Entry = Record<string, unknown>;

/** Slack's own page ceiling for these two methods. */
const PAGE = 200;
/** 3,000 accounts or channels: past every workspace this is for, under Slack's per-minute limit. */
const MAX_PAGES = 15;
/** What one answer carries by default, so it stays well under the gateway's 60,000 characters. */
const DEFAULT_RETURN = 150;

interface Listing {
  key: "members" | "channels";
  slim(raw: Entry): Entry;
  active(raw: Entry): boolean;
  words(slim: Entry): string;
  /** Arguments Slack itself takes to skip inactive entries. */
  narrow?: Record<string, string>;
}

const text = (value: unknown, max = 120): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined;

/** Drop empty and false fields: on hundreds of entries they are most of the size. */
function compact(entry: Entry): Entry {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined && value !== false && value !== ""));
}

const LISTINGS: Record<string, Listing> = {
  "users.list": {
    key: "members",
    slim(raw) {
      const profile = (raw.profile ?? {}) as Entry;
      return compact({
        id: raw.id,
        name: text(raw.name),
        real_name: text(profile.real_name ?? raw.real_name),
        display_name: text(profile.display_name),
        title: text(profile.title),
        email: text(profile.email),
        tz: text(raw.tz),
        guest: raw.is_restricted === true || raw.is_ultra_restricted === true,
        is_bot: raw.is_bot === true || raw.id === "USLACKBOT",
        deleted: raw.deleted === true,
      });
    },
    active: (raw) => raw.deleted !== true && raw.is_bot !== true && raw.id !== "USLACKBOT",
    words: (slim) => [slim.name, slim.real_name, slim.display_name, slim.email].filter(Boolean).join(" "),
  },
  "conversations.list": {
    key: "channels",
    slim(raw) {
      return compact({
        id: raw.id,
        name: text(raw.name),
        user: raw.is_im === true ? raw.user : undefined,
        is_private: raw.is_private === true,
        is_im: raw.is_im === true,
        is_mpim: raw.is_mpim === true,
        is_member: raw.is_member === true,
        is_archived: raw.is_archived === true,
        num_members: typeof raw.num_members === "number" ? raw.num_members : undefined,
        topic: text((raw.topic as Entry | undefined)?.value),
        purpose: text((raw.purpose as Entry | undefined)?.value),
      });
    },
    active: (raw) => raw.is_archived !== true,
    words: (slim) => [slim.name, slim.topic, slim.purpose].filter(Boolean).join(" "),
    narrow: { exclude_archived: "true" },
  },
};

/** Lowercase, accents gone: "Ségun" is found by "segun". */
function fold(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

/** Posts whose `channel` may name a person: a DM is how a person asks for one ("message Segun"). */
const POSTS = new Set(["chat.postMessage", "chat.scheduleMessage", "chat.meMessage"]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_ID = /^[UW][A-Z0-9]{2,}$/;

/**
 * The DM channel for a post addressed to a person, by user id or by the email
 * they use in that Slack, or the channel as given; or Slack's own refusal
 * (`users_not_found`) for an email nobody there uses. The person said yes to
 * the post with that address in it, so the post goes to whoever Slack says
 * owns it, and nowhere else.
 */
async function postChannel(accessToken: string, channel: string): Promise<{ channel: string } | { answer: Answer }> {
  let user = USER_ID.test(channel) ? channel : undefined;
  if (EMAIL.test(channel)) {
    const found = await slackCall(accessToken, "users.lookupByEmail", { email: channel });
    const body = (found.body ?? {}) as Entry;
    const id = (body.user as Entry | undefined)?.id;
    if (body.ok !== true || typeof id !== "string") return { answer: found };
    user = id;
  }
  if (user === undefined) return { channel };
  const opened = await slackCall(accessToken, "conversations.open", { users: user });
  const body = (opened.body ?? {}) as Entry;
  const id = (body.channel as Entry | undefined)?.id;
  return body.ok === true && typeof id === "string" ? { channel: id } : { answer: opened };
}

/**
 * One Web API call. A channel may be named as `#name`; the two directory
 * listings come back whole, trimmed and filtered; messages and search hits
 * come back trimmed and named (`slackMessages.ts`); and a post addressed to a
 * person (user id or email) goes to the DM with them.
 */
export async function slackCallShaped(accessToken: string, method: string, given: Record<string, unknown>): Promise<Answer> {
  let args = given;
  if (typeof args.channel === "string" && args.channel.trim().startsWith("#")) {
    const found = await channelIdByName(accessToken, args.channel.trim());
    if ("answer" in found) return found.answer;
    args = { ...args, channel: found.id };
  }
  if (method === "conversations.history" || method === "conversations.replies") return readMessages(accessToken, method, args);
  if (method === "search.messages") return searchMessages(accessToken, args);
  if (POSTS.has(method) && typeof args.channel === "string") {
    const to = await postChannel(accessToken, args.channel.trim());
    if ("answer" in to) return to.answer;
    return slackCall(accessToken, method, { ...args, channel: to.channel });
  }
  const listing = Object.hasOwn(LISTINGS, method) ? LISTINGS[method] : undefined;
  if (listing === undefined) return slackCall(accessToken, method, args);
  const { match, include_inactive, limit, cursor, ...rest } = args;
  const everyone = truthy(include_inactive);
  const wanted = typeof match === "string" ? fold(match).split(/\s+/).filter(Boolean) : [];
  const want = Number(limit) > 0 ? Math.floor(Number(limit)) : DEFAULT_RETURN;
  const query: Record<string, unknown> = { ...(everyone ? {} : (listing.narrow ?? {})), ...rest, limit: PAGE };

  const found: Entry[] = [];
  let next = typeof cursor === "string" && cursor !== "" ? cursor : undefined;
  let status = 200;
  let stopped: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await slackCall(accessToken, method, next === undefined ? query : { ...query, cursor: next });
    status = answer.status;
    const body = (answer.body ?? {}) as Entry;
    // The first page failing is Slack's answer as it stands (a gone token is read from it); a later one ends the read early.
    if (body.ok !== true) {
      if (page === 0) return answer;
      stopped = typeof body.error === "string" ? body.error : "not_ok";
      break;
    }
    const raws = Array.isArray(body[listing.key]) ? (body[listing.key] as Entry[]) : [];
    for (const raw of raws) {
      if (!everyone && !listing.active(raw)) continue;
      const slim = listing.slim(raw);
      if (wanted.length > 0) {
        const words = fold(listing.words(slim));
        if (!wanted.every((word) => words.includes(word))) continue;
      }
      found.push(slim);
    }
    const meta = (body.response_metadata ?? {}) as Entry;
    next = typeof meta.next_cursor === "string" && meta.next_cursor !== "" ? meta.next_cursor : undefined;
    if (next === undefined || found.length >= want) break;
  }

  const shown = found.slice(0, want);
  // Resuming mid-page would skip what that page held past the limit, so a cut answer says to narrow instead.
  const more =
    found.length > shown.length ? "there are more; pass match to narrow, or a larger limit" : next !== undefined ? `pass cursor ${next} for the rest` : undefined;
  return {
    status,
    body: compact({
      ok: true,
      [listing.key]: shown,
      count: shown.length,
      only: everyone ? undefined : listing.key === "members" ? "active people (no bots or deactivated accounts)" : "open channels (none archived)",
      match: wanted.length > 0 ? wanted.join(" ") : undefined,
      more,
      stopped: stopped === undefined ? undefined : `Slack stopped answering part way (${stopped}); this is what was read before that`,
    }),
  };
}
