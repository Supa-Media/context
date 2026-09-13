import { StyleSheet } from "react-native";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import { loadedFolders } from "../../files/browser";
import { GoogleConnectionsCard } from "../../google/GoogleConnectionsCard";
import { IngestionCard } from "../../ingestion/IngestionCard";
import { selectedContext, type ConsoleData } from "../../types";
import { PanelHead, WorkspaceRefusalCard } from "./PanelHead";

/**
 * Email: the mailboxes we read, and the address mail is forwarded to.
 *
 * **This is the panel the split was for.** One question — "how does mail get
 * into my workspace" — used to be answered in two places, because there are two
 * mechanisms: a Google account syncs its own mailbox, and anything else is
 * forwarded to a capture address. Those live in different systems, gate on
 * different things and fail in different ways, and none of that is the
 * reader's problem. They are on one page now, in the order somebody arrives
 * at them: the mailbox they already have, then the address for everything
 * that is not a Google account.
 *
 * Two owner gates, both older than this panel and neither of them re-stated
 * here. `GoogleConnectionsCard` draws its connect and disconnect controls only
 * with `googleActions`, and `IngestionCard` draws its folder, sender and
 * attachment controls only with `ingestion.save` — both absent for anybody who
 * is not this context's owner. A component that re-decided either would be a
 * second copy of a rule, which `features/console/capabilities.ts` records as
 * the way this app has previously lost one.
 */
export function EmailPanel({
  data,
  sectioned,
}: {
  data: ConsoleData;
  sectioned: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const current = selectedContext(data);
  const personal = current?.kind === "personal";
  const hasIngestion = data.ingestion.availability === "available";

  return (
    <>
      <PanelHead section="email" sectioned={sectioned}>
        {personal
          ? "Mail arrives two ways: a Google account whose mailbox we read, or anything forwarded to this workspace's own address. Both are here."
          : "A workspace has no address of its own, and nobody's mailbox is connected to one. Notes reach it when someone moves them here."}
      </PanelHead>

      {personal ? (
        <GoogleConnectionsCard
          service="gmail"
          connections={data.googleConnections}
          actions={data.googleActions}
          loading={data.loading}
          folders={loadedFolders(data.files.listings)}
        />
      ) : (
        <WorkspaceRefusalCard title="A mailbox belongs to a personal workspace">
          Switch to a personal workspace to connect a Google account. This one is
          shared, and somebody&apos;s mailbox is not.
        </WorkspaceRefusalCard>
      )}

      {/*
        The blurb describes a setting, so it is shown only where there is one.
        A shared context has no capture address at all, and telling a team to
        forward mail into this context — above a card explaining that they
        cannot — would be the same lie one line higher up. The heading then
        carries the sub's bottom margin, so the card does not ride up against
        it.
      */}
      <Text
        variant="eyebrow"
        style={[styles.headLater, hasIngestion ? null : styles.headAlone]}
      >
        Forwarded mail
      </Text>
      {hasIngestion ? (
        <Text variant="paneSub" style={styles.sub}>
          Forward mail into this context. The address is semi-public once it is in a
          forwarding rule, so who may send to it is the setting that matters.
        </Text>
      ) : null}

      <IngestionCard
        state={data.ingestion}
        fallbackAddress={data.ingestionAddress}
        folders={loadedFolders(data.files.listings)}
      />
    </>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    headLater: { marginTop: 30, marginBottom: 4 },
    headAlone: { marginBottom: 12 },
    sub: { marginBottom: 12, maxWidth: 546 },
  });
