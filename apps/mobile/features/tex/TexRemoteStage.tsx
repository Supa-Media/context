import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { Path, Svg } from "react-native-svg";
import { useColors } from "../design/theme";
import type { Frame, TexAction } from "./texComputer";
import { IDLE, gestureStep, type Gesture, type InputMode, type Remote, type TouchEvent } from "./remoteGesture";
import { clampView, fitFrame, pageCentre, pageToStage, restingView, type Point, type Size } from "./remoteView";

type LiveFrame = Extract<Frame, { running: true }>;

/** The cursor's size on the glass, in points. A desktop pointer's, so it reads as one. */
const CURSOR = 22;

/**
 * The browser's own gestures off on the stage: on a phone's browser a pinch
 * here zooms the remote picture, not the whole page, and a drag moves the
 * cursor rather than the document. `touchAction` is a web style React
 * Native's types do not list; native ignores it.
 */
const WEB_TOUCH = { touchAction: "none", userSelect: "none" } as unknown as ViewStyle;

/**
 * Tex's browser, edge to edge: the picture letterboxed on the ground,
 * pinch-zoomed and panned with two fingers, and a cursor drawn over it.
 * What a finger means is `remoteGesture.ts`; this only feeds it touches,
 * draws what it answers, and hands its actions to `onAction`.
 */
export function TexRemoteStage({
  frame,
  mode,
  onAction,
}: {
  frame: LiveFrame;
  mode: InputMode;
  onAction: (action: TexAction) => void;
}) {
  const colors = useColors();
  const host = useRef<View>(null);
  const origin = useRef<Point>({ x: 0, y: 0 });
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  const page = useMemo(() => ({ width: frame.width, height: frame.height }), [frame.width, frame.height]);
  const [remote, setRemote] = useState<Remote>(() => ({ view: { zoom: 1, x: 0, y: 0 }, cursor: pageCentre(page) }));
  // The handlers read these synchronously: a move arrives before React has rendered the last one.
  const latest = useRef(remote);
  const gesture = useRef<Gesture>(IDLE);

  const commit = useCallback((next: Remote) => {
    latest.current = next;
    setRemote(next);
  }, []);

  // A new stage or a page of another size: the view kept as near as it can be, the cursor kept on the page.
  useEffect(() => {
    const was = latest.current;
    const view = was.view.zoom === 1 ? restingView(stage, page) : clampView(was.view, stage, page);
    const cursor = {
      x: Math.min(Math.max(was.cursor.x, 0), page.width),
      y: Math.min(Math.max(was.cursor.y, 0), page.height),
    };
    commit({ view, cursor });
  }, [commit, stage, page]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height, x, y } = event.nativeEvent.layout;
    origin.current = { x, y };
    setStage({ width, height });
    // Where the stage is in the window, so a finger's page position becomes a stage position.
    host.current?.measureInWindow?.((left, top) => {
      if (Number.isFinite(left) && Number.isFinite(top)) origin.current = { x: left, y: top };
    });
  }, []);

  const feed = useCallback(
    (type: TouchEvent["type"], event: GestureResponderEvent) => {
      const native = event.nativeEvent;
      const list = Array.isArray(native.touches) ? native.touches : [];
      // A mouse on the web reports no touch list while pressed in some browsers: the event itself is the finger.
      const raw = list.length > 0 || type === "up" || type === "cancel" ? list : [native];
      const touches = raw.map((t) => ({ x: t.pageX - origin.current.x, y: t.pageY - origin.current.y }));
      const step = gestureStep({ gesture: gesture.current, remote: latest.current, mode, stage, page, event: { type, touches, at: Date.now() } });
      gesture.current = step.gesture;
      if (step.remote !== latest.current) commit(step.remote);
      for (const action of step.actions) onAction(action);
    },
    [commit, mode, onAction, stage, page],
  );

  const fit = fitFrame(stage, page);
  const { view, cursor } = remote;
  const at = pageToStage(cursor, stage, page, view);
  const source = { uri: `data:image/jpeg;base64,${frame.frame}` };
  return (
    <View
      ref={host}
      style={[styles.stage, { backgroundColor: colors.ground }, WEB_TOUCH]}
      onLayout={onLayout}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(event) => feed("down", event)}
      onResponderStart={(event) => feed("down", event)}
      onResponderMove={(event) => feed("move", event)}
      onResponderEnd={(event) => feed("up", event)}
      onResponderRelease={(event) => feed("up", event)}
      onResponderTerminate={(event) => feed("cancel", event)}
      accessibilityLabel={
        mode === "trackpad"
          ? "Tex's browser. Drag to move the pointer, tap to click, two fingers to scroll or zoom."
          : "Tex's browser. Tap to click there, two fingers to scroll or zoom."
      }
      testID="tex-frame"
    >
      <View style={[StyleSheet.absoluteFill, styles.inert]}>
        <Image
          source={source}
          resizeMode={fit === null ? "contain" : "stretch"}
          style={
            fit === null
              ? StyleSheet.absoluteFill
              : [styles.picture, { left: view.x, top: view.y, width: fit.width * view.zoom, height: fit.height * view.zoom }]
          }
          testID="tex-picture"
        />
      </View>
      {at !== null ? (
        <View style={[styles.cursor, styles.inert, { left: at.x, top: at.y }]} testID="tex-cursor">
          <Svg width={CURSOR} height={CURSOR} viewBox="0 0 24 24">
            {/* The classic arrow, tip at the box's corner: the corner is where the click lands. */}
            <Path
              d="M1 1 L1 19 L6 14.5 L9.5 22 L12.5 20.7 L9 13.3 L15.5 13.3 Z"
              fill={colors.text}
              stroke={colors.ground}
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          </Svg>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, overflow: "hidden" },
  picture: { position: "absolute" },
  // Drawn over the stage, never a target: every touch is the stage's.
  inert: { pointerEvents: "none" },
  // The arrow's tip is drawn one unit in from the corner; nudged back so the tip, not the box, is on the point.
  cursor: { position: "absolute", width: CURSOR, height: CURSOR, marginLeft: -1, marginTop: -1 },
});
