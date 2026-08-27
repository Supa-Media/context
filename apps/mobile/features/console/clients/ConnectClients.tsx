import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Text } from "../../design/components/Text";
import { colors, leading } from "../../design/tokens";
import { openProviderLink } from "./open";
import { CLIENT_PROVIDERS, fieldsCaption, type ClientProvider } from "./providers";

/**
 * What happens after the URL is in — the same for every client on the list,
 * because the endpoint carries no token and authority is decided afterwards,
 * over OAuth. Worth repeating on each row: somebody who has just pasted a URL
 * with no key in it reasonably wonders what is stopping anyone else pasting it.
 */
const AFTER_SENTENCE =
  "Once it is added, the client sends you back here to sign in and you choose what it may see. It then appears under Connected clients below, and you can revoke it on its own.";

/**
 * "Connect a client" — one row per AI tool, with the link that gets you to the
 * right screen and the strings that screen will ask for.
 *
 * The endpoint alone was the whole of this pane, and it was not enough: it is
 * the same URL for everyone, so nobody has to *find* it — what they have to
 * find is the settings screen in their client that takes it, and every client
 * hides that somewhere different. So this sits above the endpoint card, and the
 * endpoint card stays, because a person who already knows where they are going
 * should not have to open an accordion to get the URL.
 *
 * ## Only one row is open at a time
 *
 * Eight rows of three copy fields each is a wall. The rows collapse to a name,
 * a caveat and a button; the fields appear for the one you asked about. The
 * toggle's accessible name carries the state — "Show what to paste into Cursor"
 * / "Hide …" — rather than leaving a screen reader with a "Details" whose
 * effect it cannot report.
 */
export function ConnectClients({ endpoint }: { endpoint: string }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <Card>
      <Text variant="eyebrow" style={styles.eyebrow}>
        Connect a client
      </Text>
      <Text variant="rowSub" style={styles.lede}>
        Every client asks for the same thing in a different place. Pick yours — the button
        goes straight to the screen that takes it.
      </Text>

      {CLIENT_PROVIDERS.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          endpoint={endpoint}
          open={openId === provider.id}
          onToggle={() => setOpenId(openId === provider.id ? null : provider.id)}
        />
      ))}
    </Card>
  );
}

function ProviderRow({
  provider,
  endpoint,
  open,
  onToggle,
}: {
  provider: ClientProvider;
  endpoint: string;
  open: boolean;
  onToggle: () => void;
}) {
  const link = provider.link(endpoint);
  const fields = provider.fields(endpoint);

  return (
    <View testID={`provider-${provider.id}`}>
      <Row divided style={styles.head}>
        <Grow style={styles.grow}>
          <Text variant="rowTitle">{provider.name}</Text>
          <Text variant="rowSub" style={styles.note}>
            {provider.note}
          </Text>
        </Grow>

        <View style={styles.actions}>
          <Button
            label={open ? "Hide" : "Details"}
            accessibilityLabel={
              open
                ? `Hide what to paste into ${provider.name}`
                : `Show what to paste into ${provider.name}`
            }
            onPress={onToggle}
            testID={`provider-${provider.id}-toggle`}
          />
          <Button
            label={link.label}
            accessibilityLabel={`${link.label} — opens ${provider.name}`}
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

      {open ? (
        <View style={styles.details} testID={`provider-${provider.id}-details`}>
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
  eyebrow: { marginBottom: 10 },
  /*
   * The two buttons drop under the name rather than crushing it. `Grow`'s own
   * `minWidth: 0` would let it shrink to nothing instead of wrapping, so the
   * floor is set here — the note is the row's whole reason for existing and a
   * two-character-wide column of it is worse than a second line.
   */
  head: { flexWrap: "wrap" },
  grow: { minWidth: 230 },
  actions: { flexDirection: "row", alignItems: "center", gap: 9 },
  lede: { marginBottom: 4, lineHeight: leading(12.5, 1.6) },
  note: { marginTop: 2, lineHeight: leading(12.5, 1.55) },
  arrow: { color: colors.text2 },
  details: { paddingBottom: 14, paddingTop: 2, gap: 11 },
  caption: { color: colors.text2 },
  field: { gap: 6 },
  optional: { color: colors.muted },
  after: { lineHeight: leading(12.5, 1.55) },
});
