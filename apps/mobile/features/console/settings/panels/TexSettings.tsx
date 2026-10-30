import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";

import { Card, Grow, Row } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles } from "../../../design/theme";
import { settingsSectionLabel } from "../sections";
import { PickMenu, type PickOption } from "./PickMenu";

/**
 * Settings › Tex (Dev2, 2026-10-28; docs/decisions/texting-assistant/tex-settings.md):
 * how Tex talks to this person in their own chat. The same settings "Tex,
 * settings" changes by text; a group chat keeps its own and is changed there.
 * A pick shows at once and saves behind it; only changed settings are kept.
 */
export type TexStyle = {
  tone?: string;
  warmth?: string;
  enthusiasm?: string;
  emoji?: string;
  length?: string;
  bubbles?: string;
  humor?: number;
};

const LEVELS: readonly PickOption<string>[] = [
  { key: "more", label: "More" },
  { key: "default", label: "Default" },
  { key: "less", label: "Less" },
];

/** Each row: the setting, its choices, and its default. */
export const TEX_SETTINGS: readonly { key: Exclude<keyof TexStyle, "humor">; label: string; options: readonly PickOption<string>[]; fallback: string }[] = [
  {
    key: "tone",
    label: "Tone",
    options: ["default", "professional", "friendly", "candid", "quirky", "efficient", "nerdy", "cynical"].map((key) => ({
      key,
      label: key.charAt(0).toUpperCase() + key.slice(1),
    })),
    fallback: "default",
  },
  { key: "warmth", label: "Warmth", options: LEVELS, fallback: "default" },
  { key: "enthusiasm", label: "Enthusiasm", options: LEVELS, fallback: "default" },
  { key: "emoji", label: "Emoji", options: LEVELS, fallback: "default" },
  {
    key: "length",
    label: "Length",
    options: [
      { key: "short", label: "Short" },
      { key: "default", label: "Default" },
      { key: "detailed", label: "Detailed" },
    ],
    fallback: "default",
  },
  {
    key: "bubbles",
    label: "Bubbles",
    options: [
      { key: "multiple", label: "Several per answer" },
      { key: "one", label: "One per answer" },
    ],
    fallback: "multiple",
  },
];

/** TARS's dial: 0 to 100 in tens, 75 until changed. */
export const DEFAULT_HUMOR = 75;
const HUMOR: readonly PickOption<string>[] = Array.from({ length: 11 }, (_, index) => ({ key: String(index * 10), label: `${index * 10}%` }));

/** `style` with `key` set; a setting put back to its default is dropped, as the account keeps it. */
export function withSetting(style: TexStyle, key: keyof TexStyle, value: string | number): TexStyle {
  const next: TexStyle = { ...style, [key]: value };
  const fallback = key === "humor" ? DEFAULT_HUMOR : TEX_SETTINGS.find((row) => row.key === key)?.fallback;
  if (value === fallback) delete next[key];
  return next;
}

export function TexSettings() {
  const styles = useThemedStyles(makeStyles);
  const live = useConvex() !== undefined;
  return (
    <View>
      <Text variant="paneTitle" role="heading" aria-level={2} style={styles.head}>
        {settingsSectionLabel("tex")}
      </Text>
      {/* Nothing to read or save without a client: the demo and the render tests. */}
      {live ? <TexSettingsLive /> : null}
    </View>
  );
}

function TexSettingsLive() {
  const saved = useQuery(api.functions.texStyle.myTexStyle, {});
  const save = useMutation(api.functions.texStyle.setMyTexStyle);
  const [style, setStyle] = useState<TexStyle>({});
  const [problem, setProblem] = useState(false);

  useEffect(() => {
    if (saved) setStyle(saved);
  }, [saved]);

  function pick(key: keyof TexStyle, value: string | number) {
    const next = withSetting(style, key, value);
    setStyle(next);
    setProblem(false);
    save({ texStyle: next as Parameters<typeof save>[0]["texStyle"] }).catch(() => setProblem(true));
  }

  return <TexSettingsView style={style} problem={problem} onPick={pick} />;
}

/** What the page draws, with no client behind it. */
export function TexSettingsView({
  style,
  problem,
  onPick,
}: {
  style: TexStyle;
  problem: boolean;
  onPick: (key: keyof TexStyle, value: string | number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const humor = String(style.humor ?? DEFAULT_HUMOR);
  return (
    <View>
      <Card>
        {TEX_SETTINGS.map((row, index) => {
          const value = style[row.key] ?? row.fallback;
          return (
            <Row key={row.key} divided={index > 0}>
              <Grow>
                <Text variant="rowTitle">{row.label}</Text>
              </Grow>
              <PickMenu
                label={row.options.find((option) => option.key === value)?.label ?? value}
                options={row.options}
                selected={value}
                onPick={(key) => onPick(row.key, key)}
                accessibilityLabel={`Tex's ${row.label.toLowerCase()}`}
                testID={`tex-${row.key}`}
              />
            </Row>
          );
        })}
        <Row divided>
          <Grow>
            <Text variant="rowTitle">Humor</Text>
          </Grow>
          <PickMenu
            label={`${humor}%`}
            options={HUMOR}
            selected={humor}
            onPick={(key) => onPick("humor", Number(key))}
            accessibilityLabel="Tex's humor, in tens of percent"
            testID="tex-humor"
          />
        </Row>
      </Card>
      {problem ? (
        <Text variant="hint" style={styles.problem} testID="tex-unsaved">
          Not saved. Try again.
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    head: { marginBottom: space.x3 },
    problem: { marginTop: space.x2 },
  });
