/**
 * THE EGRESS GATE: an AI client never widens who can see something without a
 * person saying yes, and the yes is checked here, outside the model.
 *
 * ## Why a prompt is not enough
 *
 * The gateway already fences content strangers wrote (an email in `0-inbox/`,
 * a web page the texting assistant opened) and tells the model not to follow
 * instructions in it. That makes an attack rarer, not impossible: the labs'
 * own numbers put a frontier model's failure rate on a planted instruction at
 * a few percent per attempt, and an instruction written to look like a normal
 * step of the task ("the client asked for a public link to the Q3 notes") has
 * nothing in it a fence can catch. At thousands of turns a day, a defence that
 * fails one time in fifty leaks daily. The reliable fix is the one every
 * information-flow design lands on: private data, untrusted content and a way
 * to send something out are safe in any two, never all three. This file
 * removes the third leg for the few tool calls that are it.
 *
 * ## What is a widening
 *
 * A tool call that lets more people read something than can read it now, or
 * that hands something to an address outside the workspace:
 *
 *  - minting a share link, by `create_link` or by `share` on `write_note`;
 *  - publishing the website;
 *  - fetching an image from an address the model chose (`images[].url`: the
 *    address itself is the channel, a note's text can ride in it);
 *  - making a note or a folder team-visible, or saving a conversation that way;
 *  - moving notes, when the move is asked to publish them (`confirm_team_publish`)
 *    into a folder more people can see or into another workspace;
 *  - writing into another workspace at all: any tool that is not read-only,
 *    whether or not it is listed below (`writes`, from the tool definitions).
 *    A move into another workspace counts with or without the publish flag.
 *
 * Reads, and ordinary writes inside the workspace the call started in, are
 * never a widening and never ask. Nor is `report_problem`: its one
 * destination is Context's own support intake, not an address the model
 * chooses, and a channel to the people who run the product is not the leak
 * this gate exists for. A dry run (`dry_run: true`) changes nothing and is
 * never held.
 *
 * ## When a widening needs a person
 *
 * A turn the gateway sees whole — a texted question, the app's agent panel —
 * keeps a ledger of what the model read: which workspaces, at which visibility,
 * and whether anything came from outside (a mailbox day, a meeting, a web
 * page). A widening then asks for approval only when the turn has read
 * something the new audience could not already see, or anything untrusted.
 * A turn that read nothing is the person's own words, and runs.
 *
 * An MCP client's turn is NOT seen whole: Claude Desktop reads web pages with
 * its own tools, and a planted instruction there reaches this gateway as a
 * clean `create_link`. So a widening from an MCP client always needs a person,
 * whatever this gateway saw. The one exception is a call a person already
 * approved, which is replayed by the approver's own session and marked so.
 *
 * ## Who says yes
 *
 * Never the model, and never anything the model can call. The texting
 * assistant's person replies YES on the thread (`agent/route.js`, checked
 * before any model runs, and only for what that thread asked); the app's
 * owner approves in `/approvals` (`http/approvals.js`, first-party client
 * only). An MCP client has no way to approve its own call.
 *
 * Decided by the owner, 2026-10-09; see
 * docs/decisions/privacy-and-sharing/agent-egress.md.
 */

import { classifyCaptureKind } from "../communications/paths.js";
import { effectiveVisibility, visibilityOf } from "./engine.js";
import { normalizePath } from "../notes/paths.js";

/**
 * How far a label reaches. `outside` is an address that is not this product
 * at all: an image host, support's inbox.
 */
export const AUDIENCE_RANK = { private: 0, team: 1, anyone: 2, outside: 3 };

/**
 * Tools whose results are, by construction, words people other than the person
 * wrote: a mailbox day, a contact page built from senders' own claims, a
 * meeting's transcript.
 */
export const UNTRUSTED_READS = new Set(["read_channel_day", "read_contact", "read_meeting"]);

/**
 * Tools whose results carry names, counts and settings, never a note's words.
 * Everything else that reads is content, and marks the turn.
 */
export const LISTING_TOOLS = new Set([
  "scope_info",
  "list_notes",
  "list_meetings",
  "list_channel_days",
  "list_contacts",
  "list_links",
  "list_proposals",
  "list_plugins",
  "suggest_destination",
]);

/**
 * Listings that still carry words a stranger chose, so they are not "names,
 * not content": a meeting's title and attendees come off a calendar invite
 * anyone can send, a contact's name and organisation off the sender's own
 * message, a proposal's reason off whichever agent filed it, and a plugin's
 * name and author off its manifest. A listing
 * that returns one marks the turn untrusted, though it marks nothing read.
 */
export const UNTRUSTED_LISTINGS = new Set(["list_meetings", "list_contacts", "list_proposals", "list_plugins"]);

/** The `share` values on `write_note` that mint a link (`notes/write.js`). */
const SHARE_VALUES = new Set(["members", "anyone", "collect"]);

/** A frontmatter line ingestion writes on content a stranger authored. */
const UNTRUSTED_FRONTMATTER = /^trust:\s*"?untrusted"?\s*$/m;

/**
 * What one read handed the model from workspaces OTHER than the one the call
 * was addressed to.
 *
 * `search_notes` with no `context` searches every workspace the person can
 * reach and fuses one list (`tools/search.js`), so a single call hands over
 * notes from several workspaces while `callToolForSession` knows only the one
 * it routed to. The ledger is what `approvalRequired` reads to decide whether
 * this turn may widen anything, and a read it never heard about is a read it
 * cannot weigh: without this, a turn holding another workspace's notes looked
 * exactly like a turn that had only read its own.
 *
 * Carried on the result under a Symbol, the way `live/activityHint.js` carries
 * its own: invisible to `JSON.stringify` and to object spread, so it never
 * reaches a client, and lost harmlessly by any wrapper that builds a new
 * result — losing it can only make the gate hold more, never less.
 */
const READ_REACH = Symbol("context.readReach");

/**
 * Attach the workspaces a read reached, as `[{workspaceId, scope}]`.
 *
 * `scope` is this session's tier in that workspace, which is the widest
 * anything from it could be — the same assumption `recordRead` makes for the
 * workspace a call was addressed to.
 */
export function withReadReach(result, reached) {
  if (result && typeof result === "object" && Array.isArray(reached)) {
    Object.defineProperty(result, READ_REACH, { value: reached, enumerable: false });
  }
  return result;
}

/** The workspaces a read reached beyond the one it was addressed to. */
export function readReachOf(result) {
  const reached = result && typeof result === "object" ? result[READ_REACH] : undefined;
  return Array.isArray(reached) ? reached : [];
}

/** A fresh ledger for one turn the gateway sees whole. */
export function newLedger() {
  return { reads: new Map(), untrusted: false, asked: [] };
}

/** Mark the ledger: the turn took in something from outside the workspace. */
export function markUntrusted(ledger) {
  if (ledger) ledger.untrusted = true;
}

/**
 * Record what a read handed the model. `scope` is the session's tier in the
 * workspace read, which is the widest anything it returned could be: the
 * ledger assumes the worst rather than parsing every result.
 */
export function recordRead(ledger, { name, args, scope, workspaceId, result }) {
  if (!ledger || !result || result.isError === true) return;
  if (LISTING_TOOLS.has(name)) {
    if (UNTRUSTED_LISTINGS.has(name)) ledger.untrusted = true;
    return;
  }
  const mark = (id, tier) => {
    if (typeof id !== "string" || id === "") return;
    const label = tier === "private" ? "private" : "team";
    const had = ledger.reads.get(id);
    if (had === undefined || AUDIENCE_RANK[label] < AUDIENCE_RANK[had]) ledger.reads.set(id, label);
  };
  mark(workspaceId, scope);
  // And every other workspace this one call read from (`readReachOf`).
  for (const reached of readReachOf(result)) mark(reached?.workspaceId, reached?.scope);
  if (UNTRUSTED_READS.has(name) || readsCapturedContent(name, args) || carriesUntrustedFrontmatter(result)) {
    ledger.untrusted = true;
  }
}

/** A note read by path that is a mailbox day, a calendar day, a meeting or a saved chat. */
function readsCapturedContent(name, args) {
  const raw = name === "fetch" ? args?.id : args?.path;
  const path = typeof raw === "string" ? normalizePath(raw) : null;
  return path !== null && path !== undefined && classifyCaptureKind(path) !== null;
}

function carriesUntrustedFrontmatter(result) {
  const text = result?.content?.[0]?.text;
  return typeof text === "string" && UNTRUSTED_FRONTMATTER.test(text.slice(0, 2000));
}

function widensVisibility(from, to) {
  if (from === to || to === "private") return false;
  // team → a named group is narrower; anything else that changes reaches new people.
  return !(from === "team" && typeof to === "string" && to.startsWith("@"));
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "an address";
  }
}

/**
 * A summary is one plain line. It is built from arguments the model wrote (a
 * path, an address) and read by a person who is about to say yes to it, in
 * the gateway's own voice: a line break, a control character or a bidi
 * override in it would let the model add sentences the person takes to be the
 * gateway's, or reorder the ones that are.
 */
export function oneLine(text) {
  return String(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The widest of several audiences. */
function widest(audiences) {
  return audiences.reduce((a, b) => (AUDIENCE_RANK[b] > AUDIENCE_RANK[a] ? b : a));
}

/**
 * What this call would widen, or null when it widens nothing.
 *
 * @param {string} name the tool, already resolved from any alias
 * @param {object} args the arguments, `context` already stripped
 * @param {object} options
 * @param {string|null} options.into the other workspace addressed, as `@name`, or null
 * @param {boolean} [options.writes] the tool changes something (it is not read-only
 *   and not a planning tool): addressed into another workspace it is a widening
 *   whatever else it does, so a write tool this file has never heard of cannot
 *   slip through by being absent from the switch
 * @param {() => Promise<{rules: Array, overrides: Map}>} options.privacy the
 *   target workspace's manifest, loaded only for a move
 * @returns {Promise<{audience: string, summary: string}|null>}
 */
export async function wideningOf(name, args, { into = null, privacy, writes = false }) {
  const found = await classify(name, args, { into, privacy });
  const a = args && typeof args === "object" ? args : {};
  const elsewhere = typeof into === "string" && into !== "";
  const widening =
    found ?? (elsewhere && writes && a.dry_run !== true ? { audience: "team", summary: `change something in ${into} (${name})` } : null);
  return widening === null ? null : { ...widening, summary: oneLine(widening.summary) };
}

async function classify(name, args, { into, privacy }) {
  const a = args && typeof args === "object" ? args : {};
  if (a.dry_run === true) return null;
  const elsewhere = typeof into === "string" && into !== "";
  /** What `path` reads as now, by the target's manifest: a publish to that is no widening. */
  const nowReads = async (path) => {
    const { rules, overrides } = await privacy();
    return effectiveVisibility(normalizePath(path) ?? "", rules, overrides);
  };
  switch (name) {
    case "create_link": {
      const audience = a.audience === "members" ? "team" : "anyone";
      const what = a.kind === "folder" ? `the folder ${a.path}` : a.path;
      return {
        audience,
        summary:
          audience === "anyone"
            ? `share ${what} with anyone who has the link${a.mode === "collect" ? ", and take answers from them" : ""}`
            : `share ${what} with every member by link`,
      };
    }
    /*
      A call can widen in several ways at once, and a person who is asked
      about one of them has said yes to all of them, so every one is named.
    */
    case "write_note":
    case "create_form": {
      const facets = [];
      if (name === "write_note") {
        if (a.site?.action === "publish") facets.push({ audience: "anyone", summary: "publish the website" });
        if (SHARE_VALUES.has(a.share)) {
          facets.push(
            a.share === "members"
              ? { audience: "team", summary: `share ${a.path} with every member by link` }
              : {
                  audience: "anyone",
                  summary: `share ${a.path} with anyone who has the link${a.share === "collect" ? ", and take answers from them" : ""}`,
                },
          );
        }
        const hosts = (Array.isArray(a.images) ? a.images : [])
          .filter((image) => typeof image?.url === "string")
          .map((image) => hostOf(image.url));
        if (hosts.length > 0) {
          facets.push({ audience: "outside", summary: `fetch an image from ${[...new Set(hosts)].join(", ")} into ${a.path}` });
        }
      }
      if (elsewhere) facets.push({ audience: "team", summary: `write ${a.path} into ${into}` });
      // The ask is the flag: without it the tool refuses a publication itself,
      // and the gate supplies the flag only for a call that carried it, so an
      // approval given for an image address cannot publish the note as well.
      if (a.visibility === "team" && a.confirm_team_publish === true && (await nowReads(a.path)) !== "team") {
        facets.push({ audience: "team", summary: `make ${a.path} visible to the team`, publishes: true });
      }
      return facets.length === 0
        ? null
        : {
            audience: widest(facets.map((facet) => facet.audience)),
            summary: facets.map((facet) => facet.summary).join(", and "),
            publishes: facets.some((facet) => facet.publishes === true),
          };
    }
    case "set_visibility":
      return a.visibility === "team" && (await nowReads(a.path)) !== "team"
        ? { audience: "team", summary: `make ${a.path} visible to the team`, publishes: true }
        : null;
    case "set_folder_visibility": {
      if (a.visibility !== "team" && a.visibility !== "inherit") return null;
      const { rules } = await privacy();
      const folder = normalizePath(a.path) ?? "";
      const current = visibilityOf(folder, rules);
      // Inheriting widens only when the parent's default is wider than this
      // folder's own; a folder already at team, or under a private parent,
      // shows nobody anything new.
      const after = a.visibility === "team" ? "team" : visibilityOf(folder.split("/").slice(0, -1).join("/"), rules);
      return widensVisibility(current, after)
        ? {
            audience: "team",
            publishes: true,
            summary:
              a.visibility === "inherit"
                ? `let the folder ${a.path} follow its parent's visibility`
                : `make the folder ${a.path} visible to the team`,
          }
        : null;
    }
    case "save_context":
      if (elsewhere) {
        return { audience: "team", summary: `save this conversation into ${into}`, publishes: a.visibility === "team" || a.visibility === "public" };
      }
      if (a.visibility === "team" || a.visibility === "public") {
        return { audience: "team", summary: "save this conversation where the team can read it", publishes: true };
      }
      return null;
    /*
      Inside one workspace a move widens only when the model asks it to
      publish: without `confirm_team_publish` the move tools carry a note's
      visibility with it or refuse, which shows it to nobody new. The flag is
      the ask, and the ask is what waits for a person.

      Into another workspace it widens with or without the flag: a note that
      is team-visible here lands team-visible there, and "team" there is
      other people. Which workspace is decided by where the call lands, not
      by which of its arguments the model chose to spell.
    */
    case "move_note": {
      const published = a.confirm_team_publish === true;
      if (elsewhere || a.destination_context !== undefined || a.source_context !== undefined) {
        const where = into ?? a.destination_context ?? "its own workspace";
        return { audience: "team", summary: `move ${a.source} into ${where}${published ? ", published to its team" : ""}`, publishes: published };
      }
      if (!published) return null;
      const { rules, overrides } = await privacy();
      const from = effectiveVisibility(normalizePath(a.source) ?? "", rules, overrides);
      const to = effectiveVisibility(normalizePath(a.destination) ?? "", rules, overrides);
      return widensVisibility(from, to)
        ? { audience: "team", summary: `move ${a.source} to ${a.destination}, where more people can read it`, publishes: true }
        : null;
    }
    case "move_notes": {
      const published = a.confirm_team_publish === true;
      if (elsewhere) return { audience: "team", summary: `move notes into ${into}${published ? ", published to its team" : ""}`, publishes: published };
      if (!published) return null;
      const { rules, overrides } = await privacy();
      const widened = (Array.isArray(a.moves) ? a.moves : []).filter((move) => {
        const from = effectiveVisibility(normalizePath(move?.source) ?? "", rules, overrides);
        const to = effectiveVisibility(normalizePath(move?.destination) ?? "", rules, overrides);
        return widensVisibility(from, to);
      });
      return widened.length > 0
        ? {
            audience: "team",
            publishes: true,
            summary: `move ${widened.length === 1 ? widened[0].source : `${widened.length} notes`} where more people can read ${widened.length === 1 ? "it" : "them"}`,
          }
        : null;
    }
    case "move_folder": {
      const published = a.confirm_team_publish === true;
      if (elsewhere) {
        return {
          audience: "team",
          summary: `move the folder ${a.source} into ${into}${published ? ", published to its team" : ""}`,
          publishes: published,
        };
      }
      if (!published) return null;
      const { rules } = await privacy();
      const from = visibilityOf(normalizePath(a.source) ?? "", rules);
      const to = visibilityOf(normalizePath(a.destination) ?? "", rules);
      return widensVisibility(from, to)
        ? { audience: "team", summary: `move the folder ${a.source} to ${a.destination}, where more people can read it`, publishes: true }
        : null;
    }
    case "remember":
    case "propose_note":
    case "submit_form":
    case "update_submission":
      return elsewhere ? { audience: "team", summary: `write into ${into}` } : null;
    default:
      return null;
  }
}

/**
 * The write tools to treat as writes when a caller does not say (the pure
 * tests do not). The gate itself passes `writes` from the tool definitions.
 */
const WRITE_TOOLS_THAT_CAN_REACH_ELSEWHERE = new Set([
  "write_note",
  "create_form",
  "set_visibility",
  "set_folder_visibility",
  "save_context",
  "move_note",
  "move_notes",
  "move_folder",
  "remember",
  "propose_note",
  "submit_form",
  "update_submission",
]);

/**
 * Whether `wideningOf` could classify this call as a widening, judged from its
 * tool and arguments alone: the manifest is not read, so this is a superset.
 *
 * It exists for a call whose widening has already been released. Once a
 * person approves a held call and it runs, the same call asked again no longer
 * widens (the note is team now), so `wideningOf` says null, and the released
 * result would never be handed back: the re-call would run again, with the
 * arguments it had been released against gone stale. The gate therefore still
 * consults the done record for any call this could have held, and a false
 * positive costs one read of the done records, which is harmless because a
 * record only exists for a call a person released. A false negative would
 * leave a released call without its result, so this errs wide.
 *
 * Never true for a dry run, which is never held and changes nothing.
 *
 * @param {string} name the tool, already resolved from any alias
 * @param {object} args the arguments, `context` already stripped
 * @param {object} options
 * @param {string|null} options.into the other workspace addressed, as `@name`, or null
 * @param {boolean} [options.writes] as for `wideningOf`
 * @returns {boolean}
 */
export function mightWiden(name, args, { into = null, writes } = {}) {
  const a = args && typeof args === "object" ? args : {};
  if (a.dry_run === true) return false;
  if (name === "create_link") return true;
  if (typeof into === "string" && into !== "") return writes ?? WRITE_TOOLS_THAT_CAN_REACH_ELSEWHERE.has(name);
  switch (name) {
    case "write_note":
      return (
        a.site?.action === "publish" ||
        SHARE_VALUES.has(a.share) ||
        (Array.isArray(a.images) && a.images.some((image) => typeof image?.url === "string")) ||
        a.visibility === "team"
      );
    case "create_form":
      return a.visibility === "team";
    case "set_visibility":
      return a.visibility === "team";
    case "set_folder_visibility":
      return a.visibility === "team" || a.visibility === "inherit";
    case "save_context":
      return a.visibility === "team" || a.visibility === "public";
    case "move_note":
    case "move_notes":
    case "move_folder":
      return a.confirm_team_publish === true;
    default:
      return false;
  }
}

/**
 * Whether a widening must wait for a person.
 *
 * `egress` is what the caller attached to the session: `{ approved: true }`
 * for a call a person already approved; `{ complete: true, ledger, texting }`
 * for a turn this gateway sees whole; absent for an MCP client, whose turn it
 * does not, so absent fails closed.
 */
export function approvalRequired(egress, widening, targetWorkspaceId) {
  if (!widening) return false;
  if (egress?.approved === true) return false;
  if (egress?.complete !== true || !egress.ledger) return true;
  const { ledger } = egress;
  if (ledger.untrusted) return true;
  for (const [workspaceId, label] of ledger.reads) {
    if (workspaceId !== targetWorkspaceId) return true;
    if (AUDIENCE_RANK[label] < AUDIENCE_RANK[widening.audience]) return true;
  }
  return false;
}

/** Why the turn needs a person, in the words the model is told. */
export function reasonFor(egress) {
  if (egress?.ledger?.untrusted) return "this conversation read content from outside the workspace";
  if (egress?.complete === true) return "this conversation read notes the new audience cannot see";
  return "a connected AI client cannot widen who can see something on its own";
}
