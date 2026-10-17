import { useDemoConsoleData } from "../console/useDemoConsoleData";
import { SettingsOverlay } from "../console/settings/SettingsOverlay";
import type { GoogleConnection } from "../console/google/GoogleConnectionsCard";

const HOUR = 60 * 60 * 1000;
const SYNCED = { intervalMinutes: 5, everSynced: true, cursorReady: true, catchingUp: false };

/**
 * `screen=mail`: the Mail and calendar page on three accounts, one in each
 * state the card has to tell apart — a grant Google wants renewed, a mailbox
 * Google is rate-limiting while its calendar keeps up, and a healthy one —
 * with an address long enough to find out whether the row truncates it.
 */
function connections(now: number): GoogleConnection[] {
  const folders = (slug: string) => ({
    gmail: {
      backfillDays: 0,
      folders: ["inbox" as const],
      destinationFolder: `0-inbox/email/${slug}`,
      destinationPath: `0-inbox/email/${slug}/YYYY-MM-DD.md`,
      historyCursorReady: true,
      lastSyncedAt: now - 3 * 60 * 1000,
    },
    calendar: {
      destinationFolder: "0-inbox/calendar",
      destinationPath: "0-inbox/calendar/YYYY-MM-DD.md",
      syncCursorReady: true,
      lastSyncedAt: now - 5 * 60 * 1000,
    },
    chat: {
      destinationFolder: "0-inbox/google-chat",
      destinationPath: "0-inbox/google-chat/YYYY-MM-DD.md",
      cursorCount: 2,
      lastSyncedAt: now - 29 * 60 * 1000,
    },
  });
  const stale = folders("seyi-at-supa-media");
  const limited = folders("seyi-oyelowo-adebayo-at-publicworship-life");
  return [
    {
      connectionId: "stale",
      email: "seyi@supa.media",
      syncServices: { gmail: true, calendar: true, chat: true },
      syncStatus: "reconnect_required",
      lastError: "Google needs to be reconnected before this mailbox can sync.",
      sync: SYNCED,
      gmail: { ...stale.gmail, lastSyncedAt: now - 48 * HOUR },
      calendar: { ...stale.calendar, lastSyncedAt: now - 48 * HOUR },
      chat: { ...stale.chat, lastSyncedAt: now - 48 * HOUR },
    },
    {
      connectionId: "limited",
      email: "seyi.oyelowo-adebayo@publicworship.life",
      syncServices: { gmail: true, calendar: true, chat: true },
      syncStatus: "active",
      sync: SYNCED,
      gmail: {
        ...limited.gmail,
        lastSyncedAt: now - 18 * 24 * HOUR,
        lastFailure: "Google rate-limited this mailbox. The next scheduled pass will try again.",
      },
      calendar: limited.calendar,
      chat: limited.chat,
    },
    {
      connectionId: "healthy",
      email: "ministry.team@gmail.com",
      syncServices: { gmail: true, calendar: true, chat: false },
      syncStatus: "active",
      sync: SYNCED,
      ...folders("ministry-team-at-gmail-com"),
    },
  ];
}

export function MailFixture() {
  const data = useDemoConsoleData();
  return (
    <SettingsOverlay
      data={{
        ...data,
        googleConnections: connections(Date.now()),
        googleActions: { workspaceId: "demo", disconnect: async () => null },
      }}
      section="integrations"
      onSelect={() => {}}
      onDismiss={() => {}}
    />
  );
}
