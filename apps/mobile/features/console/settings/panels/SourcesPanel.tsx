import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { GoogleConnectionsCard } from "../../google/GoogleConnectionsCard";
import { LiveOldCopies } from "../../google/LiveOldCopies";
import { IngestionCard } from "../../ingestion/IngestionCard";
/*
  The component's own path rather than the meetings barrel, deliberately: that
  barrel re-exports `useMeetingFlow`, which imports `expo-router`, and pulling
  a navigator into a settings panel makes every console test that renders it
  mock a router it has nothing to do with.
*/
import { ThisMachineCard } from "../../../meetings/components/ThisMachineCard";
import { selectedContext, type ConsoleData } from "../../types";
import { WorkspaceRefusalCard } from "./PanelHead";

/**
 * Mail and calendar: the Google accounts the AI reads, the forwarding
 * address, and while the owner has not answered, the Old copies row.
 *
 * Both gates are unchanged: `GoogleConnectionsCard` draws Add and Disconnect
 * only with `googleActions`, and `IngestionCard` its sender controls only with
 * `ingestion.save`, both absent for anybody who is not the owner.
 */
export function SourcesPanel({ data }: { data: ConsoleData }) {
  const styles = useThemedStyles(makeStyles);
  const current = selectedContext(data);
  const personal = current?.kind === "personal";
  const [oldCopiesOpen, setOldCopiesOpen] = useState(false);
  const closeOldCopies = useCallback(() => setOldCopiesOpen(false), []);
  // Old copies are the owner's to answer, read from the server: never in the demo.
  const oldCopies = personal && current !== null && current.role === "owner" && !data.demo ? current.id : null;

  if (oldCopies !== null && oldCopiesOpen) {
    return <LiveOldCopies workspaceId={oldCopies} open onOpen={() => {}} onClose={closeOldCopies} />;
  }

  return (
    <>
      <Text variant="eyebrow" style={styles.head}>
        Mail and calendar
      </Text>

      {personal ? (
        <View style={styles.stack}>
          <GoogleConnectionsCard
            connections={data.googleConnections}
            actions={data.googleActions}
            loading={data.loading}
          />
          {oldCopies === null ? null : (
            <LiveOldCopies workspaceId={oldCopies} open={false} onOpen={() => setOldCopiesOpen(true)} onClose={() => {}} />
          )}
          {/* Draws nothing in a browser or on a phone: there is no machine. */}
          <ThisMachineCard focus="chats" />
          <IngestionCard state={data.ingestion} fallbackAddress={data.ingestionAddress} />
        </View>
      ) : (
        <WorkspaceRefusalCard title="Mail and calendar belong to a personal workspace">
          A shared workspace has no mailbox, calendar or forwarding address of its own.
          Notes reach it when someone moves them here.
        </WorkspaceRefusalCard>
      )}
    </>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    head: { marginTop: space.x5, marginBottom: space.x2 },
    stack: { gap: space.x3 },
  });
