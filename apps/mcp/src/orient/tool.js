/**
 * `orient` and `scope_info`: what a connection is told about the context in
 * front of it and the others it can reach.
 *
 * With no `about`, `orient` answers in six parts: what Context is, the
 * Context-wide note, the tool notice, every workspace the person reaches (the
 * connected one first), the recently touched notes, and how to work here. The
 * rest of the manual sits behind `about`: the tools, one action, access, the
 * website guide, and the health of the workspace.
 */

import { currentReach } from "./access.js";
import { describeStatusList, governingFolderOf, readStatusList } from "../tools/notes/statusList.js";
import { canSee, visibilityOf, effectiveVisibility } from "../privacy/engine.js";
import { formatCapturedLine, ORIENT_SIBLING_INDEX_CHAR_CAP, reducedRecallNotesFor, relativeAge } from "./render.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { listAllKeysWithLegacy } from "../notes/storage.js";
import { loadPrivacyState } from "../privacy/state.js";
import { normalizePath } from "../notes/paths.js";
import { PROPOSAL_PENDING_PREFIX } from "../tools/proposals.js";
import { firstParagraphOf, readFrontPage, readSaveProcedure } from "./frontPage.js";
import { GLOBAL_ORIENT_PATH, PINNED_CONTEXT_NAME, readGlobalOrientNote } from "./globalNote.js";
import { WEBSITE_GUIDE, hasWebsiteFolder } from "./websiteGuide.js";
import { scopeInfoText } from "../privacy/scopeInfo.js";
import { inV2Names } from "../tools/v2/speak.js";
import { toolNewsSection } from "../tools/news.js";
import { appOf } from "../tools/liveList.js";
import { splitReducedRecallNotes } from "../search/visible.js";
import { toolError, toolText } from "../tools/results.js";
import { chaosSection } from "../chaos/orient.js";
import { HOW_TO_WORK, inToolNames } from "./howToWork.js";
import { actionManual, actionNames, findAction, toolsManual } from "./manual.js";
import { connectedBlock, openOnce, surveyOf, surveyOtherContexts } from "./workspaces.js";
import { orientMailSection, readMailHealth } from "../agent/mailHealth.js";

export { ORIENT_OTHER_WORKSPACE_WAIT_MS, surveyOtherContexts } from "./workspaces.js";

/** The newest notes of the connected workspace `orient` names. */
const ORIENT_RECENT_SHOWN = 8;

/** What Context is, in three or four lines: the first thing every answer says. */
export const CONTEXT_INTRO =
  "# Context\n\n" +
  "Context is shared Markdown notes that people and AI agents keep together. Each workspace is one folder " +
  "tree of notes, and a person can reach several. Look before you ask: the answer is usually already written " +
  "down. Write back what you learn, so the next session does not rediscover it.";

/** The tool notice when the app's copy of the tools is current. */
export const SIX_TOOLS_LINE =
  "Six tools: orient, search, fetch, write, manage, send. orient about: \"tools\" lists every action and its arguments.";

/** The values `about` takes besides an action name. `website` is also an action name, and the guide wins. */
const ABOUT_WORDS = ["tools", "access", "website", "health"];

/** Trim, and read the legacy `tools: true` as `about: "tools"`. Null for the overview. */
function aboutOf({ about, tools } = {}) {
  if (typeof about === "string" && about.trim() !== "") return about.trim();
  return tools === true ? "tools" : null;
}

/** The connected workspace's entry in `store.contexts`, when there is one. */
const currentEntryOf = (store) => (store.contexts || []).find((entry) => entry.current) || null;

/** The connected workspace's front page, as its first paragraph. */
async function frontParagraphOf(store, scope, rules, overrides) {
  const text = await readFrontPage(store, scope, rules, overrides, ORIENT_SIBLING_INDEX_CHAR_CAP);
  return firstParagraphOf(text);
}

/** The Context-wide note section, or nothing where there is none. */
function globalSection(globalNote) {
  if (!globalNote) return null;
  return (
    `## For every workspace — from ${PINNED_CONTEXT_NAME} (\`${GLOBAL_ORIENT_PATH}\`)\n\n` +
    "Standing rules from Context.LC for every person and agent, in every workspace. " +
    "Follow them here alongside this context's own front page below.\n\n" +
    globalNote
  );
}

/** The recently touched notes of the connected workspace: five notes, then the collapsed capture lines. */
function recentSection(survey) {
  if (!survey.recent.length && !survey.captured.length) return null;
  const now = Date.now();
  const lines = [
    ...survey.recent.slice(0, ORIENT_RECENT_SHOWN).map((note) => `- ${note.key} — ${relativeAge(note.uploaded, now)}`),
    ...survey.captured.map((summary) => formatCapturedLine(summary, now)),
  ];
  return (
    "## Recently updated\n" +
    lines.join("\n") +
    "\n\nThese are where the person's attention has been. Read one before assuming you know what they are working on." +
    // Mail, meetings and saved sessions arrive on their own schedule, not the person's: one line per kind, so they cannot crowd out a note they touched.
    (survey.captured.length
      ? " Mail, meetings and saved sessions arrive automatically and are collapsed to one line per kind above; search, or fetch the folder's path ending in /, shows the individual notes."
      : "")
  );
}

/** The `about: "health"` answer: the tidiness score, and what search cannot find in full. */
async function healthAnswer(store, scope, rules, overrides) {
  const chaos = await chaosSection(store, scope, rules, overrides).catch(() => null);
  const reduced = await reducedRecallNotesFor(store, (path) => canSee(path, scope, rules, overrides));
  const parts = [chaos || "## Chaos score\n\nNo score for this workspace yet."];
  if (reduced.length) {
    // Named, then counted, as the map always did: a shed mailbox sheds by the day.
    const { shown, rest } = splitReducedRecallNotes(reduced);
    const lines = shown.map((path) => `- ${path}`);
    if (rest) lines.push(`- (+${rest} more notes in the same state)`);
    parts.push(
      "## Search coverage\n" +
        "These notes hold more messages than the search index can keep in full, so search will not find a " +
        "term that appeared only in a message it had to drop — the note itself is unaffected and fetch always " +
        "returns it whole. A search miss on one of these is not proof the content is gone:\n" +
        lines.join("\n")
    );
  }
  return parts.join("\n\n");
}

/** Every `about` answer, each for the one thing it names. */
async function aboutAnswer(store, scope, rules, overrides, about) {
  if (about === "tools") return toolText(`# Context's tools and actions\n\n${await toolsManual(store, scope)}`);
  if (about === "access") {
    const text = scopeInfoText(scope, rules, currentReach(store));
    return toolText(typeof store.offeredTools === "function" ? inV2Names(text) : text);
  }
  if (about === "website") {
    const survey = await surveyOf(store, store, scope, rules, overrides);
    const note = hasWebsiteFolder(survey)
      ? ""
      : survey.unreadable
        ? "This workspace's map cannot be read just now, so whether it has a website/ folder is not known yet. The guide to building one:\n\n"
        : "This workspace has no website/ folder yet. The guide to building one:\n\n";
    return toolText(note + WEBSITE_GUIDE);
  }
  if (about === "health") return toolText(await healthAnswer(store, scope, rules, overrides));
  const found = findAction(about, scope);
  if (found) return toolText(actionManual(found));
  return toolError(
    `orient has no "about" value "${about.length > 40 ? `${about.slice(0, 40)}…` : about}". ` +
      `Use one of: ${ABOUT_WORDS.join(", ")}, or an action name: ${actionNames(scope).join(", ")}.`
  );
}

/** The overview: what a connection needs before its first answer. */
async function overview(store, scope, rules, overrides) {
  const open = openOnce(store);
  // When the app's copy is behind, the reconnect steps: read before anything else is awaited.
  const news = toolNewsSection(store.actor?.toolsListedAt, undefined, appOf(store));
  const [survey, page, procedure, privateIndex, pendingProposals, globalNote, others, mailboxes] = await Promise.all([
    surveyOf(store, store, scope, rules, overrides),
    frontParagraphOf(store, scope, rules, overrides),
    readSaveProcedure(store, scope, rules, overrides),
    scope === "private" ? getWithLegacyFallback(store, "index-private.md") : Promise.resolve(null),
    scope === "private" ? listAllKeysWithLegacy(store, PROPOSAL_PENDING_PREFIX) : Promise.resolve([]),
    readGlobalOrientNote({
      contexts: store.contexts,
      openPinned: open.openPinned,
      here: { store, scope, rules, overrides },
    }),
    // Alongside the connected workspace's own work rather than after it: each
    // other workspace is a control-plane round trip and bucket reads of its own.
    surveyOtherContexts(store, open.openContext),
    // Their own mailboxes, said only when one needs them (`agent/mailHealth.js`); the control plane answers the owner alone.
    scope === "private" && currentEntryOf(store)?.kind !== "shared" ? readMailHealth(store) : Promise.resolve([]),
  ]);

  const parts = [CONTEXT_INTRO];
  // Staff's channel to every agent, ahead of everything the person's own workspaces say.
  const global = globalSection(globalNote);
  if (global) parts.push(global);
  // When the app's copy is behind, the reconnect steps and the manual it needs.
  // Otherwise the one line that says what the tools are and where the rest is.
  // The texting assistant is handed the older, full list every turn and has no
  // `offeredTools` (`mcp/handlers.js` sets it for MCP connections only): no
  // tool line for it, and the rules below in the names it has.
  const v2 = typeof store.offeredTools === "function";
  const say = (text) => inToolNames(text, { v2 });
  if (v2 && news) parts.push(`${news}\n\n${await toolsManual(store, scope)}`);
  else if (v2) parts.push(SIX_TOOLS_LINE);

  const current = currentEntryOf(store);
  const connected = connectedBlock({ entry: current, page, survey });
  const workspaces = [connected];
  if (others.section) workspaces.push(others.section);
  parts.push(
    "## Workspaces\n\nCalls with no `context` go to the first one. Pass `context: \"@name\"` to work in another.\n\n" +
      workspaces.join("\n\n")
  );

  if (scope === "private" && privateIndex) {
    parts.push(`## Owner's front page — index-private.md\n\n${(await privateIndex.text()).trim()}`);
  }
  const recent = recentSection(survey);
  if (recent) parts.push(recent);

  // The owner's own end-of-session procedure, before the generic rules: their words outrank ours.
  if (procedure && (procedure.text || procedure.destination)) {
    parts.push(
      say("## Before this session ends\n" +
        "This workspace has its own save procedure, written by its owner. Follow it, and use write with action " +
        "save_session to carry it out.\n" +
        (procedure.destination ? `\nSaved sessions go to \`${procedure.destination}/\`.\n` : "")) +
        (procedure.text ? `\n${procedure.text}` : "")
    );
  }
  const mail = orientMailSection(mailboxes, Date.now(), { v2 });
  if (mail) parts.push(mail);
  if (scope === "private" && pendingProposals.length) {
    parts.push(
      say(
        `## Pending note proposals\n${pendingProposals.length} waiting for you. ` +
          "Use fetch with `proposals:` to read them, and manage with action review_proposal to decide each one."
      )
    );
  }
  parts.push(say(`## How to work here\n\n${HOW_TO_WORK}`));
  return toolText(parts.join("\n\n---\n\n"));
}

/**
 * `orient`: the overview, or one part of the manual named by `about`.
 *
 * @param {object} options `about` (a string, see `aboutAnswer`), and the legacy `tools` flag
 */
export async function toolOrient(store, scope, rules, overrides, options = {}) {
  const about = aboutOf(options);
  if (about === null) return await overview(store, scope, rules, overrides);
  return await aboutAnswer(store, scope, rules, overrides, about);
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
