import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles } from "../../../design/theme";
import { describeGoingPublic, scopeLabels, type NoteScope } from "../scope";
import type { AudienceContext } from "../../privacy/audience";
import { makeStyles } from "./styles";

/**
 * A glyph per position, for the phone's rows.
 *
 * `lock` / `people` / `globe` are the three marks this icon set already owns
 * for exactly these ideas — `lock` is what the top bar's padlock was, and
 * `globe` is what it turned into on its third press. The set is not extended
 * for this: a landing page inventing its own line art is the drift
 * `Sections.tsx` refuses, and a dialog doing it would be the same drift closer
 * to home.
 */
const POSITION_ICON: Record<NoteScope, "lock" | "people" | "globe"> = {
  private: "lock",
  team: "people",
  anyone: "globe",
};

/**
 * The three positions, named, with the dangerous one confirmed.
 *
 * Two positions for a folder — `createLinkShare` is note-only, so a third would
 * be a press that always fails, which is what the old "Create link" button was
 * doing for folders.
 *
 * The confirmation is only on the way *to* `anyone`. Every other move narrows
 * or stays inside the context, and a dialog that asks before making something
 * more private teaches people to dismiss it without reading — which is the
 * habit that then costs them the one that mattered.
 */
export function AudienceControl({
  scope,
  canOpenLink,
  name,
  onSet,
  context,
  compact = false,
}: {
  scope: NoteScope;
  canOpenLink: boolean;
  name: string;
  onSet: (from: NoteScope, to: NoteScope) => void;
  /** Whose context this is, so the middle position can carry its name. */
  context: AudienceContext;
  /**
   * The phone, where the three positions are a grouped list rather than a
   * segmented control. See the rows below.
   */
  compact?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [confirming, setConfirming] = useState(false);
  const labels = scopeLabels(context);

  const positions: NoteScope[] = canOpenLink
    ? ["private", "team", "anyone"]
    : ["private", "team"];

  /* One handler, two presentations — the decision is identical either way. */
  const pick = (position: NoteScope, on: boolean) => {
    if (on) return;
    if (position === "anyone") {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onSet(scope, position);
  };

  return (
    <View style={styles.audienceWrap}>
      {compact ? (
        /*
          A GROUPED LIST ON A PHONE, A SEGMENTED CONTROL EVERYWHERE ELSE.

          `Phone-Share.dc.html` draws the positions as 56pt rows in a card —
          icon, name, what it means, and a tick on the one in force — and the
          reason is not that it looks nicer. The segmented control divides the
          sheet's width by three: at 390pt that is a 110pt target 7pt tall
          carrying a label with nowhere for its `detail` to go, so the two
          lines under the control had to say who can read it for whichever
          position happened to be current. A row has room to say it per
          position, which is the difference between reading the answer and
          selecting an option to find out.

          The same three positions, the same `scopeLabels`, the same handler.
          Only the shape forks — `frame.ts`'s rule, that neither surface is the
          other one degraded.
        */
        <View style={styles.positions} role="radiogroup" testID="share-audience">
          {positions.map((position, index) => {
            const on = position === scope;
            return (
              <Pressable
                key={position}
                style={[styles.position, index > 0 && styles.positionRuled]}
                role="radio"
                aria-checked={on}
                accessibilityLabel={labels[position].label}
                testID={`share-audience-${position}`}
                onPress={() => pick(position, on)}
              >
                <Icon
                  name={POSITION_ICON[position]}
                  size={18}
                  color={on ? colors.text : colors.muted}
                />
                <View style={styles.positionMain}>
                  <Text style={on ? styles.positionName : styles.positionNameOff}>
                    {labels[position].label}
                  </Text>
                  <Text variant="meta" style={styles.positionDetail}>
                    {labels[position].detail}
                  </Text>
                </View>
                {on ? <Icon name="check" size={18} color={colors.accent} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View style={styles.audience} role="radiogroup" testID="share-audience">
          {positions.map((position) => {
            const on = position === scope;
            return (
              <Pressable
                key={position}
                style={[styles.segment, on && styles.segmentOn]}
                role="radio"
                aria-checked={on}
                accessibilityLabel={labels[position].label}
                testID={`share-audience-${position}`}
                onPress={() => pick(position, on)}
              >
                <Text variant="meta" style={on ? styles.segmentTextOn : styles.segmentText}>
                  {labels[position].label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {/*
        No detail line under the control.

        `scopeLabels(context)[scope].detail` says who can read it, and the two
        lines under the control say the same thing once and then say where the
        rule came from — which is the half a list cannot show and the
        difference between "this is fine" and "wait, that folder?". Two
        sentences making one point would read as two points; these make two.
        The labels keep their `detail` because the confirmation and future
        callers want the words; this position does not need them twice.
      */}

      {!confirming ? null : (
        <View style={styles.confirm} testID="share-confirm-public">
          <Text variant="meta">{describeGoingPublic(name)}</Text>
          <View style={styles.row}>
            <Button
              label="Create the link"
              variant="danger"
              testID="share-confirm-public-yes"
              onPress={() => {
                setConfirming(false);
                onSet(scope, "anyone");
              }}
            />
            <Button label="Cancel" onPress={() => setConfirming(false)} />
          </View>
        </View>
      )}
    </View>
  );
}
