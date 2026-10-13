import { useCallback, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Text } from "../design/components/Text";
import { leading, pointerType as t, radii } from "../design/tokens";
import { ThemeProvider, useColors, useThemedStyles, type Colors } from "../design/theme";
import { dismissKeyboard } from "../design/keyboardSticky";
import { Screen } from "../app/Screen";
import { firstParam } from "../invite/invite";
import { MCP_ENDPOINT } from "../console/placeholderData";
import { HAND_BACK_NOTICE, hostOf, resolveTexPage, texHref, type TexAction, type TexPageView } from "./texComputer";
import { useTexComputer, type TexComputerState } from "./useTexComputer";
import type { InputMode } from "./remoteGesture";
import { TexRemoteStage } from "./TexRemoteStage";
import { SendTextBar, TexToolbar, type TexMenuId } from "./TexRemoteChrome";

/**
 * `/tex/<handle>`: Tex's browser, as Chrome Remote Desktop shows a computer on
 * a phone. The remote screen edge to edge on a dark ground, a small bar of
 * icons over it, a cursor on it, and a "Send text" bar under it. Watching and
 * driving are one screen: it opens on the live picture, and any touch takes
 * control.
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

/**
 * Every state, drawable without a session: the render tests mount this.
 * Always the dark palette: a remote screen is looked *through*, and a light
 * frame around somebody's browser is a frame you look *at*.
 */
export function TexComputerBody(props: { view: TexPageView; computer: TexComputerState }) {
  return (
    <ThemeProvider scheme="dark">
      <TexComputerPage {...props} />
    </ThemeProvider>
  );
}

function TexComputerPage({ view, computer }: { view: TexPageView; computer: TexComputerState }) {
  const styles = useThemedStyles(makeStyles);
  const [control, setControl] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<InputMode>("trackpad");
  const [keyboard, setKeyboard] = useState(true);
  const [focus, setFocus] = useState(false);
  const { send } = computer;

  // Any touch that does something takes control: there is no button for it.
  const act = useCallback(
    (action: TexAction) => {
      setControl(true);
      setNotice(null);
      send(action);
    },
    [send],
  );

  if (view.kind === "wait" || view.kind === "signIn") return <View style={styles.ground} />;
  if (view.kind === "notFound" || view.kind === "notYours" || computer.phase === "notYours") {
    const own = view.kind === "notYours" ? view.own : null;
    return (
      <Message
        testID="tex-not-yours"
        title="This page isn’t yours"
        body={
          own !== null
            ? `Each person's agent computer is at their own address. Yours is context.lc${texHref(own)}.`
            : "Each person's agent computer is at their own address, and only they can open it."
        }
      />
    );
  }

  const frame = computer.frame?.running ? computer.frame : null;
  const status =
    frame !== null
      ? { tone: control ? ("warn" as const) : ("ok" as const), label: control ? "You're in control" : "Live", where: hostOf(frame.url) || null }
      : computer.phase === "loading"
        ? { tone: "neutral" as const, label: "Looking for Tex's browser", where: null }
        : { tone: "neutral" as const, label: computer.phase === "failed" ? "Can't reach it" : "Not running", where: null };

  const onMenu = (id: TexMenuId) => {
    setControl(false);
    dismissKeyboard();
    if (id === "handBack") setNotice(HAND_BACK_NOTICE);
    else computer.stop();
  };

  return (
    <Screen style={styles.ground} testID="tex-computer-page">
      <TexToolbar
        status={status}
        busy={computer.busy}
        controls={frame !== null}
        keyboard={keyboard}
        mode={mode}
        onKeyboard={() => {
          if (keyboard) dismissKeyboard();
          setFocus(!keyboard);
          setKeyboard(!keyboard);
        }}
        onMode={() => setMode(mode === "trackpad" ? "touch" : "trackpad")}
        onMenu={onMenu}
      />
      {frame !== null ? (
        <View style={styles.body} testID={control ? "tex-control" : "tex-live"}>
          <TexRemoteStage frame={frame} mode={mode} onAction={act} />
          {notice !== null ? <Notice text={notice} /> : null}
          {keyboard ? <SendTextBar send={act} focus={focus} /> : null}
        </View>
      ) : computer.phase === "loading" ? (
        <View style={styles.centre}>
          <ActivityIndicator size="small" />
        </View>
      ) : (
        <Off failed={computer.phase === "failed"} notice={notice} />
      )}
    </Screen>
  );
}

function Off({ failed, notice }: { failed: boolean; notice: string | null }) {
  return (
    <View style={{ flex: 1 }} testID="tex-off">
      <Message
        title={failed ? "Tex's computer can't be reached right now" : "Nothing running right now"}
        body={
          failed
            ? "Try again in a moment. Nothing on it was changed."
            : "When Tex needs you to sign in somewhere, it texts you this page. Open it then to see its browser and take over."
        }
      />
      {notice !== null ? <Notice text={notice} /> : null}
    </View>
  );
}

/** A centred title and a line, on the same dark ground as the remote screen. */
function Message({ title, body, testID }: { title: string; body: string; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Screen style={[styles.ground, styles.centre]} testID={testID}>
      <View style={styles.message}>
        <Text variant="rowTitle" style={styles.messageTitle}>
          {title}
        </Text>
        <Text variant="heroSub" style={styles.messageBody}>
          {body}
        </Text>
      </View>
    </Screen>
  );
}

/** What the person is told after handing back: floats over the picture, never pushes it. */
function Notice({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.noticeRow}>
      <Text variant="rowSub" style={[styles.notice, { color: colors.text }]} testID="tex-notice">
        {text}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    body: { flex: 1 },
    centre: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
    message: { maxWidth: 420, gap: 10 },
    messageTitle: { color: colors.text, textAlign: "center" },
    messageBody: { color: colors.text2, textAlign: "center", fontSize: t.body, lineHeight: leading(t.body, 1.55) },
    noticeRow: { pointerEvents: "none", position: "absolute", top: 12, left: 0, right: 0, alignItems: "center", paddingHorizontal: 16 },
    notice: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: radii.pill,
      backgroundColor: colors.surface3,
      overflow: "hidden",
    },
  });
