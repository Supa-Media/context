import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { Figure, T, useWide } from "./TexPageParts";
import type { TexPageState } from "./useTexPage";
import type { MachineAsk } from "./texMachineTypes";
import { askFacts } from "./texMachineFormat";
import { Button, ButtonRow } from "./TexMachineParts";

/**
 * The owner's approval card (design screen 5, `05-approval`): someone else's
 * job waiting for the owner's yes, drawn above the Tex home's strip. The stuck
 * figure shows on a desktop only; on a phone the warn border and "Needs you"
 * carry it (audit nit 20).
 */
export function MachineAskCard({ ask, page }: { ask: MachineAsk; page: TexPageState }) {
  const wide = useWide();
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false);

  const decide = async (mode: "once" | "always" | "decline") => {
    if (busy) return;
    setBusy(true);
    try {
      await page.act({ type: "job.allow", job: ask.job, mode });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card} testID={`tex-ask-${ask.job}`}>
      {wide ? <Figure mood="stuck" size={56} /> : null}
      <View style={styles.text}>
        <T size={11} weight="600" tone="warn" upper>
          Needs you
        </T>
        <T size={18} serif line={1.3}>
          {`${ask.who} wants to run “${ask.title}” on your ${ask.machineName}`}
        </T>
        <T size={13} tone="muted">
          {factsWithPath(ask)}
        </T>
        <ButtonRow>
          <Button
            label="Allow once"
            look="primary"
            grow={!wide}
            disabled={busy}
            onPress={() => void decide("once")}
            testID={`tex-ask-${ask.job}-once`}
          />
          <Button
            label={`Always allow ${ask.who}`}
            look="outline"
            grow={!wide}
            disabled={busy}
            onPress={() => void decide("always")}
            testID={`tex-ask-${ask.job}-always`}
          />
          <Button
            label="Decline"
            look="quiet"
            grow={!wide}
            disabled={busy}
            onPress={() => void decide("decline")}
            testID={`tex-ask-${ask.job}-decline`}
          />
        </ButtonRow>
        <T size={13} tone="muted">
          You can also text Tex “yes” or “no”.
        </T>
      </View>
    </View>
  );
}

/**
 * The facts line with the folder set in mono, as the artboard draws it:
 * `Claude Code in ~/code/context · uses 1 of the 2 slots · asked 2:31 PM`.
 * The path is cut out of `askFacts`'s own string, so the words stay the spec's.
 */
function factsWithPath(ask: MachineAsk) {
  const text = askFacts(ask);
  const folder = ask.folder;
  const at = folder ? text.indexOf(folder) : -1;
  if (!folder || at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <T size={12} mono tone="muted">
        {folder}
      </T>
      {text.slice(at + folder.length)}
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 14,
      padding: 16,
      marginBottom: 16,
      borderWidth: 1,
      borderColor: colors.warnBorder,
      borderRadius: 12,
      backgroundColor: colors.surface,
    },
    text: { flex: 1, minWidth: 0, gap: 8 },
  });
