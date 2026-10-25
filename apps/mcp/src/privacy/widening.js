/**
 * WHAT A CALL WOULD WIDEN, in the gateway's own words: the one line the
 * sharing judge (`judge.js`) is shown beside the person's words.
 *
 * A call widens when it lets more people read something than can read it now,
 * or hands something to an address outside the workspace: a link, publishing
 * the website, an image fetched from an address the model chose, a visibility
 * change where the manifest reads narrower now, naming people on a note, a
 * move asked to publish, and any write into another workspace. The approvals
 * that once held these were removed on 2026-10-17; the owner then asked
 * (2026-10-18) for the person's own words, read by a judge, to decide them.
 */

import { effectiveVisibility, narrowerVisibility, visibilityOf } from "./engine.js";
import { normalizePath } from "../notes/paths.js";
import { describePeople, parsePeople } from "../tools/notePeople.js";
import { oneLine } from "./egress.js";

const SHARE_VALUES = new Set(["members", "anyone", "collect"]);

/** Who can read, narrowest first: a call is summed up by the widest it reaches. */
const AUDIENCE_RANK = { private: 0, team: 1, anyone: 2, outside: 3 };

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
 * Whether any of these moves lands where more people can read it than can
 * now, by the addressed workspace's own manifest. A folder is read by its
 * folder rules alone, as `move_folder` carries them.
 *
 * A note is read as it will read after the move: the narrower of what it is
 * and what its new folder grants, which is what `move_note` and
 * `move_notes` install (`narrowerVisibility`). Measuring the new folder alone
 * judged a private note moved into a team folder as published, though it
 * lands private; that refused Tex's reorganize in @supa a second time, after
 * the first fix (2026-10-25, "yes move them").
 */
async function anyWidens(privacy, moves, { folders = false } = {}) {
  const { rules, overrides } = await privacy();
  const reads = (path) => {
    const at = normalizePath(path) ?? "";
    return folders ? visibilityOf(at, rules) : effectiveVisibility(at, rules, overrides);
  };
  return moves.some((move) => {
    const from = reads(move?.source);
    const to = reads(move?.destination);
    return widensVisibility(from, folders ? to : narrowerVisibility(from, to));
  });
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
 * @returns {Promise<{audience: string, summary: string, publishes?: boolean, elsewhereOnly?: boolean}|null>}
 *   `elsewhereOnly` marks a call whose one widening is an ordinary write into
 *   another workspace the caller belongs to: no link, no publication, nobody
 *   named. The judge (`judge.js`) lets those run unjudged, as they ran with no gate.
 */
export async function wideningOf(name, args, { into = null, privacy, writes = false }) {
  const found = await classify(name, args, { into, privacy });
  const a = args && typeof args === "object" ? args : {};
  const elsewhere = typeof into === "string" && into !== "";
  const widening =
    found ??
    (elsewhere && writes && a.dry_run !== true
      ? { audience: "team", summary: `change something in ${into} (${name})`, elsewhereOnly: true }
      : null);
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
      if (elsewhere) facets.push({ audience: "team", summary: `write ${a.path} into ${into}`, elsewhere: true });
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
            elsewhereOnly: facets.every((facet) => facet.elsewhere === true),
          };
    }
    // A request through Context goes to a site outside the workspace, and its
    // body or address can carry what the turn read, as an image address can.
    case "vault_list":
      return a.fetch && typeof a.fetch === "object"
        ? { audience: "outside", summary: `send a request to ${hostOf(a.fetch.url)} with a saved key` }
        : null;
    /*
      Naming people (`people`) always widens: a member, a group, an address
      outside the workspace or a whole domain each reach somebody who could
      not open the note before, and the gate cannot tell a member's handle
      from an outsider's without asking the control plane, so every name is
      read as the widest, an address outside the product. Both facets are
      named when the call also publishes.
    */
    case "set_visibility": {
      const facets = [];
      if (a.visibility === "team" && (await nowReads(a.path)) !== "team") {
        facets.push({ audience: "team", summary: `make ${a.path} visible to the team`, publishes: true });
      }
      const people = parsePeople(a.people);
      if (people !== null) facets.push({ audience: "outside", summary: `let ${describePeople(people)} open ${a.path}` });
      return facets.length === 0
        ? null
        : {
            audience: widest(facets.map((facet) => facet.audience)),
            summary: facets.map((facet) => facet.summary).join(", and "),
            publishes: facets.some((facet) => facet.publishes === true),
          };
    }
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
        const publishes = a.visibility === "team" || a.visibility === "public";
        return { audience: "team", summary: `save this conversation into ${into}`, publishes, elsewhereOnly: !publishes };
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

      The one exception is a call addressed with `context` alone, not asked to
      publish, whose every move stays inside that workspace and, read by that
      workspace's own manifest, lets nobody new see the note: it is the same
      relocation as one at home, an ordinary write there, and is not judged
      (`elsewhereOnly`). Judging it as a move "into" the workspace refused Tex
      every move in its owner's own shared workspace (2026-10-24, "merge all
      the efforts into 1 coherent project folder"): the judge read "move X
      into @supa" as sharing, which nothing asked for. The owner said yes to
      this exception (2026-10-25). A move whose destination reads wider there
      is still judged as before.
    */
    case "move_note": {
      const published = a.confirm_team_publish === true;
      if (elsewhere && !published && a.destination_context === undefined && a.source_context === undefined &&
          !(await anyWidens(privacy, [a]))) {
        return null;
      }
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
      if (elsewhere && !published && Array.isArray(a.moves) && !(await anyWidens(privacy, a.moves))) return null;
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
      if (elsewhere && !published && !(await anyWidens(privacy, [a], { folders: true }))) return null;
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
      return elsewhere ? { audience: "team", summary: `write into ${into}`, elsewhereOnly: true } : null;
    default:
      return null;
  }
}
