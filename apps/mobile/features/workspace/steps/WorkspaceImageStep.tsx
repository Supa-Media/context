import { StyleSheet, View } from "react-native";
import { TextLink } from "../../design/components/TextLink";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useThemedStyles } from "../../design/theme";
import { WorkspaceIconPicker } from "../../console/settings/panels/WorkspaceIconPicker";
import { imageStepOffersPhoto } from "../create";
import type { CreateWorkspaceController } from "../useCreateWorkspace";

/**
 * Step 4 — the picture the workspace is drawn with.
 *
 * ## Why it is a step and not only a setting
 *
 * The mark was chosen in settings and nowhere else, so every new workspace
 * arrived drawn as the first letter of its slug — and a person holding `@acme`
 * and `@atlas` got **A** twice in the switcher whose whole job is telling them
 * apart. The owner asked for it here (2026-09-26), and it is also the image a
 * published website shows as its favicon, so it is worth choosing once, early.
 *
 * ## The same picker as settings, not a second one
 *
 * `WorkspaceIconPicker` saves on press, through the same owner-only mutations
 * and the same size and shape checks. A choice that saved moves the flow on;
 * "Skip for now" moves it on without one, and the letter stays until somebody
 * picks from settings. A photo is offered only where there is a bucket to hold
 * it — see `imageStepOffersPhoto`.
 */
export function WorkspaceImageStep({ controller }: { controller: CreateWorkspaceController }) {
  const styles = useThemedStyles(makeStyles);
  const workspaceId = controller.created?.workspaceId;
  const photo = imageStepOffersPhoto(controller.shape);

  return (
    <View testID="workspace-image-step">
      <Text variant="rowSub" style={styles.lede}>
        {photo
          ? "Pick an emoji or a photo. It is how the workspace is drawn in everyone's switcher, and the icon its website shows in a browser tab."
          : "Pick an emoji. It is how the workspace is drawn in everyone's switcher, and the icon its website shows in a browser tab. A photo can be chosen from settings once it has a bucket."}
      </Text>

      {workspaceId === undefined ? null : (
        <WorkspaceIconPicker
          workspaceId={workspaceId}
          allowPhoto={photo}
          onClose={controller.continuePastImage}
        />
      )}

      <View style={styles.actions}>
        <TextLink
          label="Skip for now"
          onPress={controller.continuePastImage}
          testID="workspace-image-skip"
        />
      </View>
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    lede: { lineHeight: leading(12.5, 1.7) },
    actions: { marginTop: 20, flexDirection: "row", alignItems: "center", gap: 14 },
  });
