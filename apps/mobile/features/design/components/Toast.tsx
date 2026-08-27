import { useEffect, useRef, useState, type JSX } from "react";
import { Animated, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radii, space } from "../tokens";
import { useReducedMotion } from "../useReducedMotion";
import { Button } from "./Button";
import { Text } from "./Text";

/**
 * Transient notices, and the place an optimistic action goes to be undone.
 *
 * The console moves files optimistically — the row jumps to its new folder
 * before the bucket has confirmed anything — and an optimistic action needs two
 * things the console's single `notice` line cannot give it: somewhere for a
 * *failure* to appear while the person has already looked away at whatever they
 * did next, and a way back that does not require finding the file again.
 */

export interface ToastSpec {
  id: string;
  message: string;
  tone?: "neutral" | "warn" | "crit";
  undo?: () => void;
}

/**
 * How long a toast stays.
 *
 * Eight seconds, deliberately, and it is the undo that sets the number. The
 * usual two-second toast is tuned for a notice nobody has to act on; as an undo
 * window it is theatre. The sequence after a file move is: notice the row moved,
 * read the toast, decide it was wrong, move the pointer, click. Two seconds does
 * not cover *reading it*, so an undo nobody can catch is the same as no undo,
 * except that we told them there was one.
 *
 * Eight is long enough to read, decide and reach, and short enough that a stack
 * of them does not become furniture. Hovering pauses it, so "I am still reading
 * this" is honoured rather than raced.
 */
export const TOAST_MS = 8000;

export function ToastHost({
  toasts,
  onDismiss,
  bottomInset = 0,
}: {
  toasts: ToastSpec[];
  onDismiss: (id: string) => void;
  /**
   * Chrome the toasts must clear — the phone layout's bottom toolbar. Passed in
   * rather than read from the layout tokens here, because which regions exist
   * at a given width is `features/app/frame.ts`'s decision, and a component
   * that guessed would be wrong in exactly the layouts nobody resizes into.
   */
  bottomInset?: number;
}): JSX.Element {
  const insets = useSafeAreaInsets();

  return (
    <View
      // `box-none`: the host spans the width, so it must not swallow clicks
      // aimed at the editor underneath. Only the toasts themselves are targets.
      pointerEvents="box-none"
      style={[styles.host, { bottom: bottomInset + insets.bottom + space.x4 }]}
      testID="toast-host"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </View>
  );
}

function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastSpec;
  onDismiss: (id: string) => void;
}) {
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);

  /**
   * The timer is budget-based rather than restarted, so hovering *pauses* the
   * dismissal instead of extending or resetting it: an undo window that grew
   * every time the pointer crossed it would keep stale toasts on screen, and
   * one that reset would make a careful reader wait longer than a careless one.
   */
  const remaining = useRef(TOAST_MS);
  const startedAt = useRef(0);

  useEffect(() => {
    if (paused) return;
    startedAt.current = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
    };
  }, [paused, toast.id, onDismiss]);

  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) {
      // No fade, no travel — the toast is simply there. `useReducedMotion`
      // starts `true`, so this is also the pre-resolution state and nothing
      // animates before we know what the person asked for.
      opacity.setValue(1);
      return;
    }
    Animated.timing(opacity, {
      toValue: 1,
      duration: 140,
      useNativeDriver: Platform.OS !== "web",
    }).start();
  }, [reduced, opacity]);

  const tone = toast.tone ?? "neutral";

  return (
    <Animated.View
      style={[
        styles.toast,
        toneStyles[tone],
        { opacity },
        !reduced && {
          transform: [
            { translateY: opacity.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
          ],
        },
      ]}
      // Pointer events cover mouse and pen on web and are inert on a
      // touch-only surface, which is the right split: there is no hover to
      // honour on a phone, and the full eight seconds runs there.
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      role="status"
      testID={`toast-${toast.id}`}
    >
      <Text variant="rowSub" style={[styles.message, messageTones[tone]]}>
        {toast.message}
      </Text>
      {toast.undo ? (
        <Button
          label="Undo"
          // Naming what is being undone, because "Undo" read out on its own —
          // by a screen reader, or by anybody arriving at the button without
          // having read the sentence beside it — describes nothing.
          accessibilityLabel={`Undo: ${toast.message}`}
          variant="mini"
          onPress={() => {
            toast.undo?.();
            onDismiss(toast.id);
          }}
          testID={`toast-undo-${toast.id}`}
        />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    gap: space.x2,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x3,
    maxWidth: 460,
    // Never edge-to-edge on a phone: the inset is what says this is a card
    // over the editor rather than a new bar attached to it.
    marginHorizontal: space.x4,
    paddingVertical: space.x3,
    paddingHorizontal: space.x4,
    borderRadius: radii.card,
    borderWidth: 1,
    backgroundColor: colors.surface3,
    boxShadow: "0 18px 44px -18px rgba(0,0,0,.9)",
  },
  message: { flexShrink: 1 },
});

const toneStyles = StyleSheet.create({
  neutral: { borderColor: colors.lineStrong },
  warn: { borderColor: colors.warnBorder, backgroundColor: colors.warnWash },
  crit: { borderColor: colors.critBorder, backgroundColor: colors.critWash },
});

const messageTones = StyleSheet.create({
  neutral: { color: colors.text },
  warn: { color: colors.warnText },
  crit: { color: colors.critText },
});
