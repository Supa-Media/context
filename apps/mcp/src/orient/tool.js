/**
 * `orient` and `scope_info` — what a connection is told about the context in
 * front of it and the others it can reach.
 */

import { accessSentence, currentReach } from "./access.js";
import { canSee, effectiveVisibility, visibilityOf } from "../privacy/engine.js";
import {
  formatCapturedLine,
  NO_FRONT_PAGE,
  ORIENT_INDEX_CHAR_CAP,
  ORIENT_SIBLING_INDEX_CHAR_CAP,
  ORIENT_SIBLING_LIMIT,
  reducedRecallNotesFor,
  relativeAge,
  renderStructure,
} from "./render.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { listAllKeysWithLegacy } from "../notes/storage.js";
import { loadPrivacyState } from "../privacy/state.js";
import { normalizePath } from "../notes/paths.js";
import { ORIENT_OPERATING_CONTRACT } from "../mcp/instructions.js";
import { PROPOSAL_PENDING_PREFIX } from "../tools/proposals.js";
import { readFrontPage, readSaveProcedure } from "./frontPage.js";
import { scopeInfoText } from "../privacy/scopeInfo.js";
import { splitReducedRecallNotes } from "../search/visible.js";
import { surveyContext } from "./survey.js";
import { toolError, toolText } from "../tools/results.js";

async function surveyOtherContexts(store) {
  const others = (store.contexts || []).filter((entry) => !entry.current);
  if (!others.length) return null;

  const readable = typeof store.openContext === "function" ? others.slice(0, ORIENT_SIBLING_LIMIT) : [];
  // The tail names what the CAP left out, so it is empty when nothing was
  // capped. `others.slice(0)` is every sibling, and when `readable` is empty —
  // an orient already addressed into another context gets no `openContext`, by
  // the no-chaining rule — the body below is already listing all of them as
  // bullets. That printed the whole section twice, and made a list that was
  // complete read as truncated.
  const named = readable.length ? others.slice(readable.length) : [];

  const pages = await Promise.all(
    readable.map(async (entry) => {
      try {
        const opened = await store.openContext(entry.name);
        const privacy = await loadPrivacyState(opened.store);
        if (privacy.error) {
          return `### ${entry.name} — ${accessSentence(entry)}\nIts privacy manifest could not be read, so nothing there is readable until its owner repairs it.`;
        }
        const page = await readFrontPage(
          opened.store,
          opened.session.scope,
          privacy.rules,
          privacy.overrides,
          ORIENT_SIBLING_INDEX_CHAR_CAP
        );
        return (
          `### ${entry.name} — ${accessSentence(entry)}\n` +
          (page ||
            "No front page visible to you there yet. `list_notes` with " +
              `\`context: "${entry.name}"\` is the way in.`)
        );
      } catch {
        // Named, and honest about why it is thin. Dropping the row would make
        // a context that exists look like one that does not.
        return `### ${entry.name} — ${accessSentence(entry)}\nCould not be opened just now; its storage may be disconnected.`;
      }
    })
  );

  const tail = named.length
    ? "\n\nAlso reachable, not read here: " +
      named.map((entry) => entry.name).join(", ") +
      ". Orient with one of those names to see it."
    : "";

  const heading = readable.length
    ? "## Other contexts you can reach, and their front pages\n\n"
    : "## Other contexts you can reach\n\n";
  const body = readable.length
    ? pages.join("\n\n")
    : others.map((entry) => `- ${entry.name} — ${accessSentence(entry)}`).join("\n");

  return (
    heading +
    body +
    tail +
    "\n\nEvery tool here takes an optional `context` argument: pass one of these names to " +
    "read or write there instead of this one — `write_note` included, so filing a note in one " +
    "of them is one call and needs no reconnection. Orient again with that argument before " +
    "working in it: the map above, and every search and listing, is for this context only. " +
    "Each line above already says what this connection may do in that context, so take it from " +
    "there rather than assuming a reach you have not been given — or holding back one you have."
  );
}

export async function toolOrient(store, scope, rules, overrides) {
  const [frontPage, procedure, privateIndex, pendingProposals, survey, reducedRecallNotes] =
    await Promise.all([
      readFrontPage(store, scope, rules, overrides, ORIENT_INDEX_CHAR_CAP),
      readSaveProcedure(store, scope, rules, overrides),
      scope === "private" ? getWithLegacyFallback(store, "index-private.md") : Promise.resolve(null),
      scope === "private" ? listAllKeysWithLegacy(store, PROPOSAL_PENDING_PREFIX) : Promise.resolve([]),
      surveyContext(store, scope, rules, overrides),
      reducedRecallNotesFor(store, (path) => canSee(path, scope, rules, overrides)),
    ]);

  const total = `${survey.total}${survey.truncated ? "+" : ""}`;
  const parts = [
    `# Orientation\n\n${total} notes visible to this connection across ` +
      `${survey.folders.length} folders. This is the user's own context: their projects, ` +
      "decisions, people and writing. Assume the answer to a question about their work is " +
      "already in here somewhere, and look before you ask them to repeat it.",
    `## Front page — index.md\n\n${frontPage || NO_FRONT_PAGE}`,
  ];

  if (scope === "private" && privateIndex) {
    parts.push(`## Owner's front page — index-private.md\n\n${(await privateIndex.text()).trim()}`);
  }

  if (survey.recent.length || survey.captured.length) {
    const now = Date.now();
    const lines = [
      ...survey.recent.map((note) => `- ${note.key} — ${relativeAge(note.uploaded, now)}`),
      ...survey.captured.map((summary) => formatCapturedLine(summary, now)),
    ];
    parts.push(
      "## Recently updated\n" +
        lines.join("\n") +
        "\n\nThese are where the user's attention has been. Read one before assuming you " +
        "know what they are working on." +
        // Mail, meetings and saved sessions arrive on their own schedule, not
        // the user's — collapsed here to a pointer rather than individual
        // entries so they cannot crowd out a note the user actually touched.
        // list_notes or search_notes answers "what came in" in full.
        (survey.captured.length
          ? " Mail, meetings and saved sessions arrive automatically and are collapsed to one " +
            "line per kind above — list_notes or search_notes on the folder for the individual notes."
          : "") +
        // Object storage cannot be listed by modification time, so this is
        // ranked from what the bounded walk actually saw. In a context small
        // enough to walk that is everything; past the budget it is a sample,
        // and saying "recently updated" about a sample without saying so would
        // let an agent conclude a silent project is a finished one.
        (survey.truncated
          ? " This context is larger than one orientation walks, so this ranks the part " +
            "of it this call reached — not every folder is represented."
          : "")
    );
  }

  parts.push(
    `## Structure\n${renderStructure(survey)}\n\n` +
      (survey.truncated
        ? "Counts marked `+` are floors: the folder was larger than one orientation walks. "
        : "") +
      "Go deeper with list_notes on a prefix, and search_notes before concluding something " +
      "is not written down — a topic that is missing from this map is usually filed under a " +
      "name you did not guess."
  );

  if (reducedRecallNotes.length) {
    // Named, then counted — a shed mailbox sheds by the day, so this list is
    // hundreds of lines long in exactly the context that most needs the rest
    // of this page. See `RENDERED_RECALL_NOTE_LIMIT`, and the same `(+N more)`
    // idiom `renderStructure` uses for the identical reason.
    const { shown, rest } = splitReducedRecallNotes(reducedRecallNotes);
    const lines = shown.map((path) => `- ${path}`);
    if (rest) lines.push(`- (+${rest} more notes in the same state)`);
    parts.push(
      "## Search coverage\n" +
        "These notes hold more messages than the search index can keep in full, so " +
        "search_notes will not find a term that appeared only in a message it had to drop — " +
        "the note itself is unaffected and read_note always returns it whole. A search miss on " +
        "one of these is not proof the content is gone:\n" +
        lines.join("\n")
    );
  }

  const otherContexts = await surveyOtherContexts(store);
  if (otherContexts) parts.push(otherContexts);

  if (scope === "private" && pendingProposals.length) {
    parts.push(
      `## Pending note proposals\n${pendingProposals.length} waiting for you. ` +
        "Use list_proposals, read_proposal, and review_proposal to process them."
    );
  }

  // Before the contract, because it *is* the contract for this context — the
  // user's own words outrank ours, and an agent that reads the generic rule
  // first and their procedure second has them in the wrong order.
  if (procedure && (procedure.text || procedure.destination)) {
    parts.push(
      "## Before this session ends\n" +
        "This context has its own save procedure, written by its owner. Follow it, and call " +
        "`save_context` to carry it out.\n" +
        (procedure.destination ? `\nSaved sessions go to \`${procedure.destination}/\`.\n` : "") +
        (procedure.text ? `\n${procedure.text}` : "")
    );
  }

  parts.push(ORIENT_OPERATING_CONTRACT);
  parts.push(scopeInfoText(scope, rules, currentReach(store)));
  return toolText(parts.join("\n\n---\n\n"));
}

export async function toolScopeInfo(store, scope, rules, overrides, pathArg, listWorkspaces = false) {
  let text = scopeInfoText(scope, rules, currentReach(store));
  if (listWorkspaces) {
    // Data rather than prose, for a CLI choosing a workspace by name. It is the
    // same covered set `orient` already describes to this connection, so it
    // widens nothing: a read-only grant is told its own reach too.
    const workspaces = (store.contexts || []).map((entry) => ({
      slug: entry.name.slice(1),
      role: entry.role,
      kind: entry.kind,
      current: entry.current,
    }));
    text += `\n\n## Workspaces\n\n\`\`\`json\n${JSON.stringify(workspaces)}\n\`\`\``;
  }
  if (pathArg !== undefined) {
    const path = normalizePath(pathArg);
    if (!path) return toolError("invalid path");
    const folderDefault = visibilityOf(path, rules);
    if (scope === "private") {
      const exists = Boolean(await getWithLegacyFallback(store, path));
      const effective = effectiveVisibility(path, rules, overrides);
      text +=
        `\n\n## Path inspection\npath: ${path}\nfolder default: ${folderDefault}\n` +
        `effective visibility: ${effective}\nexists: ${exists ? "yes" : "no"}\n` +
        (effective !== folderDefault
          ? `source: exact ${effective} note override`
          : "source: folder default");
    } else {
      // Deliberately do not inspect the object or exact ACL here. Returning a
      // different answer for a guessed private-note path would be an oracle.
      // The folder default is echoed only when it is one of the two tiers. A
      // group rule's NAME is not this connection's to learn: names live in one
      // global namespace with usernames, so `@kola` on a folder this caller
      // cannot read would disclose that a named individual has access to it —
      // an oracle of exactly the kind the branch above refuses to be. "not
      // team" is the whole of what a team caller needs and all it gets.
      const disclosed = folderDefault === "team" ? "team" : "not team";
      text +=
        `\n\n## Destination inspection\npath: ${path}\nfolder default: ${disclosed}\n` +
        `team-writable: ${folderDefault === "team" ? "yes" : "no"}\n` +
        "Existing exact-note visibility is intentionally undisclosed.";
    }
  }
  return toolText(text);
}
