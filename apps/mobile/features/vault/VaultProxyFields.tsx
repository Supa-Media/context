import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { TextField } from "../design/components/Input";
import { Switch } from "../design/components/Switch";
import { Text } from "../design/components/Text";
import { TextLink } from "../design/components/TextLink";
import { useThemedStyles, type Colors } from "../design/theme";
import { Segmented } from "./Segmented";
import { chosenStyle, pickStyle, styleWords, typedHost, type ProxyFormState, type ProxyStyle } from "./vaultProxy";

/**
 * The save page's "Let my AIs use it, never shown the key" part (vault board
 * 1): one switch, and when it is on, the one website, how that site wants the
 * key (found for you, changed under Advanced), and the first-use ask, on by
 * default.
 */
export function VaultProxyFields({
  state,
  onChange,
  entryName,
  busy,
}: {
  state: ProxyFormState;
  onChange: (next: ProxyFormState) => void;
  /** The entry's name as typed, so the words can say "Stripe" rather than "the site". */
  entryName: string;
  busy: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const [advanced, setAdvanced] = useState(false);
  const set = (patch: Partial<ProxyFormState>) => onChange({ ...state, ...patch });
  const chosen = chosenStyle(state);
  const site = entryName.trim() || "the site";
  const host = typedHost(state.host);

  return (
    <View style={styles.box} testID="vault-proxy">
      <View style={styles.row}>
        <Text variant="rowTitle" style={styles.grow}>
          Let my AIs use it, never shown the key
        </Text>
        <Switch
          label="Let my AIs use it, never shown the key"
          value={state.on}
          onValueChange={(on) => set({ on })}
          disabled={busy}
          testID="vault-proxy-on"
        />
      </View>
      {state.on ? (
        <>
          <TextField
            label="Only ever sent to"
            hint={`Context never adds it for any other website. Use the narrowest key ${site} offers: an AI can do whatever the key allows there.`}
            value={state.host}
            onChangeText={(text) => set({ host: text })}
            placeholder="e.g. api.stripe.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
            editable={!busy}
            testID="vault-proxy-host"
          />
          <View style={styles.row}>
            <Text variant="rowSub" style={styles.grow} testID="vault-proxy-style">
              How {site} wants it: <Text variant="rowSub" style={styles.strong}>{styleWords(chosen.style, chosen.name)}</Text>
              {chosen.guessed && host ? ", found for you" : ""}
            </Text>
            <TextLink
              label={advanced ? "Done" : "Advanced"}
              onPress={() => setAdvanced(!advanced)}
              disabled={busy}
              testID="vault-proxy-advanced"
            />
          </View>
          {advanced ? (
            <>
              <Segmented<ProxyStyle>
                label="How the site wants the key"
                options={[
                  { value: "bearer", label: "Sign-in header" },
                  { value: "header", label: "Named header" },
                  { value: "query", label: "In the address" },
                ]}
                value={chosen.style}
                onChange={(style) => onChange(pickStyle(state, style))}
                disabled={busy}
                testID="vault-proxy-kind"
              />
              {chosen.style === "header" ? (
                <TextField
                  label="Header name"
                  value={state.headerName}
                  onChangeText={(text) => set({ headerName: text })}
                  placeholder="e.g. x-api-key"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  testID="vault-proxy-header"
                />
              ) : chosen.style === "query" ? (
                <TextField
                  label="Address part"
                  value={state.paramName}
                  onChangeText={(text) => set({ paramName: text })}
                  placeholder="e.g. api_key"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  testID="vault-proxy-param"
                />
              ) : null}
            </>
          ) : null}
          <View style={styles.row}>
            <View style={styles.grow}>
              <Text variant="rowTitle">Ask me the first time each AI uses it</Text>
              <Text variant="rowSub">Your phone asks once per AI. Off: every AI you connected can use it without asking.</Text>
            </View>
            <Switch
              label="Ask me the first time each AI uses it"
              value={state.ask}
              onValueChange={(ask) => set({ ask })}
              disabled={busy}
              testID="vault-proxy-ask"
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: { gap: 14, paddingTop: 4 },
    row: { flexDirection: "row", alignItems: "center", gap: 12 },
    grow: { flex: 1, gap: 2 },
    strong: { color: colors.ink, fontWeight: "700" },
  });
