/**
 * The how-to-reach fields of a seat pop-up: a person's phone, email and
 * delegation agent, or an agent's access note and vault item name. It only
 * draws and reports changes; the parent holds the card and saves it. No
 * login is typed here: an agent's vault field names the item, nothing more.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { TextField } from "../../../../design/components/Input";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";
import type { Card } from "./seat";

/** One answer of a few (`radio`) or one toggle of a set (`checkbox`), drawn as a chip. */
export function Chip({
  label,
  on,
  onPress,
  role = "radio",
  disabled = false,
  hint,
  testID,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  role?: "radio" | "checkbox";
  disabled?: boolean;
  /** One line on what the chip means: the accessible hint, and the web hover `title`. */
  hint?: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      role={role}
      aria-checked={on}
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      {...webTitle(hint)}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={[styles.chip, on && styles.chipOn, disabled && styles.faded]}
    >
      <Text variant="mini" style={on ? styles.chipTextOn : undefined}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A web `title` (the native hover text) when there is a hint; nothing otherwise. */
function webTitle(hint: string | undefined): object {
  return hint === undefined ? {} : { title: hint };
}

/** Whether a delegation value names another bot rather than Tex or nobody. */
function isBot(delegation: string): boolean {
  const said = delegation.trim();
  return said !== "" && said.toLowerCase() !== "tex";
}

export interface ReachFieldsProps {
  card: Card;
  /** An agent's card fields, or a person's. */
  kind: Card["kind"];
  /** The holder as drawn, for the hint: "on every seat <name> holds". */
  holderName: string;
  /** Prefix of the test IDs: `seat` gives `seat-phone`. */
  idPrefix: string;
  canEdit: boolean;
  onChange: (patch: Partial<Card>) => void;
}

export function ReachFields({ card, kind, holderName, idPrefix, canEdit, onChange }: ReachFieldsProps) {
  const styles = useThemedStyles(makeStyles);
  // Which delegation chip is on: Tex is the stored word, another bot a typed name.
  // Held here so "Another bot" can be chosen before any name is typed.
  const [bot, setBot] = useState(() => isBot(card.delegation));
  const tex = !bot && card.delegation.trim().toLowerCase() === "tex";
  const id = (name: string) => `${idPrefix}-${name}`;

  if (kind === "agent") {
    return (
      <View style={styles.block}>
        <TextField
          label="Where and how to reach it"
          value={card.access}
          onChangeText={(access) => onChange({ access })}
          multiline
          style={styles.multi}
          editable={canEdit}
          testID={id("access")}
        />
        <TextField
          label="Vault item with the login"
          hint="The login stays in the vault; this only names the item."
          value={card.vault}
          onChangeText={(vault) => onChange({ vault })}
          editable={canEdit}
          testID={id("vault")}
        />
      </View>
    );
  }

  return (
    <View style={styles.block}>
      <TextField
        label="Phone"
        value={card.phone}
        onChangeText={(phone) => onChange({ phone })}
        keyboardType="phone-pad"
        editable={canEdit}
        testID={id("phone")}
      />
      <TextField
        label="Email"
        value={card.email}
        onChangeText={(email) => onChange({ email })}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        editable={canEdit}
        testID={id("email")}
      />
      <View style={styles.block}>
        <Text variant="eyebrow">Delegation agent</Text>
        <View style={styles.chips} role="radiogroup" aria-label="Delegation agent">
          <Chip
            label="None"
            on={!bot && !tex}
            disabled={!canEdit}
            onPress={() => {
              setBot(false);
              onChange({ delegation: "" });
            }}
          />
          <Chip
            label="Tex"
            on={tex}
            disabled={!canEdit}
            onPress={() => {
              setBot(false);
              onChange({ delegation: "Tex" });
            }}
          />
          <Chip
            label="Another bot"
            on={bot}
            disabled={!canEdit}
            onPress={() => {
              if (bot) return;
              setBot(true);
              onChange({ delegation: "" });
            }}
          />
        </View>
      </View>
      {bot ? (
        <>
          <TextField
            label="Bot name"
            value={card.delegation}
            onChangeText={(delegation) => onChange({ delegation })}
            autoCorrect={false}
            editable={canEdit}
            testID={id("delegation")}
          />
          <TextField
            label="How to reach it"
            value={card.delegationHow}
            onChangeText={(delegationHow) => onChange({ delegationHow })}
            multiline
            style={styles.multi}
            editable={canEdit}
            testID={id("delegation-how")}
          />
        </>
      ) : null}
      <Text variant="hint">Everyone in this workspace sees this card, on every seat {holderName} holds.</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    block: { gap: space.x2 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    chip: {
      alignSelf: "flex-start",
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface3,
    },
    chipOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
    chipTextOn: { color: colors.accentText },
    faded: { opacity: 0.45 },
    multi: { minHeight: 72, textAlignVertical: "top" },
  });
