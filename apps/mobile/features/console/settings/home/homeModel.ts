/**
 * What the one-page settings home shows, as data: its sections, each row's
 * name, its one line and its one action (Dev2, 2026-11-12: "as sleek and
 * simple as this", approved as mockup v5).
 *
 * Pure, so a test can read the page without drawing it. `SettingsHome` draws
 * exactly this and decides nothing of its own beyond how a row looks.
 *
 * ## One action per row
 *
 * A row either does its thing in place (copy an address, pick a look, start
 * the download, sign out) or opens the page that holds the rest of it. It
 * never does both, and it never carries two buttons: the reference this was
 * drawn from earned its calm that way, and a row with a toggle *and* a
 * chevron is a row somebody has to read twice.
 *
 * ## The Tex rows come from one list
 *
 * `TEX_SETTINGS` (`packages/shared/src/texSettings.cjs`) is the list Tex reads
 * when somebody texts it a change. The rows under the Tex section's "More" are
 * drawn from it rather than written again here, so the page and the chat can
 * never name a different set of settings. The ones the app holds a page for
 * (how Tex talks, the vault, the apps Tex uses) are the page's own rows, and
 * are left out of the list below them rather than shown twice.
 *
 * ## Titles are the pages' own names
 *
 * A row opening a page is titled with that page's name ("People & sharing",
 * "Connected apps", "General"), because Tex and the help notes send people to
 * "Settings → People & sharing", and the row is where that path has to land.
 *
 * ## "More" instead of a second screen
 *
 * Every setting the app has is on this page. The ones people rarely open sit
 * folded under one "More" line at the foot of their section, which is what
 * took the page from five screens of scrolling to two (Dev2: "feels like a
 * lot of scrolling").
 */

import { TEX_SETTINGS, type TexSetting } from "@context/shared/src/texSettings.cjs";
import type { IconName } from "../../../design/components/Icon";
import { atName } from "../../format";
import { selectedContext, type ConsoleData } from "../../types";
import { settingsPreview } from "../previews";
import type { SettingsSectionKey, SettingsSectionSpec } from "../sections";

/** A lettermark tile's ground, named for the brand's swatches. */
export type TileTone = "peach" | "sage" | "butter" | "lilac" | "sky" | "tint";

/** What the row's one control does. */
export type HomeAction =
  /** Opens that section's page. */
  | { kind: "open"; key: SettingsSectionKey; label: string; danger?: boolean }
  /** Copies `text`; the button is the copy glyph. */
  | { kind: "copy"; text: string }
  /** The look picker, in place. */
  | { kind: "appearance" }
  /** The whole workspace as folders. */
  | { kind: "download" }
  | { kind: "signOut" }
  /** Changed by texting Tex; the row says so instead of offering a button. */
  | { kind: "byText" }
  /** Nothing to press: the row states a fact. */
  | { kind: "none" };

export interface HomeRow {
  id: string;
  title: string;
  /** One line under the title; `null` draws the title alone. */
  line: string | null;
  icon?: IconName;
  /** A lettermark in place of the icon, for a thing rather than a setting. */
  tile?: { letter: string; tone: TileTone; round?: boolean };
  action: HomeAction;
}

export interface HomeSection {
  id: string;
  title: string;
  lede?: string;
  /** Draws the workspace switcher in the lede. */
  switcher?: boolean;
  rows: HomeRow[];
  more?: { label: string; rows: HomeRow[] };
}

export interface HomeInputs {
  data: ConsoleData;
  /** The sections this context has, already filtered (`settingsSectionsFor`). */
  sections: readonly SettingsSectionSpec[];
  /** The Tex line for this person's phone, when one is configured. */
  texLine?: string | null;
  /** Plan and Website, which read subscriptions (`LiveRowValueSource`). */
  live?: { premium?: string | null; website?: string | null };
  canSignOut: boolean;
}

/** Rows of `TEX_SETTINGS` the page draws as rows of its own, with a page behind them. */
const TEX_KEYS_WITH_A_PAGE = new Set(["talk", "apps", "vault", "vault_delete"]);

/**
 * What each section's row says about itself when it opens a page.
 *
 * `line` is the fallback when the context has no value to state; a value from
 * `settingsPreview` wins, because "3 people" answers more than a description.
 */
const OPEN_ROWS: Record<SettingsSectionKey, { title: string; line: string; action: string; icon: IconName }> = {
  profile: { title: "Profile", line: "Name, picture, sign-in and devices", action: "Edit", icon: "person" },
  tex: { title: "How Tex talks", line: "Your own words for how Tex writes to you", action: "Edit", icon: "chat" },
  texApps: { title: "Apps Tex uses", line: "Slack, Linear and the others Tex acts in as you", action: "Manage", icon: "link" },
  messages: { title: "Messages", line: "Back up your texts from this Mac so Tex can read them", action: "Set up", icon: "phone" },
  invitations: { title: "Invitations", line: "Someone asked you to join", action: "Open", icon: "mailOpen" },
  feedback: { title: "Feedback", line: "Tell us what to fix", action: "Send", icon: "bug" },
  spelling: { title: "Writing", line: "Spell check and your dictionary", action: "Change", icon: "pencil" },
  workspace: { title: "General", line: "", action: "Change", icon: "home" },
  sharing: { title: "People & sharing", line: "Who can see what, and shared links", action: "Manage", icon: "people" },
  integrations: { title: "Connected apps", line: "What fills this workspace and who reads it", action: "Manage", icon: "grid" },
  vault: { title: "Vault", line: "Logins, keys and cards Tex can use for you", action: "Manage", icon: "key" },
  activity: { title: "Activity", line: "What changed and who changed it", action: "View", icon: "clock" },
  premium: { title: "Plan", line: "What this workspace is on", action: "Change", icon: "card" },
  storage: { title: "Storage", line: "Where your notes are kept", action: "Details", icon: "drive" },
  website: { title: "Website", line: "Publish pages from your notes", action: "Open", icon: "globe" },
  meetings: { title: "Meetings", line: "Where meeting notes go, and when to join", action: "Change", icon: "mic" },
  folders: { title: "Built-in folders", line: "Inbox, Projects, Areas, Resources, Archive", action: "Change", icon: "folder" },
  emoji: { title: "Custom emoji", line: "Emoji of your own for this workspace", action: "Manage", icon: "smile" },
  plugins: { title: "Plugins", line: "Obsidian plugins running in this workspace", action: "Manage", icon: "plugin" },
};

function openRow(key: SettingsSectionKey, data: ConsoleData, live: HomeInputs["live"]): HomeRow {
  const spec = OPEN_ROWS[key];
  const value =
    key === "premium" ? (live?.premium ?? null)
    : key === "website" ? (data.demo ? "Off" : (live?.website ?? null))
    : key === "integrations" ? integrationsLine(data)
    : key === "profile" ? null
    : settingsPreview(key, data);
  return {
    id: key,
    title: spec.title,
    line: value ?? (spec.line === "" ? null : spec.line),
    icon: spec.icon,
    action: { kind: "open", key, label: spec.action },
  };
}

/** `settingsPreview` says a bare count for this row; on a line it needs its noun. */
function integrationsLine(data: ConsoleData): string | null {
  const count = settingsPreview("integrations", data);
  if (count === null) return null;
  if (count === "None") return "No AI apps connected yet";
  return count === "1" ? "1 AI app connected" : `${count} AI apps connected`;
}

function texRegistryRow(setting: TexSetting): HomeRow {
  return {
    id: `tex-${setting.key}`,
    title: setting.label,
    line: setting.description,
    icon: "sparkle",
    action: setting.byText ? { kind: "byText" } : { kind: "none" },
  };
}

/** The Tex rows a person's own chat can change, from the one list. */
export function texListRows(): HomeRow[] {
  return TEX_SETTINGS.filter(
    (setting) => setting.where.includes("1:1") && !TEX_KEYS_WITH_A_PAGE.has(setting.key),
  ).map(texRegistryRow);
}

function moreLabel(rows: readonly HomeRow[], examples: string): string {
  return `${rows.length} more, like ${examples}`;
}

export function settingsHome({ data, sections, texLine = null, live, canSignOut }: HomeInputs): HomeSection[] {
  const has = (key: SettingsSectionKey) => sections.some((entry) => entry.key === key);
  const open = (key: SettingsSectionKey) => openRow(key, data, live);
  const pick = (keys: readonly SettingsSectionKey[]) => keys.filter(has).map(open);
  const current = selectedContext(data);
  const out: HomeSection[] = [];

  /* Text Tex: the ways in, each one copied rather than opened. */
  const ways: HomeRow[] = [];
  if (texLine !== null && texLine !== "") {
    ways.push({ id: "tex-line", title: "Tex's number", line: readableLine(texLine), icon: "chat", action: { kind: "copy", text: texLine } });
  }
  if (data.viewer.detail !== undefined && data.viewer.detail !== "") {
    ways.push({
      id: "capture-address",
      title: "Email",
      line: `${data.viewer.detail}, forward anything here`,
      icon: "mail",
      action: { kind: "copy", text: data.viewer.detail },
    });
  }
  if (ways.length > 0) out.push({ id: "reach", title: "Text Tex", rows: ways });

  /* Your account. */
  const account: HomeRow[] = [];
  if (has("profile")) {
    account.push({
      id: "profile",
      title: data.viewer.name,
      line: "Name, picture, sign-in and devices",
      tile: { letter: data.viewer.initial, tone: "peach", round: true },
      action: { kind: "open", key: "profile", label: "Edit" },
    });
  }
  account.push({ id: "appearance", title: "Appearance", line: "Light, dark, or follow your device", icon: "sun", action: { kind: "appearance" } });
  account.push(...pick(["invitations"]));
  const accountMore = pick(["spelling", "feedback"]);
  out.push({
    id: "account",
    title: "Your account",
    rows: account,
    more: accountMore.length > 0 ? { label: "Writing and feedback", rows: accountMore } : undefined,
  });

  /* Tex. */
  const texRows = pick(["tex", "vault", "texApps"]);
  for (const row of texRows) {
    if (row.id === "vault") row.tile = { letter: "V", tone: "sky" };
  }
  const texMore = [...pick(["messages"]), ...texListRows()];
  out.push({
    id: "tex",
    title: "Tex",
    lede: "Or just text Tex to change any of these.",
    rows: texRows,
    more: texMore.length > 0 ? { label: moreLabel(texMore, "check-ins and quiet hours"), rows: texMore } : undefined,
  });

  /* This workspace. */
  if (current !== null) {
    const rows = pick(["sharing", "integrations", "website"]);
    for (const row of rows) {
      if (row.id === "sharing") row.tile = { letter: "@", tone: "lilac" };
      if (row.id === "integrations") row.tile = { letter: "A", tone: "tint" };
    }
    const workspace = pick(["workspace"]).map((row) => ({
      ...row,
      line: `${atName(current.slug)}, ${current.kind === "shared" ? "shared" : "personal"}`,
    }));
    const more = [...workspace, ...pick(["storage", "meetings", "folders", "emoji", "activity", "premium", "plugins"])];
    out.push({
      id: "workspace",
      title: "Workspace",
      lede: `These apply to ${atName(current.slug)}.`,
      switcher: true,
      rows,
      more: more.length > 0 ? { label: moreLabel(more, "meetings, folders and storage"), rows: more } : undefined,
    });
  }

  /* Your data: leaving is never more than one press (non-negotiable #1). */
  const yours: HomeRow[] = [];
  if (current !== null) {
    yours.push({
      id: "download",
      title: "Download as folders",
      line: "Every note and file, with real names. Always free.",
      action: { kind: "download" },
    });
  }
  if (canSignOut) yours.push({ id: "sign-out", title: "Sign out", line: "On this device", action: { kind: "signOut" } });
  if (has("profile") && data.deleteAccount !== undefined) {
    yours.push({
      id: "delete-account",
      title: "Delete account",
      line: "Your account and personal workspace, for good",
      action: { kind: "open", key: "profile", label: "Delete", danger: true },
    });
  }
  if (yours.length > 0) out.push({ id: "data", title: "Your data", rows: yours });

  return out;
}

/** "+15555550177" as people write it; anything else as given. */
export function readableLine(line: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(line);
  return match === null ? line : `+1 (${match[1]}) ${match[2]}-${match[3]}`;
}
