import { Pressable, StyleSheet, View } from "react-native";
import { AccessoryGlyph } from "../../features/console/files/AccessoryGlyph";
import { radii, space } from "../../features/design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../features/design/theme";
import { Tex } from "../../features/chaos/Tex";
import { Icon } from "../../features/design/components/Icon";
import { useFrame } from "../../features/app/AppFrame";
import { AreasGlyph, OwnerFace } from "./parts";
import { Pill } from "../../features/design/components/Pill";
import { Button } from "../../features/design/components/Button";
import { AskButton, AskFace } from "../../features/tex/chat/TexAskFace";

/**
 * PROTOTYPE. The right rail with an Areas tab, and an empty panel the
 * clickable prototype's script fills. Also draws, hidden, the real faces and
 * icons the script clones, so the prototype uses the app's own drawings.
 */
export function SeatsAside() {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const frame = useFrame();
  const strip = frame.state.asideFolded || !frame.state.asideOpen;
  const rail = (
    <View style={[styles.strip, !strip && styles.stripBeside]} testID="aside-strip">
      <Pressable style={styles.button} testID="aside-unfold" onPress={() => frame.toggleAside()} accessibilityLabel="Hide the side panel">
        <AccessoryGlyph name="panelRight" size={18} color={colors.accent} />
      </Pressable>
      <Pressable style={styles.button} accessibilityLabel="Search notes and names">
        <AccessoryGlyph name="search" size={18} color={colors.accent} />
      </Pressable>
      <Pressable style={styles.button} accessibilityLabel="Map">
        <AccessoryGlyph name="links" size={18} color={colors.accent} />
      </Pressable>
      <View style={styles.rule} />
      <Pressable style={[styles.button, !strip && styles.current]} testID="aside-strip-areas" onPress={() => frame.toggleAside()} accessibilityLabel="Areas">
        <AreasGlyph size={18} color={colors.accent} />
      </Pressable>
      <Pressable style={styles.button} testID="aside-strip-meetings" accessibilityLabel="Meetings">
        <AccessoryGlyph name="calendar" size={18} color={colors.accent} />
      </Pressable>
      <Pressable style={styles.button} testID="aside-strip-tex" accessibilityLabel="Tex">
        <Tex chaos={0} size={22} />
      </Pressable>
    </View>
  );
  if (strip) return <View style={styles.folded}>{rail}</View>;
  return (
    <View style={styles.row}>
      <View style={styles.panel} testID="seats-panel">
        <View testID="seats-mount" style={styles.mount} />
      </View>
      {rail}
    </View>
  );
}

/** The app's own drawings, for the script to clone. */
export function Sprites() {
  const colors = useColors();
  const sprite = (id: string, node: React.ReactNode) => (
    <View key={id} testID={`sprite-${id}`}>
      {node}
    </View>
  );
  return (
    <View style={{ display: "none" }} testID="sprites">
      {[16, 20, 24, 32].flatMap((size) => [
        sprite(`seyi-${size}`, <OwnerFace owner={{ kind: "person", name: "Seyi" }} size={size} />),
        sprite(`dev2-${size}`, <OwnerFace owner={{ kind: "person", name: "Dev2" }} size={size} />),
        sprite(`dev2b-${size}`, <OwnerFace owner={{ kind: "person", name: "Dev2" }} size={size} helper />),
        sprite(`tex-${size}`, <OwnerFace owner={{ kind: "tex" }} size={size} />),
        sprite(`none-${size}`, <OwnerFace owner={null} size={size} />),
      ])}
      {sprite("texfig-20", <Tex chaos={0} size={20} />)}
      {sprite("texfig-40", <Tex chaos={0} size={40} />)}
      {sprite("robot-16", <View style={{ width: 16, height: 16, borderRadius: 5, backgroundColor: colors.chromeMuted, alignItems: "center", justifyContent: "center" }}><Icon name="robot" size={10} color={colors.ink} /></View>)}
      {sprite("robot-20", <View style={{ width: 20, height: 20, borderRadius: 6, backgroundColor: colors.chromeMuted, alignItems: "center", justifyContent: "center" }}><Icon name="robot" size={12} color={colors.ink} /></View>)}
      {sprite("robot-32", <View style={{ width: 32, height: 32, borderRadius: 9, backgroundColor: colors.chromeMuted, alignItems: "center", justifyContent: "center" }}><Icon name="robot" size={18} color={colors.ink} /></View>)}
      {sprite("areas-18", <AreasGlyph size={18} color={colors.accent} />)}
      {sprite("areas-22", <AreasGlyph size={22} color={colors.accent} />)}
      {sprite("areas-18m", <AreasGlyph size={18} color={colors.chromeMuted} />)}
      <View testID="sprite-tokens" accessibilityLabel={JSON.stringify(colors)} />
      {(["Entrepreneur", "Manager", "Technician"] as const).map((mode) => sprite(`pill-${mode}`, <Pill tone="neutral">{mode}</Pill>))}
      {sprite("button-assign", <Button variant="mini" label="Assign owner" onPress={() => {}} />)}
      {sprite("button-ask-tex", <Button variant="mini" label="Ask Tex" onPress={() => {}} />)}
      {sprite("button-open-folder", <Button variant="ghost" label="Open folder" onPress={() => {}} />)}
      {sprite(
        "ask-waiting",
        <AskFace
          testID="ask"
          head={{ tone: "warn", icon: "lock", text: "Waiting for you" }}
          title="Engineering agent asks: buy Sentry Team plan, $26/month."
          actions={
            <>
              <AskButton variant="primary" label="Approve" onPress={() => {}} accessibilityLabel="Approve" testID="ask-approve" />
              <AskButton variant="ghost" label="Decline" onPress={() => {}} accessibilityLabel="Decline" testID="ask-decline" />
            </>
          }
          footer="Needs your approval: spending over $20."
        />,
      )}
      {sprite(
        "ask-approved",
        <AskFace
          testID="ask"
          head={{ tone: "ok", icon: "check", text: "Approved" }}
          title="Engineering agent asks: buy Sentry Team plan, $26/month."
          footer="Seyi approved · just now. The Engineering agent was told."
        />,
      )}
      {sprite(
        "ask-declined",
        <AskFace
          testID="ask"
          head={{ tone: "muted", icon: null, text: "Declined" }}
          title="Engineering agent asks: buy Sentry Team plan, $26/month."
          footer="The Engineering agent was told."
        />,
      )}
      {(["chevronLeft", "chevronRight", "chevronDown", "lock", "check", "folder", "close", "robot", "plus", "more", "chat", "arrowUp", "share", "pin"] as const).map((name) =>
        sprite(`icon-${name}`, <Icon name={name} size={12} color="currentColor" />),
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: { flex: 1, minWidth: 0, flexDirection: "row" },
    folded: { flex: 1, alignItems: "flex-end" },
    panel: { flex: 1, minWidth: 0 },
    mount: { flex: 1, minHeight: 0 },
    strip: { width: 48, alignItems: "center", gap: space.x1, paddingTop: space.x2 },
    stripBeside: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.line },
    button: { width: 36, height: 36, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
    current: { backgroundColor: colors.chrome },
    rule: { width: 22, height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: space.x1 },
  });
