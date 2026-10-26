/**
 * WHAT TEX'S HOUSEKEEPING MAY TOUCH (owner, 2026-10-17).
 *
 * "It should be going in and fiercely organizing things, updating project
 * statuses, archiving, getting the chaos score lower." Nobody is watching
 * while it works, so everything it may do is decided here, before the
 * session's own dispatcher is reached, the same way a dream is held to its
 * one note (`dream.js`):
 *
 *   - Reads of their own notes: orient, search, read, list.
 *   - Changes Context can undo: moving a note, a batch of notes or a folder,
 *     archiving a note, and rewriting a note that already exists (its history
 *     keeps the old text). Each is logged with how to put it back.
 *   - Nothing that lets more people see anything (no visibility, no link, no
 *     publish, no move that asks to publish), nothing in another workspace,
 *     nothing that sends, and nothing created from nothing.
 *   - Never Tex's own folder, routines, the website, a root note or the
 *     storage's own files: those are run by other parts of the product, and a
 *     tidy that moves them breaks them.
 *   - A rewrite that would drop most of a note is refused: housekeeping
 *     changes front matter and merges duplicates, it never cuts.
 *   - A whole top-level folder is never moved: archiving "all projects" is
 *     not housekeeping, it is a decision. Nor is a new one made: everything
 *     lands in a built-in folder or a top-level folder that already has notes.
 *   - No path may name a workspace (`@name/…`): the session routes those to
 *     that workspace, so one would carry a change out of this one.
 *   - No cap on how much one run changes (owner, 2026-10-17: "remove
 *     limit"): every change is still one of the above, logged with its undo.
 *   - Many notes move by their names (`move_notes { folder, match, into }`):
 *     the run names a pattern and the gateway lists and moves the notes, a
 *     hundred a batch, each batch through every check above. Writing out
 *     ~360 moves by hand spent a run's whole budget on one timed-out call
 *     (@seyi, 2026-10-26).
 */

import { mightWiden } from "../privacy/egress.js";

/** Tools a housekeeping run may read with. */
export const HOUSEKEEPING_READS = new Set(["orient", "search_notes", "read_note", "list_notes"]);
/** Tools that change something, each one Context can undo. */
export const HOUSEKEEPING_CHANGES = new Set(["write_note", "move_note", "move_notes", "move_folder", "archive_note"]);

/** The six-tool actions a run is shown (`sixTools.js`). */
export const HOUSEKEEPING_GRANTS = { write: ["save"], manage: ["move", "move_many", "move_folder", "archive"] };

/** A rewrite keeps at least this share of the note's text. */
export const MIN_KEPT_SHARE = 0.6;

/** Run by other parts of the product: housekeeping never moves, archives or rewrites them. */
const PROTECTED_PREFIXES = ["tex/", "routines/", "website/", ".context/"];

/** The built-in folders a workspace may have, empty or not: PARA, and a business's three (numbered or not). */
const BUILT_IN_FOLDER = /^(\d+-)?(inbox|projects|areas|resources|archive|clients|teams|products)$/i;

/** The arguments each changing tool may carry; anything else is refused by name. */
const ALLOWED_ARGS = {
  write_note: new Set(["path", "content", "expected_etag"]),
  move_note: new Set(["source", "destination", "expected_source_etag"]),
  move_notes: new Set(["moves", "dry_run"]),
  matching: new Set(["folder", "match", "into", "dry_run"]),
  move_folder: new Set(["source", "destination", "dry_run"]),
  archive_note: new Set(["path", "expected_etag"]),
};

function refused(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

const textOf = (result) => (Array.isArray(result?.content) ? result.content : []).map((part) => part?.text ?? "").join("\n");

/** A path as compared here: no leading slash, no `./`. */
function plain(path) {
  return String(path ?? "").trim().replace(/^\.?\/+/, "");
}

/**
 * Why housekeeping may not touch `path`, or null. Folders are passed with or
 * without their slash. `runFolders` are the folders doing Tex's and the
 * website's jobs wherever a person nested them (owner, 2026-10-18).
 */
export function protectedReason(path, runFolders = []) {
  const p = plain(path);
  if (p === "") return "the whole workspace";
  const asFolder = p.endsWith("/") ? p : `${p}/`;
  for (const prefix of [...PROTECTED_PREFIXES, ...runFolders.map((folder) => `${plain(folder).replace(/\/+$/, "")}/`)]) {
    if (prefix !== "/" && asFolder.startsWith(prefix)) return `${prefix} is run by Context itself`;
  }
  if (!p.includes("/") && !p.endsWith("/") && /\.[a-z0-9]+$/i.test(p)) return "a note at the top of the workspace is the person's own front page or list";
  return null;
}

/** The paths a changing call touches, both ends of a move. */
function pathsOf(name, args) {
  switch (name) {
    case "write_note":
    case "archive_note":
      return [args.path];
    case "move_note":
    case "move_folder":
      return [args.source, args.destination];
    case "move_notes":
      return (Array.isArray(args.moves) ? args.moves : []).flatMap((move) => [move?.source, move?.destination]);
    default:
      return [];
  }
}

/** The `path (N bytes)` lines of a listing: one per note. */
function listedNotes(result) {
  if (result?.isError === true) return 0;
  return textOf(result).split("\n").filter((line) => /\S \(\d[\d,]* bytes\)\s*$/.test(line)).length;
}

/** Where a move puts things; nothing for a rewrite or an archive (which picks its own place). */
function destinationsOf(name, args) {
  if (name === "move_note" || name === "move_folder") return [args.destination];
  if (name === "move_notes") return args.moves.map((move) => move?.destination);
  return [];
}

/** The top-level folder a path lands in, or null for a note at the top. */
function topFolder(path) {
  const p = plain(path);
  const cut = p.indexOf("/");
  return cut <= 0 ? null : p.slice(0, cut);
}

/** What a successful change did, for the log and its undo line. */
function changesOf(name, args) {
  switch (name) {
    case "write_note":
      return [{ do: "rewrote", path: plain(args.path) }];
    case "archive_note":
      return [{ do: "archived", path: plain(args.path) }];
    case "move_note":
      return [{ do: "moved", from: plain(args.source), to: plain(args.destination) }];
    case "move_folder":
      return [{ do: "moved folder", from: plain(args.source), to: plain(args.destination) }];
    case "move_notes":
      return args.moves.map((move) => ({ do: "moved", from: plain(move.source), to: plain(move.destination) }));
    default:
      return [];
  }
}

/** Where `archive_note` put a note, from its answer, when it says. */
function archivedTo(result) {
  const match = /^archived: .+? → (\S+)$/m.exec(textOf(result));
  return match ? match[1] : null;
}

/** A batch move's own cap (`moves/limits.js`): a matched move goes in batches this size. */
const MATCH_BATCH = 100;

/**
 * How long a move by name keeps starting batches, well inside move_notes'
 * own limit (`slowMoves.js`, 60 s): past it the call answers with what moved
 * and says the rest are still there, rather than being cut off with nothing
 * said. On 2026-10-26 a real run moved 11 notes of a 480-note folder and its
 * log was the only record, so a long move now ends in words the model can act on.
 */
const MATCH_BUDGET_MS = 35_000;

/**
 * A name pattern as a whole-name test, or null for none: `*` any run, `?` one
 * character, `[0-9]` or `[!x]` one of a set, `{01,02,03}` any one of the words
 * (so a quarter is `run-log-2026-{01,02,03}-*`).
 */
export function namePattern(match) {
  const text = String(match ?? "").trim();
  if (text === "" || text.includes("/")) return null;
  const escape = (chars) => chars.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
  let body = "";
  let depth = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "*") body += ".*";
    else if (char === "?") body += ".";
    else if (char === "[") {
      const close = text.indexOf("]", at + 2);
      if (close === -1) return null;
      let set = text.slice(at + 1, close);
      const negated = set.startsWith("!") || set.startsWith("^");
      if (negated) set = set.slice(1);
      body += `[${negated ? "^" : ""}${set.replace(/[\\\]^]/g, "\\$&")}]`;
      at = close;
    } else if (char === "{") {
      depth += 1;
      body += "(?:";
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      body += ")";
    } else if (char === "," && depth > 0) body += "|";
    else body += escape(char);
  }
  if (depth !== 0) return null;
  return new RegExp(`^${body}$`, "i");
}

/** The notes directly in `folder` whose names match, each with where it lands in `into`. */
async function matchedMoves(dispatch, folder, pattern, into) {
  const listed = await dispatch("list_notes", { prefix: `${folder}/` });
  if (listed?.isError === true) return [];
  const moves = [];
  for (const line of textOf(listed).split("\n")) {
    const found = /^(.+?) \(\d[\d,]* bytes\)\s*$/.exec(line.trim());
    if (!found) continue;
    const path = plain(found[1]);
    const cut = path.lastIndexOf("/");
    const name = path.slice(cut + 1);
    if (path.slice(0, cut) !== folder || name === "about.md" || !pattern.test(name)) continue;
    moves.push({ source: path, destination: `${into}/${name}` });
  }
  return moves;
}

/** The etags a dry run's plan names, by source (`- a.md (etag X) → b.md`). */
function plannedEtags(result) {
  const etags = new Map();
  for (const found of textOf(result).matchAll(/^- (.+?) \(etag (\S+)\) → /gm)) etags.set(found[1], found[2]);
  return etags;
}

/**
 * A housekeeping run's dispatcher over the session's own `dispatch`.
 *
 * @param {(name: string, args: object) => Promise<object>} dispatch
 * @param {string[]} [runFolders] where Tex's and the website's folders are now (`protectedReason`)
 * @returns {{ callTool: (name: string, args: object) => Promise<object>, changes: object[], refusals: number }}
 */
export function housekeepingCallTool(dispatch, runFolders = [], { now = Date.now, matchBudgetMs = MATCH_BUDGET_MS } = {}) {
  // Dry runs and changes still running are the gateway's to report, never the model's to guess.
  const ledger = { changes: [], refusals: 0, dryRuns: 0, running: 0 };
  const refuse = (text) => {
    ledger.refusals += 1;
    return refused(text);
  };

  async function callTool(name, args) {
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (given.context !== undefined || given.source_context !== undefined || given.destination_context !== undefined) {
      return refuse("Housekeeping works in this workspace only.");
    }
    if (HOUSEKEEPING_READS.has(name)) return await dispatch(name, given);
    if (!HOUSEKEEPING_CHANGES.has(name)) return refuse(`Housekeeping can't use ${name}: it only moves, archives and tidies notes.`);

    if (name === "move_notes" && given.match !== undefined) return await moveMatching(given);
    const extra = Object.keys(given).filter((key) => given[key] !== undefined && !ALLOWED_ARGS[name].has(key));
    if (extra.length > 0) return refuse(`Housekeeping can't set ${extra.join(", ")}.`);
    if (mightWiden(name, given)) return refuse("Housekeeping never lets more people see something.");
    const paths = pathsOf(name, given);
    if (paths.length === 0 || paths.some((path) => typeof path !== "string" || path.trim() === "")) {
      return refuse("Name every note or folder this changes.");
    }
    if (paths.some((path) => plain(path).startsWith("@"))) return refuse("Housekeeping works in this workspace only: no path may name another.");
    for (const path of paths) {
      const why = protectedReason(path, runFolders);
      if (why) return refuse(`Housekeeping leaves ${plain(path)} alone: ${why}.`);
    }
    // A whole top-level folder (all projects, all areas) is never one tidy.
    if (name === "move_folder" && !plain(given.source).replace(/\/+$/, "").includes("/")) {
      return refuse(`Housekeeping moves what is inside ${plain(given.source)}, never the whole folder.`);
    }
    // Where things land must already be a top-level folder with notes in it.
    const landing = destinationsOf(name, given).map(topFolder);
    for (const folder of new Set(landing)) {
      if (folder === null || (!BUILT_IN_FOLDER.test(folder) && listedNotes(await dispatch("list_notes", { prefix: `${folder}/` })) === 0)) {
        return refuse(`Housekeeping files into the folders this workspace already has; ${folder ?? "the top level"} isn't one.`);
      }
    }
    const dryRun = given.dry_run === true;

    if (name === "write_note") {
      if (typeof given.content !== "string") return refuse("Write the whole note as content.");
      if (typeof given.expected_etag !== "string" || given.expected_etag === "") {
        return refuse("Housekeeping rewrites notes that exist: read the note first and pass its etag as expected_etag.");
      }
      const before = await dispatch("read_note", { path: given.path });
      if (before?.isError === true) return refuse("Housekeeping rewrites notes that exist, and that one could not be read.");
      const text = textOf(before);
      const split = text.indexOf("\n\n");
      const old = split === -1 ? "" : text.slice(split + 2);
      if (given.content.trim().length < old.trim().length * MIN_KEPT_SHARE) {
        return refuse("That would drop most of the note. Housekeeping changes front matter and merges duplicates; it never cuts a note down.");
      }
    }

    if (dryRun) ledger.dryRuns += 1;
    else ledger.running += 1;
    let result;
    try {
      result = await dispatch(name, given);
    } finally {
      if (!dryRun) ledger.running -= 1;
    }
    if (!dryRun && result?.isError !== true) {
      for (const change of changesOf(name, given)) {
        if (change.do === "archived") {
          const to = archivedTo(result);
          ledger.changes.push(to ? { ...change, from: change.path, to } : change);
        } else {
          ledger.changes.push(change);
        }
      }
    }
    return result;
  }

  /**
   * `move_notes { folder, match, into }`: every note directly in `folder`
   * whose name matches, moved into `into` keeping its name, in batches that
   * each pass `callTool` as a written-out batch would. An applied batch with
   * no versions (a workspace that is not keyed asks for them) is planned
   * first and sent again with the versions its plan names.
   */
  async function moveMatching(given) {
    const extra = Object.keys(given).filter((key) => given[key] !== undefined && !ALLOWED_ARGS.matching.has(key));
    if (extra.length > 0) return refuse(`Moving by name takes folder, match, into and dry_run, not ${extra.join(", ")}.`);
    const folder = plain(given.folder).replace(/\/+$/, "");
    // A bare name is a subfolder of `folder` (`into: "2026-03"`), unless it names a built-in top-level folder.
    const named = plain(given.into).replace(/\/+$/, "");
    const into = named === "" || named.includes("/") || BUILT_IN_FOLDER.test(named) ? named : `${folder}/${named}`;
    const pattern = namePattern(given.match);
    if (folder === "" || into === "" || pattern === null) {
      return refuse("Moving by name needs folder (where the notes are), match (a name pattern like report-2026-09-*) and into (the folder they go to).");
    }
    if (into === folder) return refuse("into must be a different folder from folder.");
    const moves = await matchedMoves(dispatch, folder, pattern, into);
    if (moves.length === 0) return refused(`No note directly in ${folder}/ has a name matching ${given.match}. Nothing moved.`);
    if (given.dry_run === true) {
      const shown = moves.slice(0, 10).map((move) => `- ${move.source}`);
      const more = moves.length > shown.length ? [`- and ${moves.length - shown.length} more`] : [];
      return { content: [{ type: "text", text: `dry run, nothing moved: ${moves.length} notes match and would go into ${into}/\n${[...shown, ...more].join("\n")}` }] };
    }
    let moved = 0;
    const began = now();
    for (let start = 0; start < moves.length; start += MATCH_BATCH) {
      if (start > 0 && now() - began > matchBudgetMs) {
        return {
          content: [{
            type: "text",
            text: `moved ${moved} of ${moves.length} notes from ${folder}/ into ${into}/ before this call's time ran out; ` +
              `the other ${moves.length - moved} are still in ${folder}/. Send the same move again to carry on.`,
          }],
        };
      }
      const batch = moves.slice(start, start + MATCH_BATCH);
      let result = await callTool("move_notes", { moves: batch });
      if (result?.isError === true && /expected_source_etag is required/.test(textOf(result))) {
        const plan = await callTool("move_notes", { moves: batch, dry_run: true });
        const etags = plannedEtags(plan);
        result = plan?.isError === true
          ? plan
          : await callTool("move_notes", { moves: batch.map((move) => ({ ...move, expected_source_etag: etags.get(move.source) })) });
      }
      if (result?.isError === true) {
        const said = textOf(result).split("\n")[0];
        return { isError: true, content: [{ type: "text", text: `moved ${moved} of ${moves.length} notes into ${into}/, then stopped: ${said}` }] };
      }
      moved += batch.length;
    }
    return { content: [{ type: "text", text: `moved ${moved} notes from ${folder}/ into ${into}/ (every note there named ${given.match}); links follow them` }] };
  }

  return {
    callTool,
    get changes() {
      return ledger.changes;
    },
    get refusals() {
      return ledger.refusals;
    },
    /** Dry runs made: each moves nothing. */
    get dryRuns() {
      return ledger.dryRuns;
    },
    /** Changes sent and not yet answered: past their limit, they may still land. */
    get running() {
      return ledger.running;
    },
  };
}

/** The tools a run is offered: the session's own definitions of the ones it may call. */
export function housekeepingTools(offered) {
  return offered
    .filter((tool) => HOUSEKEEPING_READS.has(tool.name) || HOUSEKEEPING_CHANGES.has(tool.name))
    .map((tool) => (tool.name === "move_notes" ? byName(tool) : tool));
}

/** `move_notes` as a run sees it: a batch written out, or every note in a folder whose name matches. */
function byName(tool) {
  const schema = tool.inputSchema ?? {};
  return {
    ...tool,
    description:
      `${tool.description ?? ""} Or move many notes by name: folder (where they are), match (a name pattern, * for any run of ` +
      "characters, ? one, [0-9] one of a set, {01,02,03} any one of the words, like run-log-2026-{01,02,03}-*) and into " +
      "(the folder they go to, made if it is new; a bare name like 2026-q1 is a subfolder of folder); every note directly in " +
      "folder whose name matches moves, however many. Never write a note to make a folder: moving into it makes it.",
    inputSchema: {
      ...schema,
      properties: {
        ...(schema.properties ?? {}),
        folder: { type: "string", description: "With match: the folder the notes are in." },
        match: { type: "string", description: "A name pattern: * any run of characters, ? one, [0-9] one of a set, {a,b} either word." },
        into: { type: "string", description: "With match: the folder they move into, made if new; a bare name is a subfolder of folder." },
      },
      required: [],
    },
  };
}

/** The line that puts one change back, for the log. */
export function undoLine(change) {
  switch (change.do) {
    case "moved":
    case "moved folder":
      return `move \`${change.to}\` back to \`${change.from}\``;
    case "archived":
      return change.to ? `move \`${change.to}\` back to \`${change.from}\`` : `move it out of the archive to \`${change.path}\``;
    case "rewrote":
      return `restore the earlier version from the note's history`;
    default:
      return "";
  }
}
