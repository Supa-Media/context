import { GoogleConnectionsCard } from "../../google/GoogleConnectionsCard";
import { selectedContext, type ConsoleData } from "../../types";
/*
  The component's own path rather than the meetings barrel, deliberately: that
  barrel re-exports `useMeetingFlow`, which imports `expo-router`, and pulling a
  navigator into a settings panel makes every console test that renders it mock
  a router it has nothing to do with. This card needs React and a bridge and
  nothing else.
*/
import { ThisMachineCard } from "../../../meetings/components/ThisMachineCard";
import { PanelHead, WorkspaceRefusalCard } from "./PanelHead";

/**
 * Chats: Google Chat, and this Mac's iMessages.
 *
 * Two mechanisms with nothing in common — one is an OAuth scope on a Google
 * account, the other is a SQLite database on a laptop reached through the
 * desktop shell — under the one word a person recognises. That is the whole
 * argument for this panel: somebody wondering where their messages are does
 * not know which of our two systems is responsible, and should not have to
 * guess which heading to open.
 *
 * The Mac half draws only inside the desktop shell, and the check for that is
 * the component's own: in a browser `ThisMachineCard` returns `null` and costs
 * a render. So this panel is the Google card alone on the web, both on a Mac,
 * and neither on a workspace — never a heading over an empty card.
 */
export function ChatsPanel({
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
      <PanelHead section="chats" sectioned={sectioned}>
        {personal
          ? "Google Chat spaces, and the Messages on this Mac. Two different mechanisms, one place to look."
          : "Chats are read into a brain, not into a workspace. A conversation has people in it who did not agree to a shared bucket."}
      </PanelHead>

      {personal ? (
        <>
          <GoogleConnectionsCard
            service="chat"
            connections={data.googleConnections}
            actions={data.googleActions}
            loading={data.loading}
          />
          {/*
            The machine this console is running on, narrowed to the half that
            is about messages. Its connection state is here rather than only
            under Meetings because iMessage import spends the same grant: an
            unconnected machine is precisely why somebody's texts are not
            arriving, and that has to be readable from the panel they opened.
          */}
          <ThisMachineCard focus="chats" />
        </>
      ) : (
        <WorkspaceRefusalCard title="Chats belong to a brain">
          Switch to a personal brain to connect Google Chat or this Mac&apos;s Messages.
          A workspace receives a chat only when somebody moves the note here.
        </WorkspaceRefusalCard>
      )}
    </>
  );
}
