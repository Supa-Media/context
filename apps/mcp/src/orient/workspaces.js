/**
 * The `## Workspaces` section of `orient`: the connected workspace first, then
 * every other one the person reaches. Each is surveyed with its own opened
 * store, its own scope and its own privacy manifest, exactly as its front
 * page always was (`frontPageOf` before this section existed) — never the
 * caller's rules.
 *
 * A workspace shows what its clearance there shows, so a private note in it is
 * never named to a caller who cannot see it.
 */

import { accessSentence } from "./access.js";
import { firstParagraphOf, readFrontPage } from "./frontPage.js";
import { surveyContext } from "./survey.js";
import { describeFolders } from "./folderAbout.js";
import { factJobs } from "../tree/facts.js";
import { ORIENT_SIBLING_INDEX_CHAR_CAP, ORIENT_SIBLING_LIMIT, renderStructure } from "./render.js";
import { hasWebsiteFolder } from "./websiteGuide.js";
import { systemFoldersSection } from "./systemFolders.js";
import { loadPrivacyState } from "../privacy/state.js";
import { within } from "../chaos/report.js";
import { servedListingStore, TREE_UNREACHABLE } from "../tree/served.js";
import { folderRole } from "../../../../packages/shared/src/folderRoles.cjs";

/**
 * How long one other workspace may hold up `orient`. The texting assistant
 * gives a whole tool call 20 s (`agent/turn.js`), and each other workspace
 * costs a control-plane round trip and bucket reads of its own; a slow one is
 * named with the way in rather than waited for.
 */
export const ORIENT_OTHER_WORKSPACE_WAIT_MS = 3000;

/**
 * Openers that open each workspace at most once for the rest of this one
 * orient call. The pinned workspace is read by the global note and may also
 * be a sibling, and each open is a control-plane round trip. The memo lives in
 * this call's frame and holds only stores opened through this call's own
 * `store` — one session, one person — so nothing outlives the request.
 */
export function openOnce(store) {
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
        ? () => once("@context-lc", () => store.openPinnedContext())
        : store.openPinnedContext,
  };
}

/**
 * One workspace's survey, with its folder descriptions. `listing` answers the
 * tree's keys, `facts` its note facts; a survey the tree cannot answer comes
 * back `loading`, which the block says rather than drawing a map of nothing.
 */
export async function surveyOf(listing, facts, scope, rules, overrides) {
  const survey = await surveyContext(listing, scope, rules, overrides);
  await describeFolders(facts, survey);
  // Which folder does each built-in job, whatever it is called now; absent where the tree cannot say.
  const jobs = await factJobs(facts);
  if (jobs !== null) survey.jobs = jobs.jobs;
  return survey;
}

/** The survey of a workspace whose file list could not be read: no map, and why. */
function unreadableSurvey() {
  return { rootNotes: [], folders: [], total: 0, recent: [], captured: [], loading: TREE_UNREACHABLE };
}

/** Whether a top-level folder is the Archive: the folder doing that job, else the one named for it. */
const archiveTest = (survey) => (name) =>
  survey.jobs?.archive ? survey.jobs.archive === name : folderRole(name) === "archive";
const folderName = (folder) => folder.prefix.replace(/\/+$/, "");
const noteCount = (count) => (count === 1 ? "1 note" : `${count} notes`);

/**
 * The lines a workspace's block says once its front page and survey are in
 * hand. A front page this caller may not see reads the same as one that does
 * not exist: no page is said of it either way.
 */
function bodyOf({ page, survey, connected = false }) {
  const lines = [];
  lines.push(survey.loading ? `Map not drawn: ${survey.loading}` : `${noteCount(survey.total)} visible to this connection.`);
  lines.push(
    page
      ? `Front page: ${page}`
      : "No front page here yet." +
          (connected ? " `index.md` is where the person's own conventions go; offer to write one." : "")
  );
  if (survey.loading) return lines.join("\n");
  lines.push("Folders:");
  const isArchive = archiveTest(survey);
  lines.push(renderStructure(survey, { exclude: isArchive }));
  const archive = survey.folders.find((folder) => isArchive(folderName(folder)));
  if (archive) {
    lines.push(`Archive: ${noteCount(archive.count)}, not listed here (fetch \`${archive.prefix}\` lists it).`);
  }
  const systemFolders = systemFoldersSection(survey);
  if (systemFolders) lines.push(systemFolders);
  if (hasWebsiteFolder(survey)) lines.push('Has a website/ folder: orient about "website" is how to build it.');
  return lines.join("\n");
}

/** The connected workspace's block: its own store, no reach to report. */
export function connectedBlock({ entry, page, survey }) {
  const head = entry
    ? `### ${entry.name} — ${accessSentence(entry)} (the one this connection opens by default)`
    : "### This workspace (the one this connection opens by default)";
  return `${head}\n${bodyOf({ page, survey, connected: true })}`;
}

/**
 * One other workspace's block, and whether its text went into the answer.
 * Never throws: a workspace that fails is named, with the reason it is thin.
 */
async function siblingOf(entry, openContext) {
  const head = `### ${entry.name} — ${accessSentence(entry)}`;
  try {
    const opened = await openContext(entry.name);
    const privacy = await loadPrivacyState(opened.store);
    if (privacy.error) {
      return { section: `${head}\nIts privacy manifest could not be read, so nothing there is readable until its owner repairs it.` };
    }
    const scope = opened.session.scope;
    const text = await readFrontPage(opened.store, scope, privacy.rules, privacy.overrides, ORIENT_SIBLING_INDEX_CHAR_CAP);
    const page = firstParagraphOf(text);
    // A tree that fails costs this workspace its map, never its front page.
    const survey = await surveyOf(servedListingStore(opened.store), opened.store, scope, privacy.rules, privacy.overrides).catch(
      () => unreadableSurvey()
    );
    return { section: `${head}\n${bodyOf({ page: page || null, survey })}` };
  } catch {
    // Named, and honest about why it is thin. Dropping the row would make
    // a workspace that exists look like one that does not.
    return { section: `${head}\nCould not be opened just now; its storage may be disconnected.` };
  }
}

/** The other workspaces' blocks, as one section. */
export async function surveyOtherContexts(store, openContext) {
  const others = (store.contexts || []).filter((entry) => !entry.current);
  if (!others.length) return { section: null };

  // Past the cap, every name is still given: a name is free, a map is not.
  const readable = typeof openContext === "function" ? others.slice(0, ORIENT_SIBLING_LIMIT) : [];
  const named = readable.length ? others.slice(readable.length) : [];

  const blocks = await Promise.all(
    readable.map(
      async (entry) =>
        (await within(siblingOf(entry, openContext), ORIENT_OTHER_WORKSPACE_WAIT_MS)) ?? {
          // `siblingOf` answers every failure itself, so null here is only ever late.
          section:
            `### ${entry.name} — ${accessSentence(entry)}\n` +
            `Map not loaded in time. Call orient with context: "${entry.name}" to see it.`,
        }
    )
  );

  const body = readable.length
    ? blocks.map(({ section }) => section).join("\n\n")
    : others.map((entry) => `- ${entry.name} — ${accessSentence(entry)}`).join("\n");
  const tail = named.length
    ? "\n\nAlso reachable, not read here: " +
      named.map((entry) => entry.name).join(", ") +
      ". Orient with one of those names to see it."
    : "";

  return { section: body + tail };
}
