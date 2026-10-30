import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { E2EFixtureScreen } from "../console/E2EFixtureScreen";
import { DONE_TOP, SetupDone } from "../console/setupWidget/SetupDone";

/**
 * "You're set up." over the console, for screenshots:
 * `/e2e-fixture?screen=setup-done`. Every row is drawn (shared workspace,
 * Discord, invites, the prompt), since the tallest card is the one that has to
 * fit. The layer measures itself and hands its height to the card, as
 * `SetupWidgetHost` does. Nothing reaches an account.
 */
export function SetupDoneFixture() {
  const [areaHeight, setAreaHeight] = useState<number | undefined>(undefined);
  return (
    <View style={{ flex: 1 }}>
      <E2EFixtureScreen returned={null} note={null} trashed={false} />
      <View
        style={styles.layer}
        pointerEvents="box-none"
        onLayout={(event) => setAreaHeight(event.nativeEvent.layout.height)}
      >
        <SetupDone
          areaHeight={areaHeight}
          onClose={() => {}}
          onNewWorkspace={() => {}}
          onJoinCommunity={() => {}}
          invitesLeft={3}
          onInviteFriends={() => {}}
          onCopyBootstrap={async () => true}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    paddingTop: DONE_TOP,
    paddingHorizontal: 24,
  },
});
