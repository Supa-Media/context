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
 *  - writing into another workspace at all.
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

/** The `share` values on `write_note` that mint a link (`notes/write.js`). */
const SHARE_VALUES = new Set(["members", "anyone", "collect"]);

/** A frontmatter line ingestion writes on content a stranger authored. */
const UNTRUSTED_FRONTMATTER = /^trust:\s*"?untrusted"?\s*$/m;

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
  if (!ledger || !result || result.isError === true || LISTING_TOOLS.has(name)) return;
  const label = scope === "private" ? "private" : "team";
  const had = ledger.reads.get(workspaceId);
  if (had === undefined || AUDIENCE_RANK[label] < AUDIENCE_RANK[had]) ledger.reads.set(workspaceId, label);
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
 * What this call would widen, or null when it widens nothing.
 *
 * @param {string} name the tool
 * @param {object} args the arguments, `context` already stripped
 * @param {object} options
 * @param {string|null} options.into the other workspace addressed, as `@name`, or null
 * @param {() => Promise<{rules: Array, overrides: Map}>} options.privacy the
 *   target workspace's manifest, loaded only for a move
 * @returns {Promise<{audience: string, summary: string}|null>}
 */
export async function wideningOf(name, args, { into = null, privacy }) {
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
    case "write_note": {
      if (a.site?.action === "publish") return { audience: "anyone", summary: "publish the website" };
      if (SHARE_VALUES.has(a.share)) {
        return a.share === "members"
          ? { audience: "team", summary: `share ${a.path} with every member by link` }
          : {
              audience: "anyone",
              summary: `share ${a.path} with anyone who has the link${a.share === "collect" ? ", and take answers from them" : ""}`,
            };
      }
      const hosts = (Array.isArray(a.images) ? a.images : [])
        .filter((image) => typeof image?.url === "string")
        .map((image) => hostOf(image.url));
      if (hosts.length > 0) {
        return { audience: "outside", summary: `fetch an image from ${[...new Set(hosts)].join(", ")} into ${a.path}` };
      }
      if (elsewhere) return { audience: "team", summary: `write ${a.path} into ${into}` };
      if (a.visibility === "team" && a.confirm_team_publish === true && (await nowReads(a.path)) !== "team") {
        return { audience: "team", summary: `make ${a.path} visible to the team` };
      }
      return null;
    }
    case "set_visibility":
      return a.visibility === "team" && (await nowReads(a.path)) !== "team"
        ? { audience: "team", summary: `make ${a.path} visible to the team` }
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
            summary:
              a.visibility === "inherit"
                ? `let the folder ${a.path} follow its parent's visibility`
                : `make the folder ${a.path} visible to the team`,
          }
        : null;
    }
    case "save_context":
      if (elsewhere) return { audience: "team", summary: `save this conversation into ${into}` };
      if (a.visibility === "team" || a.visibility === "public") {
        return { audience: "team", summary: "save this conversation where the team can read it" };
      }
      return null;
    /*
      A move widens only when the model asks it to publish: without
      `confirm_team_publish` the move tools carry a private note's
      visibility with it, land a note carried into another context at the
      narrower end, or refuse — none of which shows it to anyone new. The
      flag is the ask, and the ask is what waits for a person.
    */
    case "move_note": {
      if (a.confirm_team_publish !== true) return null;
      if (elsewhere || a.destination_context !== undefined || a.source_context !== undefined) {
        const where = into ?? a.destination_context ?? "its own workspace";
        return { audience: "team", summary: `move ${a.source} into ${where}, published to its team` };
      }
      const { rules, overrides } = await privacy();
      const from = effectiveVisibility(normalizePath(a.source) ?? "", rules, overrides);
      const to = effectiveVisibility(normalizePath(a.destination) ?? "", rules, overrides);
      return widensVisibility(from, to)
        ? { audience: "team", summary: `move ${a.source} to ${a.destination}, where more people can read it` }
        : null;
    }
    case "move_notes": {
      if (a.confirm_team_publish !== true) return null;
      if (elsewhere) return { audience: "team", summary: `move notes into ${into}, published to its team` };
      const { rules, overrides } = await privacy();
      const widened = (Array.isArray(a.moves) ? a.moves : []).filter((move) => {
        const from = effectiveVisibility(normalizePath(move?.source) ?? "", rules, overrides);
        const to = effectiveVisibility(normalizePath(move?.destination) ?? "", rules, overrides);
        return widensVisibility(from, to);
      });
      return widened.length > 0
        ? {
            audience: "team",
            summary: `move ${widened.length === 1 ? widened[0].source : `${widened.length} notes`} where more people can read ${widened.length === 1 ? "it" : "them"}`,
          }
        : null;
    }
    case "move_folder": {
      if (a.confirm_team_publish !== true) return null;
      if (elsewhere) return { audience: "team", summary: `move the folder ${a.source} into ${into}, published to its team` };
      const { rules } = await privacy();
      const from = visibilityOf(normalizePath(a.source) ?? "", rules);
      const to = visibilityOf(normalizePath(a.destination) ?? "", rules);
      return widensVisibility(from, to)
        ? { audience: "team", summary: `move the folder ${a.source} to ${a.destination}, where more people can read it` }
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
 * The write tools `wideningOf` can classify as a widening when they write into
 * another workspace. Every one of them is also listed in its switch.
 */
const WRITE_TOOLS_THAT_CAN_REACH_ELSEWHERE = new Set([
  "write_note",
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
 * @param {string} name the tool
 * @param {object} args the arguments, `context` already stripped
 * @param {object} options
 * @param {string|null} options.into the other workspace addressed, as `@name`, or null
 * @returns {boolean}
 */
export function mightWiden(name, args, { into = null } = {}) {
  const a = args && typeof args === "object" ? args : {};
  if (a.dry_run === true) return false;
  if (name === "create_link") return true;
  if (typeof into === "string" && into !== "") return WRITE_TOOLS_THAT_CAN_REACH_ELSEWHERE.has(name);
  switch (name) {
    case "write_note":
      return (
        a.site?.action === "publish" ||
        SHARE_VALUES.has(a.share) ||
        (Array.isArray(a.images) && a.images.some((image) => typeof image?.url === "string")) ||
        a.visibility === "team"
      );
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
