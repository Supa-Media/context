import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Row } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import {
  useAppearanceChoice,
  useThemedStyles,
  type AppearanceChoice,
  type Colors,
} from "../../../design/theme";
import { settingsSectionLabel } from "../sections";

/**
 * "Appearance" — light, dark, or follow the device.
 *
 * There is no `Switch` or segmented-control primitive in this design system —
 * see `features/design/components/` — and this is its only caller, so the
 * three choices are three ordinary `Button`s rather than a new primitive
 * built for one screen. The current choice is marked twice, not once: a
 * leading checkmark (so it reads without colour) and an accent tint (so it
 * reads at a glance) on the same button, which is the same "mark it more than
 * one way" rule `Dot` + a status word already follow elsewhere in this app.
 *
 * The state itself — reading it back at launch, persisting a change, and
 * what a native cold start does before the device has answered — is
 * `useAppearanceChoice`'s, in `theme.tsx`, alongside a long comment on the
 * first-paint flash this panel's control has to avoid causing again the
 * moment somebody changes it.
 */
export function AppearancePanel() {
  const styles = useThemedStyles(makeStyles);
  const { choice, setChoice } = useAppearanceChoice();

  return (
    <View>
      <Text variant="paneTitle" style={styles.head}>
        {settingsSectionLabel("appearance")}
      </Text>
      <Text variant="paneSub" style={styles.sub}>
        Follow the device switches with your system's own light/dark setting;
        Light and Dark pin this app regardless of it.
      </Text>
      <Card>
        <Row style={styles.choices}>
          {CHOICES.map((entry) => (
            <ChoiceButton
              key={entry.value}
              entry={entry}
              active={choice === entry.value}
              onPress={() => setChoice(entry.value)}
            />
          ))}
        </Row>
      </Card>
    </View>
  );
}

const CHOICES: readonly { value: AppearanceChoice; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Follow device" },
];

function ChoiceButton({
  entry,
  active,
  onPress,
}: {
  entry: { value: AppearanceChoice; label: string };
  active: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Button
      label={entry.label}
      variant="mini"
      style={active ? styles.choiceActive : undefined}
      // A leading glyph rather than a colour alone: `active`'s accent tint is
      // the same hue text-hierarchy already uses for links, which is not a
      // safe distinguisher on its own for every reader.
      leading={active ? <Text style={styles.check}>{"✓ "}</Text> : undefined}
      accessibilityLabel={active ? `${entry.label}, current appearance` : entry.label}
      onPress={onPress}
      testID={`appearance-${entry.value}`}
    />
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { marginBottom: 4 },
    sub: { marginBottom: space.x3, maxWidth: 546 },
    // `flexWrap` rather than a fixed row: three chips and their gaps can
    // exceed a phone's width once "Follow device" is in the mix, and wrapping
    // is what keeps this a settings row rather than a horizontal scroller —
    // see the phone-width rule in the design skill this panel was reviewed
    // against. No `justifyContent: "center"` on this axis: that is the exact
    // shape of the bug that once centred every label in a touch list here.
    choices: { flexWrap: "wrap", gap: space.x2 },
    choiceActive: { backgroundColor: colors.accentDim, borderColor: colors.accent },
    check: { color: colors.accentText },
  });
