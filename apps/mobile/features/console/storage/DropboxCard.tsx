import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { FormError, TextField } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { colors, leading } from "../../design/tokens";
import { validateRootPrefix } from "./connect";
import { DROPBOX_REDIRECT_ORIGINS, type DropboxStartState } from "./dropbox";

/**
 * Connect Dropbox — the one-click tier.
 *
 * ## Why there is no folder picker
 *
 * The Dropbox app is a **Scoped App with App Folder access**, so consenting
 * gives Context a folder of its own and nothing else: the Dropbox consent
 * screen says "its own folder", not "all your Dropbox". There is therefore no
 * folder to choose in the ordinary case, and asking anyway would be asking a
 * question we already know the answer to — the same restraint the bucket
 * form's addressing question follows.
 *
 * The one case where it is a real question is a **second** context on the same
 * Dropbox account, since both would otherwise land in the same app folder. So
 * there is a disclosure for exactly that, and what it reveals is an empty
 * field somebody types into. It is never pre-filled from a workspace id or a
 * slug: `CLAUDE.md` forbids us namespacing inside somebody's storage and
 * permits only a root prefix **the customer chose**, and a value we derived
 * and put in the box is not a value they chose — it just looks like one.
 *
 * ## Why the button can be absent
 *
 * Dropbox matches `redirect_uri` exactly, and only two are registered. On a
 * native build (no browser origin) or a web origin Dropbox has never heard of,
 * `redirectUri` is `null` and this card says where the flow does work instead
 * of starting one that ends on Dropbox's own error page. The bucket form below
 * is unaffected and is the path that works everywhere.
 */
export function DropboxCard({
  /** `null` where this browser's origin is not one Dropbox will redirect to. */
  redirectUri,
  state,
  start,
  note,
}: {
  redirectUri: string | null;
  state: DropboxStartState;
  /** `folder` is omitted entirely when the disclosure was never opened. */
  start: (folder?: string) => void;
  /**
   * One line about what pressing the button does to *this* screen, for callers
   * where that is not obvious. Rendered only where the button is: a warning
   * about leaving the page is noise beside a card explaining the button is not
   * here.
   */
  note?: string;
}) {
  const [askFolder, setAskFolder] = useState(false);
  const [folder, setFolder] = useState("");
  const [touched, setTouched] = useState(false);

  const folderError = askFolder ? validateRootPrefix(folder, "app folder") : undefined;
  const busy = state.kind === "starting";

  return (
    <Card>
      <Text variant="rowTitle">Connect Dropbox</Text>
      <Text variant="rowSub" style={styles.lede}>
        One click, and there is nothing to create first. Context gets{" "}
        <Text variant="rowSub" style={styles.emphasis}>
          its own folder
        </Text>{" "}
        inside your Dropbox — the consent screen says so, and the rest of your account
        stays invisible to us. Notes land in it as plain Markdown, and the Dropbox app on
        your machine syncs them down like any other folder.
      </Text>
      <Text variant="rowSub" style={styles.lede}>
        Already keep an Obsidian vault? Move it into that folder and the files are
        byte-identical — Context reads what is there rather than converting it.
      </Text>

      {redirectUri === null ? (
        <Text variant="foot" role="status" style={styles.unavailable} testID="dropbox-unavailable">
          Connecting Dropbox happens in a browser, and Dropbox only accepts the addresses
          this app is registered at — {DROPBOX_REDIRECT_ORIGINS.join(" and ")}. Open one of
          those and the button is here. Connecting a bucket works from anywhere, including
          this screen.
        </Text>
      ) : (
        <>
          {note === undefined ? null : (
            <Text variant="foot" style={styles.note} testID="dropbox-note">
              {note}
            </Text>
          )}

          {askFolder ? (
            <View style={styles.folder}>
              <TextField
                label="Folder inside the app folder"
                optional
                value={folder}
                onChangeText={(text) => setFolder(text)}
                placeholder="second-context/"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                error={touched ? folderError : undefined}
                hint="Only for a second context on the same Dropbox account. Leave it empty and this context uses the app folder itself, which is what one context wants."
                testID="dropbox-folder"
              />
            </View>
          ) : null}

          <View style={styles.actions}>
            <Button
              label={busy ? "Opening Dropbox…" : "Connect Dropbox"}
              accessibilityLabel="Connect this context to a folder in your Dropbox"
              variant="white"
              disabled={busy}
              onPress={() => {
                setTouched(true);
                if (folderError !== undefined) return;
                const chosen = folder.trim();
                start(askFolder && chosen.length > 0 ? chosen : undefined);
              }}
              trailing={busy ? <ActivityIndicator color={colors.ink} size="small" /> : null}
              testID="dropbox-connect"
            />
            {askFolder ? null : (
              <Button
                label="Second context on this Dropbox?"
                accessibilityLabel="Choose a folder inside the app folder for a second context"
                variant="ghost"
                disabled={busy}
                onPress={() => setAskFolder(true)}
                testID="dropbox-folder-disclose"
              />
            )}
          </View>
        </>
      )}

      {state.kind === "failed" ? (
        <FormError
          headline={state.failure.headline}
          next={[state.failure.next, state.failure.detail].filter(Boolean).join(" ")}
          style={styles.failure}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  lede: { marginTop: 8, lineHeight: leading(12.5, 1.6) },
  emphasis: { color: colors.text },
  folder: { marginTop: 18 },
  actions: { marginTop: 18, flexDirection: "row", alignItems: "center", gap: 16, flexWrap: "wrap" },
  note: { marginTop: 14, lineHeight: leading(12.5, 1.7) },
  unavailable: { marginTop: 16, lineHeight: leading(12.5, 1.7) },
  failure: { marginTop: 16 },
});
