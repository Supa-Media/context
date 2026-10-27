/**
 * A link to a note, sent as a Context card rather than a bare address
 * (Sendblue App Cards: V2 lines, paid plan, one-to-one chats).
 *
 * A bare link arrives as "Click to Load Preview" (Messages holds back
 * previews of links sent through an API line), so the owner asked, on
 * 2026-10-26, for App Cards: a card with the note's name and where it lives.
 * The card is static (`interactive: false`) until the Context app's Messages
 * extension ships; the extension's bundle id names it, and the card carries
 * the note's link as its URL.
 *
 * Off unless `APP_CARDS` is "on" and both the extension's bundle id and the
 * Apple team id are set. A line that refuses a card (no V2, no plan, a group)
 * gets the plain link, so a card is never the only way to the note.
 */

/** Who the card says it is from: the extension that would open it. */
export type AppCardConfig = { extensionBundleId: string; teamId: string; appStoreId?: number };

export type AppCard = {
  appName: string;
  extensionBundleId: string;
  teamId: string;
  appStoreId?: number;
  url: string;
  interactive: false;
  fallbackText: string;
  layout: { caption: string; subcaption?: string; trailingCaption?: string; imageUrl?: string; summary: string };
};

const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;
/** `https://<host>/note/@<slug>/<path>.md`, as the gateway builds it (`apps/mcp/src/agent/noteLinks.js`), and nothing else. */
const NOTE_LINK = /^https:\/\/(?:[a-z0-9-]+\.)*context\.lc\/note\/@([^/\s]+)\/(\S+)$/;
const MAX_CAPTION = 100;

/** The card settings from the Worker's environment, or null while cards are off. */
export function appCardConfig(env: { APP_CARDS?: string; APP_CARD_EXTENSION_ID?: string; APPLE_TEAM_ID?: string; APP_STORE_ID?: string }): AppCardConfig | null {
  if (env.APP_CARDS !== "on") return null;
  const extensionBundleId = env.APP_CARD_EXTENSION_ID?.trim() ?? "";
  const teamId = env.APPLE_TEAM_ID?.trim() ?? "";
  if (!BUNDLE_ID.test(extensionBundleId) || !TEAM_ID.test(teamId)) return null;
  const store = Number(env.APP_STORE_ID);
  return { extensionBundleId, teamId, ...(Number.isInteger(store) && store > 0 ? { appStoreId: store } : {}) };
}

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** "1-projects/tex/launch-plan.md" → "Launch plan". */
function titleOf(file: string): string {
  const words = file.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, MAX_CAPTION);
}

/** A text that is nothing but a link to a note, read apart: its name, folder and workspace. */
export type NoteLink = { url: string; slug: string; folder: string; caption: string };

/** The note a text links to, or null for any other text: words, a web page, a link with anything around it. */
export function noteLinkOf(text: string): NoteLink | null {
  const match = NOTE_LINK.exec(text.trim());
  if (!match) return null;
  const slug = decoded(match[1]);
  const segments = match[2].split("/").map(decoded);
  if (slug === null || segments.some((segment) => segment === null || segment === "")) return null;
  const parts = segments as string[];
  const file = parts[parts.length - 1];
  if (!/\.md$/i.test(file)) return null;
  return { url: text.trim(), slug, folder: parts.slice(0, -1).join("/"), caption: titleOf(file) };
}

/**
 * The card for a text that is nothing but a link to a note, or null for any
 * other text: words, a web page, a link with anything around it.
 */
export function noteCard(text: string, config: AppCardConfig): AppCard | null {
  const link = noteLinkOf(text);
  if (!link) return null;
  const { url, slug, folder, caption } = link;
  return {
    appName: "Context",
    extensionBundleId: config.extensionBundleId,
    teamId: config.teamId,
    ...(config.appStoreId ? { appStoreId: config.appStoreId } : {}),
    url,
    interactive: false,
    fallbackText: url,
    layout: {
      caption,
      subcaption: (folder ? `@${slug} · ${folder}` : `@${slug}`).slice(0, MAX_CAPTION),
      trailingCaption: "Open",
      summary: `${caption}: ${url}`,
    },
  };
}
