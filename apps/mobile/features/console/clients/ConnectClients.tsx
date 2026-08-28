import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Text } from "../../design/components/Text";
import { colors, leading } from "../../design/tokens";
import { openProviderLink } from "./open";
import {
  CLIENT_PROVIDERS,
  connectedCountsByProvider,
  fieldsCaption,
  type ClientProvider,
} from "./providers";

/**
 * What happens after the URL is in — the same for every client on the list,
 * because the endpoint carries no token and authority is decided afterwards,
 * over OAuth. Kept inside the details panel rather than on every row: somebody
 * who has just pasted a URL with no key in it reasonably wonders what stops
 * anyone else pasting it, and that is a question they ask once.
 */
const AFTER_SENTENCE =
  "Once it is added, the client sends you back here to sign in and you choose what it may see. It then appears under Connected clients below, and you can revoke it on its own.";

/**
 * "Connect a client" — one line per AI tool, collapsed.
 *
 * The endpoint alone was never enough: it is the same URL for everyone, so
 * nobody has to *find* it — what they have to find is the settings screen in
 * their client that takes it, and every client hides that somewhere different.
 * This is the missing half.
 *
 * ## Why it is one line and not three
 *
 * It was a name, a full sentence of caveat, and two buttons, times nine — a
 * screen you scroll rather than scan, on a card whose entire job is "find your
 * client and press the button". The caveats are all still here, one press away
 * under Details, which is where somebody who has hit the caveat goes looking.
 * What survives on the row is the only thing that answers the question the
 * person actually arrived with: which of these am I already connected to, and
 * where do I press for the one I am not.
 *
 * ## The name is the mark
 *
 * There is no logo column. Nine third-party marks would be nine assets to ship,
 * keep current and hold a licence for — and the fallback, a monogram, is worse
 * than nothing here: five of the nine clients begin with C, so the tile
 * distinguishes nothing while taking the position the eye lands on first.
 *
 * ## Connected is a heuristic, and it degrades in the right direction
 *
 * A tick comes from matching a grant's registered name against the row (see
 * `providerIdForClientName`). The name belongs to the client, not to us, so a
 * miss is possible — and a miss leaves the row looking unconnected while the
 * grant still appears, in full, under Connected clients below. The opposite
 * failure is the one that would matter: a row that claims a connection nobody
 * made is a person concluding their tool is set up when it is not.
 *
 * ## Hooks are a second, separate panel
 *
 * Connecting a client lets an agent *choose* to save what it learned. A hook
 * saves the session whether it chose to or not, which is a different promise
 * and a different install — so it is its own button, on the rows that have one,
 * and absent on the rows that do not rather than present and inert.
 *
 * ## Connecting a second account is the same button
 *
 * People have a work ChatGPT and a personal one, two Claude accounts, a client
 * on two machines. Each connection is its own grant, revocable on its own, so
 * there is nothing to disable once one exists — the button just says what
 * pressing it does now, and the count says how many there already are.
 */
type Panel = { id: string; section: "details" | "hook" } | null;

export function ConnectClients({
  endpoint,
  clients = [],
}: {
  endpoint: string;
  clients?: readonly { name: string }[];
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const counts = connectedCountsByProvider(clients);

  return (
    <Card>
      <Text variant="eyebrow" style={styles.eyebrow}>
        Connect a client
      </Text>

      {CLIENT_PROVIDERS.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          endpoint={endpoint}
          connected={counts[provider.id] || 0}
          panel={panel?.id === provider.id ? panel.section : null}
          onToggle={(section) =>
            setPanel(
              panel?.id === provider.id && panel.section === section
                ? null
                : { id: provider.id, section },
            )
          }
        />
      ))}
    </Card>
  );
}

function ProviderRow({
  provider,
  endpoint,
  connected,
  panel,
  onToggle,
}: {
  provider: ClientProvider;
  endpoint: string;
  connected: number;
  panel: "details" | "hook" | null;
  onToggle: (section: "details" | "hook") => void;
}) {
  const link = provider.link(endpoint);
  const fields = provider.fields(endpoint);
  // The label carries the state, so the button reads as what pressing it does
  // rather than as an offer to do something already done.
  const actionLabel = connected ? "Connect another" : link.label;

  return (
    <View testID={`provider-${provider.id}`}>
      <Row divided style={styles.head}>
        <Grow style={styles.grow}>
          <Text variant="rowTitle">{provider.name}</Text>
        </Grow>

        {connected ? (
          <Text
            variant="mini"
            style={styles.connected}
            testID={`provider-${provider.id}-connected`}
          >
            {connected > 1 ? `✓ ${connected} connected` : "✓ Connected"}
          </Text>
        ) : null}

        <View style={styles.actions}>
          {provider.hook ? (
            <Button
              label={panel === "hook" ? "Hide" : "Hooks"}
              accessibilityLabel={
                panel === "hook"
                  ? `Hide how to save ${provider.name} sessions automatically`
                  : `Show how to save ${provider.name} sessions automatically`
              }
              onPress={() => onToggle("hook")}
              testID={`provider-${provider.id}-hook-toggle`}
            />
          ) : null}
          <Button
            label={panel === "details" ? "Hide" : "Details"}
            accessibilityLabel={
              panel === "details"
                ? `Hide how to connect ${provider.name}`
                : `Show how to connect ${provider.name}`
            }
            onPress={() => onToggle("details")}
            testID={`provider-${provider.id}-toggle`}
          />
          <Button
            label={actionLabel}
            accessibilityLabel={
              connected
                ? `Connect another ${provider.name} — opens ${provider.name}`
                : `${link.label} — opens ${provider.name}`
            }
            onPress={() => openProviderLink(link.href)}
            testID={`provider-${provider.id}-open`}
            trailing={
              <Text variant="mini" style={styles.arrow} aria-hidden>
                ↗
              </Text>
            }
          />
        </View>
      </Row>

      {panel === "hook" && provider.hook ? (
        <View style={styles.details} testID={`provider-${provider.id}-hook`}>
          <Text variant="rowSub" style={styles.note}>
            {provider.hook.note}
          </Text>
          <Text variant="foot" style={styles.caption}>
            Run this in your terminal.
          </Text>
          <View style={styles.field}>
            <Text variant="eyebrow">Install the hook</Text>
            <CopyField
              value={provider.hook.command(endpoint)}
              label={`Copy the hook install command for ${provider.name}`}
              testID={`provider-${provider.id}-hook-command`}
            />
          </View>
        </View>
      ) : null}

      {panel === "details" ? (
        <View style={styles.details} testID={`provider-${provider.id}-details`}>
          {/*
            The caveat that used to sit on the row. It is the only place a plan
            requirement or an admin switch is written, so it leads the panel
            rather than trailing the fields somebody has already pasted.
          */}
          <Text variant="rowSub" style={styles.note}>
            {provider.note}
          </Text>

          <Text variant="foot" style={styles.caption}>
            {fieldsCaption(provider, link.kind)}
          </Text>

          {fields.map((field) => (
            <View key={field.id} style={styles.field}>
              <Text variant="eyebrow">
                {field.label}
                {field.optional ? (
                  <Text variant="eyebrow" style={styles.optional}>
                    {"  optional"}
                  </Text>
                ) : null}
              </Text>
              <CopyField
                value={field.value}
                label={`Copy the ${field.label.toLowerCase()} for ${provider.name}`}
                testID={`provider-${provider.id}-${field.id}`}
              />
            </View>
          ))}

          <Text variant="foot" style={styles.after}>
            {AFTER_SENTENCE}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  eyebrow: { marginBottom: 2 },
  /*
   * The buttons drop under the name on a narrow screen rather than crushing
   * it. With the caveat gone the row is short, so the floor can be far lower
   * than it was — a name and a tick need nothing like 230px.
   */
  head: { flexWrap: "wrap", alignItems: "center", gap: 10 },
  grow: { minWidth: 96 },
  connected: { color: colors.text2 },
  actions: { flexDirection: "row", alignItems: "center", gap: 9 },
  note: { lineHeight: leading(12.5, 1.55) },
  arrow: { color: colors.text2 },
  details: { paddingBottom: 14, paddingTop: 2, gap: 11 },
  caption: { color: colors.text2 },
  field: { gap: 6 },
  optional: { color: colors.muted },
  after: { lineHeight: leading(12.5, 1.55) },
});
