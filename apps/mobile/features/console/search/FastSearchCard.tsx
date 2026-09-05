import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Row } from "../../design/components/Card";
import { Dot } from "../../design/components/Dot";
import { Hint } from "../../design/components/Field";
import { FormError, Notice } from "../../design/components/Input";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useArming } from "../useArming";
import {
  describeFastSearch,
  describeIndexProgress,
  fastSearchControl,
  fastSearchPill,
  indexedLabel,
  type FastSearchView,
} from "./fastSearch";

/**
 * Fast search, in a context's settings.
 *
 * The one control in this console that puts a copy of somebody's notes
 * somewhere they do not own, so it is drawn as a decision rather than a
 * preference: the heading says which of the five states this context is in,
 * the paragraph says what the copy is and where it lives, and the two presses
 * on the way out say what the second one deletes.
 *
 * ## Why turning it *off* is the armed control and turning it on is not
 *
 * The reverse of the usual instinct, and it follows from what each press
 * costs. Turning it on is reversible by turning it off — the database is
 * deleted, the notes were never anywhere else, nothing is lost. Turning it off
 * destroys an index that took a backfill to build, and a mis-tap on a phone in
 * a pocket is exactly the input `useArming` exists for. So On is one press, Off
 * is two, and the second expires.
 *
 * ## What is absent rather than disabled
 *
 * Everything the server would refuse. `fastSearchControl` is the single place
 * that decides, and it reads the server's own `canChange` — a member sees the
 * state and no switch, the landing page's demo console sees the same card with
 * nothing behind it, and neither is offered a button whose only outcome is a
 * permission error.
 */
export function FastSearchCard({
  view,
  /** True on the landing page's picture of a console, which has no context. */
  demo = false,
}: {
  view: FastSearchView;
  demo?: boolean;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = (action: (() => Promise<void>) | undefined) => {
    if (action === undefined) return;
    setWorking(true);
    setFailure(null);
    void action()
      .catch(() =>
        // Our sentence, never the backend's: a Convex error can carry a
        // function path, and a person reading a settings card is owed the next
        // step instead. The state itself is the record — `failed` arrives on
        // the status with the deployment's own reason.
        setFailure("That did not go through. Check your connection and try again."),
      )
      .finally(() => setWorking(false));
  };

  /*
    Held during the mutation by `working`, which `run` sets synchronously —
    the contract `useArming` documents for a synchronous `run`, and the reason
    the button's `disabled` reads it rather than the arming stage.

    `run` and only `run` sets it, deliberately: an earlier version set it here
    too, so an absent `disable` — the one path `run` returns early on — left the
    button reading "Turning off…" with nothing coming back to clear it.
  */
  const off = useArming(() => run(view.disable));

  if (view.status === null) {
    return (
      <Card>
        <View style={styles.loadingRow}>
          {view.loading ? <ActivityIndicator color={colors.text2} size="small" /> : null}
          <Text variant="rowSub">
            {view.loading
              ? "Loading…"
              : "How this context's search is served could not be read just now."}
          </Text>
        </View>
      </Card>
    );
  }

  const status = view.status;
  const copy = describeFastSearch(status.state);
  const pill = fastSearchPill(status.state);
  const control = fastSearchControl(view);
  const indexed = indexedLabel(status);
  const progress = describeIndexProgress(status);

  return (
    <Card>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text variant="rowTitle">{copy.title}</Text>
          <Text variant="rowSub" style={styles.blurb}>
            {copy.blurb}
          </Text>
        </View>
        {pill === null ? null : (
          <Pill tone={pill.tone} leading={<Dot tone={pill.tone} />}>
            {pill.label}
          </Pill>
        )}
      </View>

      {/*
        How much of the context is in, and then how many notes that is.

        The percentage leads because it is the question somebody actually has
        — "is this finished, and if not how far off is it" — and because "0
        notes indexed", which is all this card used to say, is what let a stuck
        backfill and a working one look identical for hours. The count stays
        underneath it: a percentage alone cannot say whether 62% is six notes
        or six thousand, and the second line is the one that makes the first
        one mean something.

        Both are absent rather than zero — the same rule the storage card's
        note count follows — and both are absent for a member, because the
        server withholds the census a percentage would be derived from.

        `describeIndexProgress` is the same function the status bar and the file
        tree's footer read, so one context cannot be 62% in three places and
        63% in a fourth.
      */}
      {progress === null && indexed === null ? null : (
        <Notice style={styles.notice} testID="fast-search-index">
          {progress === null ? null : (
            <Text
              variant="check"
              role="status"
              // The visible string is a fragment — "62% indexed" says nothing
              // about *what* is indexed or what the denominator is. A screen
              // reader gets the sentence.
              accessibilityLabel={progress.detail}
              testID="fast-search-progress"
            >
              {progress.label}
            </Text>
          )}
          {indexed === null ? null : (
            <Text
              variant="rowSub"
              role="status"
              style={progress === null ? undefined : styles.progressCount}
            >
              {indexed}
            </Text>
          )}
        </Notice>
      )}

      {/*
        The deployment's own sentence for a failed provision, from the closed
        set in `fastSearchProvision.ts`. It never carries Cloudflare's text —
        a provider message can name the account or the token.
      */}
      {status.state === "failed" && status.error ? (
        <FormError headline={status.error} style={styles.notice} />
      ) : null}

      {failure === null ? null : <FormError headline={failure} style={styles.notice} />}

      {control === "none" ? null : (
        <Row style={styles.actions}>
          {control === "disable" ? (
            <Button
              label={
                working
                  ? "Turning off…"
                  : off.stage === "armed"
                    ? "Press again to turn off"
                    : "Turn off"
              }
              accessibilityLabel="Turn fast search off and delete the hosted index"
              variant="danger"
              disabled={working}
              onPress={off.press}
              testID="fast-search-disable"
            />
          ) : (
            <Button
              label={
                working
                  ? "Turning on…"
                  : control === "retry"
                    ? "Try again"
                    : "Turn on fast search"
              }
              accessibilityLabel={
                control === "retry"
                  ? "Try preparing the index again"
                  : "Turn fast search on for this context"
              }
              disabled={working}
              onPress={() => run(view.enable)}
              trailing={
                working ? <ActivityIndicator color={colors.text} size="small" /> : null
              }
              testID="fast-search-enable"
            />
          )}
        </Row>
      )}

      {/*
        What the second press does, at the moment of the press rather than in a
        paragraph scrolled off the top — the same treatment Disconnect gets,
        and for the same reason: this is where somebody decides.
      */}
      {off.stage === "armed" ? (
        <Hint>
          <Text variant="hint">
            The hosted database and everything copied into it are deleted. Your notes
            are untouched in your own bucket, and search goes back to reading the index
            there — turning this on again rebuilds the copy from scratch.
          </Text>
        </Hint>
      ) : null}

      {control === "none" && status.state !== "unavailable" ? (
        <Text variant="foot" style={styles.readOnly}>
          {demo
            ? "Sign in and open your own context to decide this for it."
            : "Only an owner of this context can change this. An editor may write every note here; deciding where a copy of all of them is kept is a different call."}
        </Text>
      ) : null}
    </Card>
  );
}

const makeStyles = (_colors: Colors) => StyleSheet.create({
  head: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  headText: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  blurb: { marginTop: 4, maxWidth: 546 },
  notice: { marginTop: 15 },
  /** The count under the percentage, not beside it. */
  progressCount: { marginTop: 3 },
  actions: { marginTop: 17, gap: 9, flexWrap: "wrap" },
  readOnly: { marginTop: 12, lineHeight: leading(12.5, 1.6) },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
});
