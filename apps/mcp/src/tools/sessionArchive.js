/** Where `save_context` files a conversation and how it renders one, and the archive-folder test. Moved verbatim out of `src/index.js`. */

import { getWithLegacyFallback } from "../storageLayout.js";
import { timestampSlug } from "../notes/paths.js";
import { yamlString } from "../notes/format.js";

export const CHAT_HISTORY_CONTENT_BYTE_CAP = 2_000_000;

/** Whether a path is inside one of this context's archives. */
export function insideArchive(path, roots) {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export async function uniqueSessionPath(store, platform, at, folder) {
  const prefix = `${folder.replace(/\/+$/, "")}/${platform}/`;
  const timestamp = timestampSlug(new Date(at));
  const first = `${prefix}${timestamp}.md`;
  if (!(await getWithLegacyFallback(store, first))) return first;
  return `${prefix}${timestamp}-${crypto.randomUUID().slice(0, 8)}.md`;
}

export function formatChatArchive({ platform, history, completeness, visibility, title, sessionId, at }) {
  const heading = title?.trim() || `${platform} conversation — ${at}`;
  const frontmatter = [
    "---",
    `archived-at: ${yamlString(at)}`,
    `platform: ${yamlString(platform)}`,
    `visibility: ${yamlString(visibility)}`,
    `completeness: ${yamlString(completeness)}`,
    "capture-boundary: user-visible messages only",
  ];
  if (title?.trim()) frontmatter.push(`title: ${yamlString(title.trim().slice(0, 300))}`);
  if (sessionId?.trim()) {
    frontmatter.push(`source-session-id: ${yamlString(sessionId.trim().slice(0, 500))}`);
  }
  frontmatter.push("---");
  return (
    `${frontmatter.join("\n")}\n\n# ${heading.replace(/[\r\n]+/g, " ").slice(0, 300)}\n\n` +
    "> Capture boundary: user-visible conversation supplied by the connected client. " +
    "Hidden prompts, internal reasoning, credentials, and raw tool logs are excluded.\n\n" +
    history.trim() +
    "\n"
  );
}

/**
 * A client slug that is about to become a path segment.
 *
 * The enum used to be four names, which was already wrong the day Cursor and
 * VS Code appeared on the connect screen and is more wrong once a session can
 * be posted by a hook from anything. So it is a shape rather than a list — and
 * a strict one, because this value is interpolated into a bucket key.
 */
export const PLATFORM_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
