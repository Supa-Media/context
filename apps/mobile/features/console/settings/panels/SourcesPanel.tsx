import { GoogleConnectionsCard } from "../../google/GoogleConnectionsCard";
import { IngestionCard } from "../../ingestion/IngestionCard";
/*
  The component's own path rather than the meetings barrel, deliberately: that
  barrel re-exports `useMeetingFlow`, which imports `expo-router`, and pulling
  a navigator into a settings panel makes every console test that renders it
  mock a router it has nothing to do with.
*/
import { ThisMachineCard } from "../../../meetings/components/ThisMachineCard";
import { selectedContext, type ConsoleData } from "../../types";
import { SubHead, WorkspaceRefusalCard } from "./PanelHead";

/**
 * Everything this context reads on its own: the accounts we sync, the address
 * mail is forwarded to, and this Mac.
 *
 * ## Three panels became one, and then stopped being panels
 *
 * Email, Calendar and Chats were three blocks on this page, and each drew the
 * same Google accounts again — six cards, eighteen schedule buttons and three
 * copies of Disconnect for two connected accounts. The split had an argument
 * behind it (a person asks "why isn't my mail here", not "what does my Google
 * account do") and it was answered in the wrong place: the *question* is about
 * mail, but the *thing* is an account, and an account carries all three
 * whether or not we draw it three times.
 *
 * So: one list of things that are connected. A Google account is a row. The
 * forwarding address is a row. This Mac is a row. Nothing on this page asks a
 * person to choose a folder or an interval any more — those are facts now,
 * stated once, under the list that has to be true for them.
 *
 * Both gates are unchanged and neither is re-decided here.
 * `GoogleConnectionsCard` draws Add and Disconnect only with `googleActions`,
 * and `IngestionCard` draws its sender controls only with `ingestion.save` —
 * both absent for anybody who is not this context's owner.
 */
export function SourcesPanel({ data }: { data: ConsoleData }) {
  const current = selectedContext(data);
  const personal = current?.kind === "personal";

  return (
    <>
      <SubHead title="Accounts we read">
        {personal
          ? "Mail, calendar and chats arrive on their own from the accounts below. Everything lands in your inbox folder, and every account is checked every five minutes."
          : "Nobody's mailbox, calendar or chats are connected to a shared workspace — a conversation has people in it who did not agree to a shared bucket. Notes reach it when someone moves them here."}
      </SubHead>

      {personal ? (
        <>
          <GoogleConnectionsCard
            connections={data.googleConnections}
            actions={data.googleActions}
            loading={data.loading}
          />
          {/*
            The machine this console is running on. It draws nothing in a
            browser or on a phone — correctly, there is no machine to describe
            — so on the web this list is Google and the forwarding address,
            and on a Mac it is all three.
          */}
          <ThisMachineCard focus="chats" />
        </>
      ) : (
        <WorkspaceRefusalCard title="An account belongs to a personal workspace">
          Switch to a personal workspace to connect Google or this Mac&apos;s Messages. A
          shared workspace receives a message only when somebody moves the note here.
        </WorkspaceRefusalCard>
      )}

      <SubHead title="Forwarding address">
        {personal
          ? "Forward anything here and it lands in your inbox. The address is semi-public once it is in a forwarding rule, so who may send to it is the one setting left on this page."
          : "A shared workspace has no address of its own. Only a personal workspace has one."}
      </SubHead>

      <IngestionCard state={data.ingestion} fallbackAddress={data.ingestionAddress} />
    </>
  );
}
