import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { Pill } from "../design/components/Pill";
import { Text } from "../design/components/Text";
import { clamp, fonts, leading, pointerType as t, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { useFieldFont } from "../design/fieldFont";
import { InvitePage, Title } from "../invite/InviteScreen";
import { firstParam } from "../invite/invite";
import { MCP_ENDPOINT } from "../console/placeholderData";
import {
  HAND_BACK_NOTICE,
  MAX_TYPED,
  SCROLL_STEP,
  hostOf,
  resolveTexPage,
  tapToPage,
  texHref,
  type Frame,
  type TexAction,
  type TexPageView,
} from "./texComputer";
import { useTexComputer, type TexComputerState } from "./useTexComputer";

/**
 * `/tex/<handle>`: "your agent's computer". Watch Tex's browser live, take
 * control to sign in, and hand it back.
 *
 * Owns its own sign-in gate, like `/texts/<token>`, so a signed-out visitor
 * goes to `/login?next=/tex/<handle>` and comes straight back.
 */
export function TexComputerScreen() {
  const params = useLocalSearchParams<{ handle?: string | string[] }>();
  const auth = useConvexAuth();
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces, auth.isAuthenticated ? {} : "skip");
  const view = resolveTexPage({ handle: firstParam(params.handle), auth, workspaces });
  const ready = view.kind === "ready" ? view : null;
  const computer = useTexComputer({
    workspaceId: ready?.workspaceId ?? null,
    handle: ready?.handle ?? null,
    endpoint: ready ? MCP_ENDPOINT : null,
  });
  if (view.kind === "signIn") return <Redirect href={view.href} />;
  return <TexComputerBody view={view} computer={computer} />;
}

/** Every state, drawable without a session: the render tests mount this. */
export function TexComputerBody({ view, computer }: { view: TexPageView; computer: TexComputerState }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const titleSize = clamp(26, 2.9, 34, width);
  const [control, setControl] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (view.kind === "wait" || view.kind === "signIn") return <View style={styles.ground} />;
  if (view.kind === "notFound" || view.kind === "notYours") {
    return (
      <InvitePage testID="tex-not-yours">
        <Title size={titleSize}>This page isn&rsquo;t yours</Title>
        <Text variant="heroSub" style={styles.sub}>
          {view.kind === "notYours" && view.own !== null
            ? `Each person's agent computer is at their own address. Yours is context.lc${texHref(view.own)}.`
            : "Each person's agent computer is at their own address, and only they can open it."}
        </Text>
      </InvitePage>
    );
  }
  if (computer.phase === "notYours") {
    return (
      <InvitePage testID="tex-not-yours">
        <Title size={titleSize}>This page isn&rsquo;t yours</Title>
      </InvitePage>
    );
  }

  const frame = computer.frame?.running ? computer.frame : null;
  const inControl = control && frame !== null;
  return (
    <View style={styles.ground} testID="tex-computer-page">
      <InvitePage>
        <View style={styles.header}>
          <Title size={titleSize}>Your agent&rsquo;s computer</Title>
          {frame !== null ? (
            <Pill tone={inControl ? "warn" : "ok"} testID="tex-live-pill">
              {inControl ? "You're in control" : "Live"}
            </Pill>
          ) : null}
        </View>
        {computer.phase === "loading" ? (
          <Card>
            <View style={styles.row}>
              <ActivityIndicator color={colors.text2} size="small" />
              <Text variant="rowSub">Looking for Tex&rsquo;s browser…</Text>
            </View>
          </Card>
        ) : frame === null ? (
          <OffState failed={computer.phase === "failed"} notice={notice} />
        ) : (
          <LiveState
            frame={frame}
            control={inControl}
            busy={computer.busy}
            notice={notice}
            send={computer.send}
            onTakeControl={() => {
              setNotice(null);
              setControl(true);
            }}
            onStop={() => {
              setControl(false);
              computer.stop();
            }}
            onDone={() => {
              setControl(false);
              setNotice(HAND_BACK_NOTICE);
            }}
          />
        )}
      </InvitePage>
      {inControl ? <TypeBar send={computer.send} busy={computer.busy} /> : null}
    </View>
  );
}

function OffState({ failed, notice }: { failed: boolean; notice: string | null }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View testID="tex-off">
      <Text variant="rowTitle" style={styles.offTitle}>
        {failed ? "Tex's computer can't be reached right now" : "Nothing running right now"}
      </Text>
      <Text variant="heroSub" style={styles.sub}>
        {failed
          ? "Try again in a moment. Nothing on it was changed."
          : "When Tex needs you to sign in somewhere, it texts you this page. Open it then to watch, or to take over."}
      </Text>
      {notice !== null ? (
        <Text variant="foot" style={styles.notice} testID="tex-notice">
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

function LiveState(props: {
  frame: Extract<Frame, { running: true }>;
  control: boolean;
  busy: boolean;
  notice: string | null;
  send: (action: TexAction) => void;
  onTakeControl: () => void;
  onStop: () => void;
  onDone: () => void;
}) {
  const { frame, control, busy, send } = props;
  const styles = useThemedStyles(makeStyles);
  const [shown, setShown] = useState({ width: 0, height: 0 });
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setShown({ width, height });
  }, []);
  const onTap = useCallback(
    (event: GestureResponderEvent) => {
      if (!control) return;
      const at = tapToPage({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }, shown, frame);
      if (at !== null) send({ kind: "tap", ...at });
    },
    [control, frame, send, shown],
  );
  return (
    <View testID={control ? "tex-control" : "tex-live"}>
      <Text variant="rowSub" style={styles.where} numberOfLines={1} testID="tex-where">
        {frame.title ? `${frame.title} · ${hostOf(frame.url)}` : hostOf(frame.url)}
      </Text>
      <Pressable
        onPress={onTap}
        disabled={!control}
        accessibilityRole={control ? "button" : "image"}
        accessibilityLabel={control ? "Tap to click here on the page" : "What Tex's browser shows now"}
        style={[styles.frameBox, control ? styles.frameControl : null, { aspectRatio: frame.width / frame.height }]}
        testID="tex-frame"
      >
        <Image
          source={{ uri: `data:image/jpeg;base64,${frame.frame}` }}
          style={styles.frameImage}
          resizeMode="contain"
          onLayout={onLayout}
        />
      </Pressable>
      {props.notice !== null ? (
        <Text variant="foot" style={styles.notice} testID="tex-notice">
          {props.notice}
        </Text>
      ) : null}
      {control ? (
        <View style={styles.controls}>
          <View style={styles.keys}>
            <Button label="Tab" variant="mini" disabled={busy} onPress={() => send({ kind: "key", name: "Tab" })} testID="tex-key-tab" />
            <Button label="Enter" variant="mini" disabled={busy} onPress={() => send({ kind: "key", name: "Enter" })} testID="tex-key-enter" />
            <Button label="Delete" variant="mini" disabled={busy} onPress={() => send({ kind: "key", name: "Backspace" })} testID="tex-key-delete" />
            <Button label="Back" variant="mini" disabled={busy} onPress={() => send({ kind: "back" })} testID="tex-key-back" />
            <Button label="Scroll up" variant="mini" disabled={busy} onPress={() => send({ kind: "scroll", dy: -SCROLL_STEP })} testID="tex-scroll-up" />
            <Button label="Scroll down" variant="mini" disabled={busy} onPress={() => send({ kind: "scroll", dy: SCROLL_STEP })} testID="tex-scroll-down" />
          </View>
          <Button label="Done, hand back to Tex" variant="decision" onPress={props.onDone} testID="tex-done" />
          <Text variant="foot" style={styles.foot}>
            Tap the picture to click there. What you type goes only to this page: Tex never sees it.
          </Text>
        </View>
      ) : (
        <View style={styles.actions}>
          <Button label="Take control" variant="accent" onPress={props.onTakeControl} testID="tex-take-control" />
          <Button label="Stop" variant="danger" disabled={busy} onPress={props.onStop} testID="tex-stop" />
        </View>
      )}
    </View>
  );
}

/** Always there while in control: what is typed goes into the focused field on the page. */
function TypeBar({ send, busy }: { send: (action: TexAction) => void; busy: boolean }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [text, setText] = useState("");
  // 16px or more on a phone, so focusing the field does not zoom the page.
  const fieldFont = useFieldFont(t.body);
  const submit = () => {
    if (text.length === 0 || busy) return;
    send({ kind: "type", text });
    setText("");
  };
  return (
    <View style={styles.typeBar} testID="tex-type-bar">
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={submit}
        placeholder="Type into the page"
        placeholderTextColor={colors.muted}
        maxLength={MAX_TYPED}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.typeInput, fieldFont]}
        testID="tex-type-input"
      />
      <Button label="Send" variant="accent" disabled={busy || text.length === 0} onPress={submit} testID="tex-type-send" />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
    sub: { marginTop: 14, fontSize: t.body, lineHeight: leading(t.body, 1.55) },
    row: { flexDirection: "row", alignItems: "center", gap: 11 },
    offTitle: { marginTop: 24 },
    where: { marginTop: 18, marginBottom: 10, color: colors.text2 },
    frameBox: {
      width: "100%",
      borderRadius: radii.card,
      borderWidth: 2,
      borderColor: colors.line,
      overflow: "hidden",
      backgroundColor: colors.surface2,
    },
    // The person is driving: the same amber the "in control" pill wears.
    frameControl: { borderColor: colors.warn },
    frameImage: { width: "100%", height: "100%" },
    notice: { marginTop: 14, color: colors.text2 },
    actions: { flexDirection: "row", gap: 10, marginTop: 18, flexWrap: "wrap" },
    controls: { marginTop: 16, gap: 14 },
    keys: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    foot: { color: colors.muted, lineHeight: leading(12.5, 1.5) },
    typeBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: 1,
      borderTopColor: colors.line,
      backgroundColor: colors.surface,
    },
    typeInput: {
      flex: 1,
      minHeight: 44,
      paddingHorizontal: 12,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.warnBorder,
      backgroundColor: colors.surface2,
      color: colors.text,
      fontFamily: fonts.body,
      fontSize: t.body,
    },
  });
