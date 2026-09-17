import { StyleSheet, View } from "react-native";
import { AppFrame } from "../app/AppFrame";
import { Text } from "../design/components/Text";
import { space } from "../design/tokens";

/**
 * `AppFrame` on a browser-reachable screen, with stub slots.
 *
 * ## Why this exists
 *
 * `appFrameRender.test.ts` mounts the real frame and resolves react-native-web's
 * stylesheet, which makes "there is a bottom toolbar and no rail" a real
 * assertion. **jsdom lays nothing out**, so it cannot answer the questions the
 * folding panels actually raise, and every one of them is a layout question:
 *
 *  - does the peek land where the column was, or forty points into the rail;
 *  - does it *float*, or does it push the editor across and move the paragraph
 *    somebody is reading;
 *  - is the seam a 7pt target or a zero-width sliver nobody can hit;
 *  - does folding the tree actually give the editor the width back.
 *
 * `E2EFixtureScreen` is deliberately **not** this: it reproduces the console's
 * panes on demo data and says in its own header that "what is not reproduced is
 * `AppFrame` itself". So the frame had no browser-reachable screen at all, for
 * the same reason `/welcome` had none before `FirstRunStorageFixture` — the
 * real one needs a session and a deployment — and this is the same answer.
 *
 * ## What is real here and what is not
 *
 * The frame is the shipping component, unmodified, with its own state, its own
 * commands and its own seams. Only the *contents* of the slots are stubs, which
 * is exactly the split the frame is built around: it "knows about geometry and
 * nothing else", so geometry is all this has to supply. Nothing here can reach
 * an account or a bucket; there is no data behind it.
 */
export function AppFrameFixture() {
  const styles = useStyles();
  return (
    <AppFrame
      switcher={<Text variant="wsSwitch">@seyi</Text>}
      topTrailing={<Text variant="treeMeta">actions</Text>}
      accountSlot={<Text variant="treeMeta">you</Text>}
      onSearch={() => {}}
      explorer={
        <View style={styles.slot} testID="fixture-explorer">
          <Text variant="treeMeta">1-projects</Text>
        </View>
      }
      status={<Text variant="treeMeta">490 words</Text>}
      bottomBar={<Text variant="treeMeta">toolbar</Text>}
    >
      <View style={styles.note} testID="fixture-note">
        <Text variant="body">
          The console is three regions and the whole of the responsive design is deciding which of
          them exist at a given width.
        </Text>
      </View>
    </AppFrame>
  );
}

function useStyles() {
  return StyleSheet.create({
    /* Filled, so that a bounding box in a browser is the region's own and not
       the text's — a slot that shrank to its label would make every width
       assertion here a measurement of the word "rail". */
    slot: { flex: 1, padding: space.x3 },
    note: { flex: 1, padding: space.x5 },
  });
}
