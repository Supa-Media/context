import { Component, type ErrorInfo, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { StageBackdrop } from "../design/components/StageBackdrop";
import { colors, leading, radii } from "../design/tokens";
import { canReload, reloadApp } from "./reload";

/**
 * The one thing standing between a thrown render and a blank dark page.
 *
 * ## Why this has to exist
 *
 * Convex's `useQuery` **re-throws a failed query during render**
 * (`convex/react`'s `useQuery`: `if (result instanceof Error) throw result`).
 * Any transient failure — an auth blip while a token refreshes, a deploy
 * rolling the backend, a function that throws for a state nobody anticipated —
 * therefore unmounts whatever tree the query was in. With no boundary above it,
 * React unmounts the *whole* app: the user gets the dark ground and nothing
 * else, no message, no control, no way back except discovering for themselves
 * that reloading helps.
 *
 * The queries the console cannot do without no longer throw — they use
 * `useQueries` and treat an `Error` as a value, which is the actual fix (see
 * `features/console/useLiveConsoleData.ts`). **This is the backstop, not the
 * fix**, and it is what catches the next one: an unforeseen throw anywhere in
 * any screen becomes a page with words on it rather than a void.
 *
 * ## What it offers, and what it refuses to offer
 *
 * "Try again" resets the boundary, which is honest about what it does: it
 * re-renders the children. For a failure that has since cleared — the usual
 * case — that is enough. If the same throw comes straight back, the same screen
 * comes back with it; the boundary does not retry on its own, because a
 * boundary that resets itself against a persistent throw is an infinite loop
 * with a spinner on it.
 *
 * "Reload" appears only where it is real. See `./reload.ts`.
 *
 * The error's own message is shown, deliberately quietly, because "somebody
 * screenshots the screen and we can see what broke" is worth more here than the
 * tidiness of hiding it — and because this app's own errors are `ConvexError`
 * payloads written for people. It is never the *headline*: a raw message is not
 * an explanation of what to do next.
 */

interface Props {
  children: ReactNode;
  /** Reported so a host can log it. Called with whatever was thrown. */
  onError?: (error: unknown, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <ErrorScreen
        error={error}
        onRetry={() => {
          this.setState({ error: null });
        }}
      />
    );
  }
}

/**
 * Exported so the failure state can be rendered and looked at without arranging
 * for something to throw — the same reason `ConsentBody` is exported.
 */
export function ErrorScreen({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const detail = error.message.trim();

  return (
    <View style={styles.ground} testID="error-boundary">
      <StageBackdrop />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.wrap}>
          <Text variant="mark" style={styles.mark}>
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>

          <Text role="heading" aria-level={1} style={styles.title}>
            Something broke on this screen
          </Text>

          <Text variant="heroSub" style={styles.sub}>
            Nothing has happened to your notes — they live in your own bucket and this is only
            the app in front of them. Try again, and if it keeps happening, reload.
          </Text>

          {detail.length > 0 ? (
            <View style={styles.detail}>
              <Text variant="foot" selectable>
                {detail}
              </Text>
            </View>
          ) : null}

          <View style={styles.actions}>
            <Button label="Try again" variant="white" onPress={onRetry} testID="error-retry" />
            {canReload ? (
              <Button
                label="Reload"
                variant="ghost"
                style={styles.reload}
                onPress={reloadApp}
                testID="error-reload"
              />
            ) : null}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground, overflow: "hidden" },
  scroll: { flex: 1 },
  content: { flexGrow: 1, justifyContent: "center" },
  wrap: {
    width: "100%",
    maxWidth: 520,
    marginHorizontal: "auto",
    paddingHorizontal: 28,
    paddingVertical: 48,
  },
  mark: { alignSelf: "flex-start", marginBottom: 30 },
  markSuffix: { color: colors.muted },
  title: {
    fontSize: 28,
    lineHeight: leading(28, 1.1),
    fontWeight: "500",
    color: colors.text,
  },
  sub: { marginTop: 14, fontSize: 15.5, lineHeight: leading(15.5, 1.55) },
  detail: {
    marginTop: 22,
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
  },
  actions: { marginTop: 26, flexDirection: "row", alignItems: "center", gap: 16, flexWrap: "wrap" },
  // `Button`'s base style sets `alignSelf: "flex-start"`, which beats the row's
  // `alignItems: "center"`; without this the ghost link floats to the top of
  // the taller button beside it. Same fix as the consent screen's dead ends.
  reload: { alignSelf: "center" },
});
