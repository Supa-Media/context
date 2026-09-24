/** `save_context` — an agent session archived where the front page says. */

import {
  CHAT_HISTORY_CONTENT_BYTE_CAP,
  formatChatArchive,
  PLATFORM_SLUG,
  uniqueSessionPath,
} from "./sessionArchive.js";
import { clearExactVisibilityIfAbsent } from "../moves/objects.js";
import { defaultSessionFolder, visibilityOf } from "../privacy/engine.js";
import { normalizeVisibility } from "../notes/format.js";
import { persistExactVisibility } from "../privacy/state.js";
import { readSaveProcedure } from "../orient/frontPage.js";
import { recordChange } from "../activity/record.js";
import { toolError, toolText, writePermissionError } from "./results.js";
import { toolProposeNote } from "./proposalActions.js";

export async function toolSaveContext(store, scope, rules, overrides, args) {
  const platform = typeof args.platform === "string" ? args.platform.trim().toLowerCase() : "";
  if (!PLATFORM_SLUG.test(platform)) {
    return toolError(
      "platform must be a short lower-case name for the client, e.g. chatgpt, claude, codex, cursor"
    );
  }
  // `history` is what the tool was called when it only took transcripts;
  // `content` is what it takes now, which is whatever mattered. Both are
  // accepted, because a client holding a cached tool list is still sending the
  // old name and losing somebody's session over a rename would be indefensible.
  const body = typeof args.content === "string" ? args.content : args.history;
  args = { ...args, history: body };
  if (typeof body !== "string" || !body.trim()) {
    return toolError("content must be a non-empty string");
  }
  const byteLength = new TextEncoder().encode(body).byteLength;
  if (byteLength > CHAT_HISTORY_CONTENT_BYTE_CAP) {
    return toolError(`content exceeds ${CHAT_HISTORY_CONTENT_BYTE_CAP} bytes`);
  }
  const completeness = args.completeness || "available-context";
  if (!["full-visible-transcript", "available-context", "summary"].includes(completeness)) {
    return toolError("completeness must be full-visible-transcript, available-context, or summary");
  }
  // Archive-only compatibility for clients that cached the former enum.
  const visibility = args.visibility === "public" ? "team" : normalizeVisibility(args.visibility || scope);
  if (!["private", "team"].includes(visibility)) {
    return toolError("visibility must be private or team");
  }
  if (scope === "private" && visibility === "team" && args.confirm_team_publish !== true) {
    return toolError(
      "confirmation required: archiving this conversation at team visibility makes it readable by every team-access connection. Retry with confirm_team_publish=true only after explicit user approval."
    );
  }

  const at = new Date().toISOString();
  // The user's own procedure decides where this lands. Read per call rather
  // than cached: they may have edited `index.md` in Obsidian a minute ago, and
  // a stale destination writes somewhere they have stopped using.
  const procedure = await readSaveProcedure(store, scope, rules, overrides);
  const folder = procedure?.destination || defaultSessionFolder(rules);
  const path = await uniqueSessionPath(store, platform, at, folder);
  const content = formatChatArchive({
    platform,
    history: args.history,
    completeness,
    visibility,
    title: typeof args.title === "string" ? args.title : "",
    sessionId: typeof args.session_id === "string" ? args.session_id : "",
    at,
  });

  if (scope === "team" && visibility === "private") {
    const proposal = await toolProposeNote(
      store,
      scope,
      path,
      content,
      `User explicitly requested private storage for this ${platform} conversation archive`,
      platform
    );
    if (proposal.isError) return proposal;
    return toolText(
      `private chat archive queued for approval\n${proposal.content[0].text}\n` +
        "The transcript is hidden from team note listings, but is not filed at its final private path until a personal connection approves it."
    );
  }

  // A team connection may not archive into a private-default subtree.
  //
  // `write_note` refuses exactly this (`scope === "team" && !existing &&
  // inheritedVisibility !== "team"`), and the two tools were disagreeing about
  // the same write surface: `archive_chat` never consulted the folder default,
  // so a team connection could create notes under a `4-archive/chat-history/`
  // tree the owner had deliberately made private, and stamp a team override
  // onto them. It discloses nothing — the content is the caller's own — but it
  // silently overrides an owner's folder rule and contradicts what `scope_info`
  // advertises as the write surface.
  //
  // Deliberately below the proposal branch above: a team caller who *asks* for
  // a private archive still gets to queue one for owner review. That is the
  // sanctioned way into a private destination, and it ends in a human deciding.
  if (scope === "team" && visibilityOf(path, rules) !== "team") {
    return writePermissionError("archive destination");
  }

  // Private is a narrowing and must be present before the bytes. Team is a
  // widening relative to an inherited private folder, so publish it only
  // after this request has atomically created the note.
  if (visibility !== "team") {
    await persistExactVisibility(store, path, visibility, rules);
  }
  let put;
  try {
    put = await store.put(path, content, { onlyIf: { absent: true } });
  } catch (error) {
    await clearExactVisibilityIfAbsent(store, path).catch(() => {});
    throw error;
  }
  if (!put) {
    await clearExactVisibilityIfAbsent(store, path).catch(() => {});
    return toolError("conflict: archive path was created concurrently; retry");
  }
  if (visibility === "team") {
    try {
      await persistExactVisibility(store, path, "team", rules);
    } catch {
      return toolError(
        "archive was saved, but its team visibility could not be recorded; ask the owner to repair the destination rule",
      );
    }
  }
  await recordChange(store, "save_context", scope, [path], {
    platform,
    visibility,
    completeness,
    content_bytes: byteLength,
    etag: put.etag,
    team_visible: visibility === "team",
  });
  return toolText(
    `saved: ${path}\nvisibility: ${visibility}\ncompleteness: ${completeness}\netag: ${put.etag}` +
      // Say which of the two happened. A tool that silently guesses a folder
      // and a tool that followed an instruction look identical in their output,
      // and only one of them is something the user might want to correct.
      (procedure?.destination
        ? `\ndestination: from this context's own save procedure in index.md`
        : `\ndestination: assumed — set one by adding a "## Save context" section to index.md ` +
          `with a line reading "destination: <folder>"`) +
      (procedure?.text ? `\n\nTheir procedure also says:\n${procedure.text}` : "")
  );
}
