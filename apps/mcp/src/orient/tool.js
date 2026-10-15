/**
 * `orient` and `scope_info` — what a connection is told about the context in
 * front of it and the others it can reach.
 */

import { describeStatusList, governingFolderOf, readStatusList } from "../tools/notes/statusList.js";
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
  FOLDER_ABOUT_GUIDANCE,
  renderBuiltInFolders,
  renderStructure,
} from "./render.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { listAllKeysWithLegacy } from "../notes/storage.js";
import { loadPrivacyState } from "../privacy/state.js";
import { normalizePath } from "../notes/paths.js";
import { ORIENT_OPERATING_CONTRACT } from "../mcp/instructions.js";
import { PROPOSAL_PENDING_PREFIX } from "../tools/proposals.js";
import { readFrontPage, readSaveProcedure } from "./frontPage.js";
import { GLOBAL_ORIENT_PATH, PINNED_CONTEXT_NAME, readGlobalOrientNote } from "./globalNote.js";
import { websiteGuideFor } from "./websiteGuide.js";
import { scopeInfoText } from "../privacy/scopeInfo.js";
import { toolNewsSection } from "../tools/news.js";
import { liveToolsSection } from "../tools/liveList.js";
import { splitReducedRecallNotes } from "../search/visible.js";
import { surveyContext } from "./survey.js";
import { describeFolders } from "./folderAbout.js";
import { toolError, toolText } from "../tools/results.js";
import { chaosSection } from "../chaos/orient.js";
import { within } from "../chaos/report.js";
import { withReadReach } from "../privacy/egress.js";

/**
 * How long one other workspace's front page may hold up `orient`. The
 * texting assistant gives a whole tool call 20 s (`agent/turn.js`), and each
 * other workspace costs a control-plane round trip and bucket reads of its
 * own; a slow one is named with the way in rather than waited for.
 */
export const ORIENT_OTHER_WORKSPACE_WAIT_MS = 3000;

/**
 * Openers that open each workspace at most once for the rest of this one
 * orient call. The global note and the other-workspaces section both read
 * `@context-lc`, and each open is a control-plane round trip. The memo lives
 * in this call's frame and holds only stores opened through this call's own
 * `store` — one session, one person — so nothing outlives the request or
 * reaches anybody else.
 */
function openOnce(store) {
  const opened = new Map();
  const once = (name, open) => {
    if (!opened.has(name)) opened.set(name, open());
    return opened.get(name);
  };
  return {
    openContext:
      typeof store.openContext === "function" ? (name) => once(name, () => store.openContext(name)) : null,
    openPinned:
      typeof store.openPinnedContext === "function"
        ? () => once(PINNED_CONTEXT_NAME, () => store.openPinnedContext())
        : store.openPinnedContext,
  };
}

/**
 * One other workspace's section of orient. Never throws.
 *
 * Answers `reached` as well as the section: the workspace and the tier this
 * call read its front page at, for the egress ledger, and `null` when it
 * handed the model no note text — a workspace that could not be opened, whose
 * manifest is torn, or that shows this caller no front page was not read, and
 * recording it would make the gate ask about a read that never happened
 * (`tools/search.js`'s `reachOf`, for the same fan-out one tool call wide).
 */
async function frontPageOf(entry, openContext) {
  const head = `### ${entry.name} — ${accessSentence(entry)}\n`;
  try {
    const opened = await openContext(entry.name);
    const privacy = await loadPrivacyState(opened.store);
    if (privacy.error) {
      return { section: `${head}Its privacy manifest could not be read, so nothing there is readable until its owner repairs it.`, reached: null };
    }
    const page = await readFrontPage(
      opened.store,
      opened.session.scope,
      privacy.rules,
      privacy.overrides,
      ORIENT_SIBLING_INDEX_CHAR_CAP
    );
    return {
      section:
        head +
        (page ||
          "No front page visible to you there yet. `list_notes` with " +
            `\`context: "${entry.name}"\` is the way in.`),
      reached: page ? { workspaceId: opened.session?.workspaceId, scope: opened.session?.scope } : null,
    };
  } catch {
    // Named, and honest about why it is thin. Dropping the row would make
    // a context that exists look like one that does not.
    return { section: `${head}Could not be opened just now; its storage may be disconnected.`, reached: null };
  }
}

/**
 * The "other contexts" section, and `reached`: every workspace whose front
 * page this one call put in front of the model, for the egress ledger.
 * Exported for the test that holds that reporting in place.
 */
export async function surveyOtherContexts(store, openContext) {
  const others = (store.contexts || []).filter((entry) => !entry.current);
  if (!others.length) return { section: null, reached: [] };

  const readable = typeof openContext === "function" ? others.slice(0, ORIENT_SIBLING_LIMIT) : [];
  // The tail names what the CAP left out, so it is empty when nothing was
  // capped. `others.slice(0)` is every sibling, and when `readable` is empty —
  // an orient already addressed into another context gets no `openContext`, by
  // the no-chaining rule — the body below is already listing all of them as
  // bullets. That printed the whole section twice, and made a list that was
  // complete read as truncated.
  const named = readable.length ? others.slice(readable.length) : [];

  const pages = await Promise.all(
    readable.map(async (entry) => {
      const page = await within(frontPageOf(entry, openContext), ORIENT_OTHER_WORKSPACE_WAIT_MS);
      // `frontPageOf` answers every failure itself, so null here is only ever
      // late. Named with the call that finishes the job, never dropped: a
      // workspace that exists must not read as one that does not. Late is also
      // nothing read, so it reports no reach.
      return (
        page ?? {
          section:
            `### ${entry.name} — ${accessSentence(entry)}\n` +
            `Map not loaded in time. Call orient with context: "${entry.name}" to see it.`,
          reached: null,
        }
      );
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
    ? pages.map(({ section }) => section).join("\n\n")
    : others.map((entry) => `- ${entry.name} — ${accessSentence(entry)}`).join("\n");

  const section =
    heading +
    body +
    tail +
    "\n\nEvery tool here takes an optional `context` argument: pass one of these names to " +
    "read or write there instead of this one — `write_note` included, so filing a note in one " +
    "of them is one call and needs no reconnection. Orient again with that argument before " +
    "working in it: the map above, and every search and listing, is for this context only. " +
    "Each line above already says what this connection may do in that context, so take it from " +
    "there rather than assuming a reach you have not been given — or holding back one you have.";

  return {
    section,
    reached: pages
      .map(({ reached }) => reached)
      .filter((reached) => typeof reached?.workspaceId === "string" && reached.workspaceId !== ""),
  };
}

export async function toolOrient(store, scope, rules, overrides, { tools = false } = {}) {
  const open = openOnce(store);
  const [frontPage, procedure, privateIndex, pendingProposals, survey, reducedRecallNotes, globalNote, chaos, otherContexts] =
    await Promise.all([
      readFrontPage(store, scope, rules, overrides, ORIENT_INDEX_CHAR_CAP),
      readSaveProcedure(store, scope, rules, overrides),
      scope === "private" ? getWithLegacyFallback(store, "index-private.md") : Promise.resolve(null),
      scope === "private" ? listAllKeysWithLegacy(store, PROPOSAL_PENDING_PREFIX) : Promise.resolve([]),
      // Described after the survey, because the descriptions are read only for
      // the folders the survey is about to draw, and it names their front notes.
      surveyContext(store, scope, rules, overrides).then(async (survey) => {
        await describeFolders(store, survey);
        return survey;
      }),
      reducedRecallNotesFor(store, (path) => canSee(path, scope, rules, overrides)),
      readGlobalOrientNote({
        contexts: store.contexts,
        openPinned: open.openPinned,
        here: { store, scope, rules, overrides },
      }),
      chaosSection(store, scope, rules, overrides).catch(() => null),
      // Alongside the walk above rather than after it: each other workspace is
      // a control-plane round trip and bucket reads of its own, and waiting
      // for this workspace's survey first is what timed the call out.
      surveyOtherContexts(store, open.openContext),
    ]);

  const parts = [
    survey.loading
      ? "# Orientation\n\nThis is the user's own context: their projects, decisions, people and writing. " +
        `Its map is not drawn below because ${survey.loading}`
      : `# Orientation\n\n${survey.total} notes visible to this connection across ` +
        `${survey.folders.length} folders. This is the user's own context: their projects, ` +
        "decisions, people and writing. Assume the answer to a question about their work is " +
        "already in here somewhere, and look before you ask them to repeat it.",
  ];
  // First, ahead of the person's own front page: it is short by construction
  // and it is the one thing Context.LC's staff can say to every agent at once.
  if (globalNote) {
    parts.push(
      `## For every workspace — from ${PINNED_CONTEXT_NAME} (\`${GLOBAL_ORIENT_PATH}\`)\n\n` +
        "Standing rules from Context.LC for every person and agent, in every workspace. " +
        "Follow them here alongside this context's own front page below.\n\n" +
        globalNote
    );
  }
  // Then what changed in our tools since this client last loaded them: the
  // one way to reach a client that never refreshes its copy (`tools/news.js`).
  const toolNews = toolNewsSection(store.actor?.toolsListedAt);
  if (toolNews) parts.push(toolNews);
  // And what they are today: in full when the copy is behind or the agent
  // asked, one line otherwise.
  const liveTools = await liveToolsSection(store, { full: tools || toolNews !== null });
  if (liveTools) parts.push(liveTools);
  parts.push(
    `## Front page — index.md\n\n${frontPage || NO_FRONT_PAGE}`
  );

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
          : "")
    );
  }

  parts.push(
    survey.loading
      ? `## Structure\n\nNot drawn: ${survey.loading}`
      : `## Structure\n${renderStructure(survey)}\n\n` +
        (renderBuiltInFolders(survey) ? `${renderBuiltInFolders(survey)}\n\n` : "") +
        `${FOLDER_ABOUT_GUIDANCE}\n\n` +
        "Go deeper with list_notes on a prefix, and search_notes before concluding something " +
        "is not written down — a topic that is missing from this map is usually filed under a " +
        "name you did not guess."
  );

  if (chaos) parts.push(chaos);

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

  const websiteGuide = websiteGuideFor(survey);
  if (websiteGuide) parts.push(websiteGuide);

  if (otherContexts.section) parts.push(otherContexts.section);

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
  // The ledger has to hear every workspace this one call read from, the way
  // `search_notes` reports its own fan-out: it is what `approvalRequired`
  // weighs before letting this turn widen anything (`privacy/egress.js`).
  return withReadReach(toolText(parts.join("\n\n---\n\n")), otherContexts.reached);
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
    // The statuses a note here may carry, in their groups: read through this connection's own clearance.
    const folder = path.endsWith(".md") ? governingFolderOf(path) : path.replace(/\/+$/, "");
    const { list, from } = await readStatusList(store, scope, rules, overrides, folder);
    text +=
      `\n\n## Statuses here\n${describeStatusList(list)}\n` +
      (from === null ? "source: the defaults (no folder above declares a list)" : `source: ${from}/ front note`) +
      "\nA note's `status:` should be one of these words; `where: status is done` in a list matches the whole Done group.";
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
