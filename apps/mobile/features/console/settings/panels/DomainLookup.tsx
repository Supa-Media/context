import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { ChoiceGroup, TextField } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { domainShapeProblem } from "../../domain/domain";
import { addressChoices, lookupLines, replacesSite, type DomainLookup } from "../../domain/domainHelp";
import type { DomainActions } from "../../domain/useDomain";

type Found = Extract<DomainLookup, { ok: true }>;

/** How long typing has to pause before we ask public DNS. */
const PAUSE_MS = 600;

/**
 * Look the typed domain up once typing pauses. The answer for an older
 * spelling never replaces a newer one, and a failed lookup is simply no
 * help: Connect works the way it always did.
 */
export function useDomainLookup(actions: DomainActions, cleaned: string): Found | null {
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    setFound(null);
    if (cleaned === "" || domainShapeProblem(cleaned) !== null) return;
    let current = true;
    const timer = setTimeout(() => {
      actions
        .lookup(cleaned)
        .then((result) => {
          if (current && result.ok) setFound(result);
        })
        .catch(() => undefined);
    }, PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [actions, cleaned]);
  return found;
}

/** The address that Connect would claim, from the choice and the "part" box. */
export function chosenHostname(found: Found | null, cleaned: string, choice: string | null, part: string): string {
  if (found === null || choice === null) return cleaned;
  if (choice !== "") return choice;
  const label = part.trim().toLowerCase().replace(/\.+$/, "");
  return label === "" ? "" : `${label}.${found.zone}`;
}

/**
 * Under the field: where the settings are, what is there now, that mail is
 * safe, and for a root domain which address to connect. The red line is the
 * one-way door: connecting over a website that is there now replaces it.
 */
export function LookupResult({
  found,
  choice,
  onChoose,
  part,
  onPart,
  chosen,
}: {
  found: Found;
  choice: string | null;
  onChoose: (value: string) => void;
  part: string;
  onPart: (value: string) => void;
  chosen: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const choices = addressChoices(found);
  const warning = chosen === "" ? null : replacesSite(found, chosen);
  return (
    <View testID="domain-lookup">
      {lookupLines(found, chosen).map((line) => (
        <Text key={line} variant="rowSub" style={styles.line}>
          {line}
        </Text>
      ))}
      {choices.length > 1 ? (
        <ChoiceGroup
          label="Which address should people type?"
          options={choices.map((option) => ({
            value: option.value,
            label: option.recommended ? `${option.label} · Works best here` : option.label,
            detail: option.detail,
          }))}
          value={choice}
          onChange={onChoose}
          style={styles.choices}
          testID="domain-address"
        />
      ) : null}
      {choice === "" ? (
        <TextField
          label={`The part before .${found.zone}`}
          placeholder="blog"
          value={part}
          onChangeText={onPart}
          autoCapitalize="none"
          autoCorrect={false}
          containerStyle={styles.part}
          testID="domain-part"
        />
      ) : null}
      {warning !== null ? (
        <Text variant="rowSub" style={styles.warning} testID="domain-replaces">
          {warning}
        </Text>
      ) : null}
    </View>
  );
}

/** The choice a lookup starts on: the recommended address. */
export function initialChoice(found: Found): string {
  return addressChoices(found).find((option) => option.recommended)?.value ?? found.hostname;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    line: { marginTop: 6 },
    choices: { marginTop: 18 },
    part: { marginTop: 12 },
    warning: { marginTop: 12, color: colors.critText, fontWeight: "700" },
  });
