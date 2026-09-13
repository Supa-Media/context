import { loadedFolders } from "../../files/browser";
import { GoogleConnectionsCard } from "../../google/GoogleConnectionsCard";
import { selectedContext, type ConsoleData } from "../../types";
import { PanelHead, WorkspaceRefusalCard } from "./PanelHead";

/**
 * Calendar: which calendars we read, and where each day's events are filed.
 *
 * The whole panel is one narrowed `GoogleConnectionsCard`, and that is the
 * point rather than an admission. Calendars reach a context through exactly
 * one mechanism today — a Google account's calendar scope — so the honest
 * answer to "which calendars do you read" is that card and nothing else. When
 * a second mechanism arrives (an .ics subscription, say) it belongs on this
 * page beside the first, the way a forwarded mailbox sits beside a Google one
 * in `EmailPanel`, rather than under a heading of its own.
 *
 * The owner gate is the card's, unchanged: `googleActions` is absent for
 * anybody who is not the owner of this context, and the card then offers
 * neither Connect nor Disconnect nor Save pattern.
 */
export function CalendarPanel({
  data,
  sectioned,
}: {
  data: ConsoleData;
  sectioned: boolean;
}) {
  const current = selectedContext(data);
  const personal = current?.kind === "personal";

  return (
    <>
      <PanelHead section="calendar" sectioned={sectioned}>
        {personal
          ? "Which calendars this workspace reads, and the daily note each day's events are written into."
          : "Calendars are read into a personal workspace, not into a shared one — a meeting invitation names the people in it, and a shared bucket is a different audience."}
      </PanelHead>

      {personal ? (
        <GoogleConnectionsCard
          service="calendar"
          connections={data.googleConnections}
          actions={data.googleActions}
          loading={data.loading}
          folders={loadedFolders(data.files.listings)}
        />
      ) : (
        <WorkspaceRefusalCard title="A calendar belongs to a personal workspace">
          Switch to a personal workspace to connect a Google Calendar. What lands here
          instead is whatever somebody chooses to move.
        </WorkspaceRefusalCard>
      )}
    </>
  );
}
