/**
 * What the one-page settings home shows, as data: its sections and each
 * row's name, its value and its one action (Dev2, 2026-11-13: rebuilt from the
 * reviewed prototype after "way too much jargon and slop text" and "the
 * layout is horrendous").
 *
 * Pure, so a test can read the page without drawing it. `SettingsHome` draws
 * exactly this and decides nothing of its own beyond how a row looks.
 *
 * ## A row is a name, its value and one action
 *
 * The line under a row's name is the setting's *value* ("3 people", "Free",
 * "seyi@context.lc"), never a sentence about what the setting is. A row with
 * no value to state shows its name alone. A row either does its thing in
 * place (copy, pick a look, download, sign out) or opens the page that holds
 * the rest of it, and never carries two buttons.
 *
 * ## Everything above the Workspace section follows you
 *
 * Text Tex, Account, Tex and AI apps are this person's, the same in every
 * workspace. The Workspace section is headed by its picker, and every row in
 * it belongs to the workspace picked there (Dev2, 2026-11-12: "no way to
 * switch workspaces or see how settings affect different workspaces").
 *
 * ## The Tex rows come from one list
 *
 * `TEX_SETTINGS` (`packages/shared/src/texSettings.cjs`) is the list Tex reads
 * when somebody texts it a change. Its `via: "setting"` rows are the switches
 * on "Check-ins, quiet hours and more" (`panels/TexHabits.tsx`), which write
 * the same notes a text does; a test holds the two lists equal.
 *
 * ## Titles are the pages' own names
 *
 * A row opening a page is titled with that page's name ("People & sharing",
 * "Vault", "General"), because Tex and the help notes send people to
 * "Settings → People & sharing", and the row is where that path has to land.
 */

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
  /**
   * Whom the section's settings reach: every workspace this person has, or
   * only the one picked at the top of the page (Dev2, 2026-11-12: "no way to
   * see how settings affect different workspaces"). Drawn beside the heading.
   */
  scope: "everywhere" | "workspace";
  rows: HomeRow[];
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

/**
 * What each section's row says about itself when it opens a page.
 *
 * `line` is the fallback when the context has no value to state; a value from
 * `settingsPreview` wins, because "3 people" answers more than a description.
 */
const OPEN_ROWS: Record<SettingsSectionKey, { title: string; line: string; action: string; icon: IconName }> = {
  profile: { title: "Profile", line: "", action: "Change", icon: "person" },
  tex: { title: "How Tex talks", line: "", action: "Change", icon: "chat" },
  texApps: { title: "Apps Tex uses", line: "", action: "Manage", icon: "link" },
  texHabits: { title: "Check-ins, quiet hours and more", line: "", action: "Change", icon: "sparkle" },
  messages: { title: "Messages backup", line: "", action: "Set up", icon: "phone" },
  invitations: { title: "Invitations", line: "", action: "Open", icon: "mailOpen" },
  feedback: { title: "Crash and usage reports", line: "", action: "Change", icon: "bug" },
  spelling: { title: "Writing", line: "", action: "Change", icon: "pencil" },
  workspace: { title: "General", line: "", action: "Change", icon: "home" },
  sharing: { title: "People & sharing", line: "", action: "Manage", icon: "people" },
  integrations: { title: "Connected apps", line: "", action: "Manage", icon: "grid" },
  vault: { title: "Vault", line: "", action: "Manage", icon: "key" },
  activity: { title: "Activity", line: "", action: "View", icon: "clock" },
  premium: { title: "Plan", line: "", action: "Change", icon: "card" },
  storage: { title: "Storage", line: "", action: "View", icon: "drive" },
  website: { title: "Website", line: "", action: "Change", icon: "globe" },
  meetings: { title: "Meetings", line: "", action: "Change", icon: "mic" },
  folders: { title: "Built-in folders", line: "", action: "Change", icon: "folder" },
  emoji: { title: "Custom emoji", line: "", action: "Manage", icon: "smile" },
  plugins: { title: "Plugins", line: "", action: "Manage", icon: "plugin" },
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
  if (count === "None") return "None yet";
  return count === "1" ? "1 app" : `${count} apps`;
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
    ways.push({ id: "tex-line", title: "Messages", line: readableLine(texLine), icon: "chat", action: { kind: "copy", text: texLine } });
  }
  if (data.viewer.detail !== undefined && data.viewer.detail !== "") {
    ways.push({ id: "capture-address", title: "Email", line: data.viewer.detail, icon: "mail", action: { kind: "copy", text: data.viewer.detail } });
  }
  if (ways.length > 0) out.push({ id: "reach", title: "Text Tex", scope: "everywhere", rows: ways });

  /* Account: you, everywhere. */
  const account: HomeRow[] = [];
  if (has("profile")) {
    account.push({ id: "profile", title: "Name", line: data.viewer.name, icon: "person", action: { kind: "open", key: "profile", label: "Change" } });
  }
  account.push({ id: "appearance", title: "Appearance", line: null, icon: "sun", action: { kind: "appearance" } });
  account.push(...pick(["invitations", "spelling"]));
  out.push({ id: "account", title: "Account", scope: "everywhere", rows: account });

  /* Tex: what it does for you, everywhere. Check-ins, quiet hours and the rest of what Tex changes by text have switches too. */
  const tex = pick(["tex", "texHabits", "texApps", "messages"]);
  out.push({ id: "tex", title: "Tex", scope: "everywhere", rows: tex });

  /* AI apps: one connection reaches every workspace this person is in. */
  if (has("integrations")) out.push({ id: "ai", title: "AI apps", scope: "everywhere", rows: pick(["integrations"]) });

  /* The workspace picked at the head of this section; everything in it is that workspace's own. */
  if (current !== null) {
    const general = pick(["workspace"]).map((row) => ({ ...row, line: current.displayName || atName(current.slug) }));
    const rows = [
      ...general,
      ...pick(["sharing", "vault", "website", "premium", "storage", "meetings", "folders", "emoji", "plugins", "activity"]),
    ];
    /* Leaving is never more than one press (non-negotiable #1), and it is this workspace's. */
    rows.push({
      id: "download",
      title: "Download a copy",
      line: current.role === "owner" ? "All notes, as folders" : "Notes you can see, as folders",
      icon: "archive",
      action: { kind: "download" },
    });
    out.push({ id: "workspace", title: "Workspace", scope: "workspace", rows });
  }

  /* Data controls. */
  if (has("feedback")) out.push({ id: "privacy", title: "Data controls", scope: "everywhere", rows: pick(["feedback"]) });

  /* Account management: signing out and leaving for good. */
  const yours: HomeRow[] = [];
  if (canSignOut) yours.push({ id: "sign-out", title: "Sign out", line: "This device", action: { kind: "signOut" } });
  if (has("profile") && data.deleteAccount !== undefined) {
    yours.push({
      id: "delete-account",
      title: "Delete account",
      line: "Deletes your account and personal workspace",
      action: { kind: "open", key: "profile", label: "Delete", danger: true },
    });
  }
  if (yours.length > 0) out.push({ id: "data", title: "Account management", scope: "everywhere", rows: yours });

  return out;
}

/** "+15555550177" as people write it; anything else as given. */
export function readableLine(line: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(line);
  return match === null ? line : `+1 (${match[1]}) ${match[2]}-${match[3]}`;
}
