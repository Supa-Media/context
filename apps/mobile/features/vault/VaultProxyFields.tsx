import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { TextField } from "../design/components/Input";
import { Switch } from "../design/components/Switch";
import { Text } from "../design/components/Text";
import { TextLink } from "../design/components/TextLink";
import { useThemedStyles, type Colors } from "../design/theme";
import { radii } from "../design/tokens";
import { Segmented } from "./Segmented";
import { SuggestionList } from "./SuggestionList";
import { apiForName, suggestApiHosts, type ApiSuggestion } from "./apiHostSuggest";
import {
  chosenStyle,
  hostProblem,
  isSharedHost,
  pickStyle,
  styleWords,
  typedHost,
  type ProxyFormState,
  type ProxyStyle,
} from "./vaultProxy";

/**
 * The save page's "Let my AIs use it, never shown the key" part (vault board
 * 1): one switch, and when it is on, the one website, how that site wants the
 * key (found for you, changed under Advanced), and the first-use ask, on by
 * default.
 *
 * The website field suggests API addresses as the person types (a name like
 * "stripe" or the start of an address), and before anything is typed offers
 * the one the key's name or "Fills on" site points at. A website the server
 * would refuse is said under the field as it is typed, not after Save.
 */
export function VaultProxyFields({
  state,
  onChange,
  entryName,
  entrySite = "",
  busy,
}: {
  state: ProxyFormState;
  onChange: (next: ProxyFormState) => void;
  /** The entry's name as typed, so the words can say "Stripe" rather than "the site". */
  entryName: string;
  /** The "Fills on" site, which can point at the API too (dashboard.stripe.com). */
  entrySite?: string;
  busy: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const [advanced, setAdvanced] = useState(false);
  const set = (patch: Partial<ProxyFormState>) => onChange({ ...state, ...patch });
  const chosen = chosenStyle(state);
  const site = entryName.trim() || "the site";
  const host = typedHost(state.host);
  const suggestions = state.host.trim() ? suggestApiHosts(state.host) : [];
  const fromName = state.host.trim() ? null : apiForName(entryName, entrySite);
  const problem = hostProblem(state.host);
  // Mid-search ("stripe") is not yet an address; only say so once nothing matches.
  const shownProblem = problem !== null && (suggestions.length === 0 || isSharedHost(host)) ? problem : undefined;
  const pick = (api: ApiSuggestion) => set({ host: api.host });

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
            error={shownProblem}
            value={state.host}
            onChangeText={(text) => set({ host: text })}
            placeholder="Type a name like Stripe, or api.stripe.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
            editable={!busy}
            testID="vault-proxy-host"
          />
          {fromName !== null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Use ${fromName.host}, ${fromName.name}`}
              onPress={() => pick(fromName)}
              disabled={busy}
              style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
              testID="vault-proxy-from-name"
            >
              <Text variant="rowSub">
                Use <Text variant="rowSub" style={styles.strong}>{fromName.host}</Text> ({fromName.name})
              </Text>
            </Pressable>
          ) : null}
          {suggestions.length > 0 ? (
            <SuggestionList
              items={suggestions.map((api) => ({ value: api.host, name: api.name }))}
              onPick={(value) => set({ host: value })}
              disabled={busy}
              testID="vault-proxy-suggestions"
            />
          ) : host && problem === null && host !== state.host.trim().toLowerCase() ? (
            <Text variant="rowSub" testID="vault-proxy-saved-as">
              Saved as <Text variant="rowSub" style={styles.strong}>{host}</Text>, the whole site.
            </Text>
          ) : null}
          <View style={styles.row}>
            <Text variant="rowSub" style={styles.grow} testID="vault-proxy-style">
              How {site} wants it: <Text variant="rowSub" style={styles.strong}>{styleWords(chosen.style, chosen.name, chosen.prefix)}</Text>
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
              ) : null}
              {chosen.style === "header" ? (
                <TextField
                  label="Before the key"
                  optional
                  hint="One word the site wants ahead of the key, like Convex in “Authorization: Convex <key>”."
                  value={state.headerPrefix}
                  onChangeText={(text) => set({ headerPrefix: text })}
                  placeholder="e.g. Convex"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  testID="vault-proxy-prefix"
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
    strong: { color: colors.text, fontWeight: "700" },
    chip: {
      alignSelf: "flex-start",
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderRadius: radii.pill,
      backgroundColor: colors.chipFill,
      marginTop: -6,
    },
    pressed: { backgroundColor: colors.rowSelected },
  });
