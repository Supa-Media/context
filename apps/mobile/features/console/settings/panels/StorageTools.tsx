import { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Hint } from "../../../design/components/Field";
import { FormError } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { useCopy } from "../../../design/useCopy";
import { useArming } from "../../useArming";
import {
  describeKeyExportFailure,
  describeMoveProgress,
  type AdvancedView,
  type KeyExportAction,
  type KeyExportDocument,
  type KeyExportFailure,
} from "../../advanced/advanced";
import { pointerType as t } from "../../../design/tokens";

/**
 * The two pieces of the old "Advanced" block that belong with storage: large
 * folder moves still running in the background, and the export of the keys
 * that open encrypted notes.
 *
 * "Advanced" was a block at the foot of the workspace page holding these, the
 * audit trail and deleting the workspace: four unrelated things under a word
 * that means "not for me". The settings cleanup (2026-09-29) gave the trail
 * its own Activity section, put deletion on General under "Can't be undone",
 * and moved these two here, beside Download everything, because both are
 * about the files themselves.
 */

/**
 * Background folder moves, drawn only while there is something to say.
 *
 * It used to be a card reading "No large folder moves are running" on every
 * visit, which is a row that is true almost always and tells nobody anything.
 */
export function FolderMovesCard({ view }: { view: AdvancedView["moves"] }) {
  const styles = useThemedStyles(makeStyles);
  if (view.failure) {
    return (
      <View style={styles.block}>
        <FormError
          headline={view.failure.headline}
          next={[view.failure.next, view.failure.detail].filter(Boolean).join(" ")}
        />
      </View>
    );
  }
  if (view.jobs.length === 0) return null;
  return (
    <View style={styles.block}>
      <Text variant="rowTitle" style={styles.subHead}>
        Folder moves
      </Text>
      <Text variant="rowSub" style={styles.subSub}>
        Large moves continue safely in the background, even if you close the app.
      </Text>
      <Card>
        {view.jobs.map((job, index) => {
          const words = describeMoveProgress(job);
          return (
            <View key={job.jobId} testID="durable-move-progress">
              <Row divided={index > 0}>
                <Grow>
                  <Text variant="rowTitle">{words.headline}</Text>
                  <Text variant="rowSub" style={styles.rowSub}>
                    {words.detail}
                  </Text>
                </Grow>
              </Row>
            </View>
          );
        })}
      </Card>
    </View>
  );
}

/**
 * The key export, under a heading of its own.
 *
 * `keyExport` is **absent**, the whole property, for anyone who is not the
 * owner, and in the demo; `exportEncryptionKeys` is owner-only on the backend,
 * so rendering the button for anybody else would offer a control whose only
 * possible outcome is a permission error. The heading goes with it.
 */
export function EncryptionKeysBlock({
  action,
  demo,
}: {
  action?: KeyExportAction;
  demo: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  if (action === undefined) return null;
  return (
    <View style={styles.block}>
      <Text variant="rowTitle" style={styles.subHead}>
        Encryption keys
      </Text>
      <Text variant="rowSub" style={styles.subSub}>
        The keys that open this workspace&apos;s encrypted notes, so you can always read
        them yourself, even without us.
      </Text>
      <KeyExportCard action={action} demo={demo} />
    </View>
  );
}

function KeyExportCard({
  action,
  demo,
}: {
  action?: KeyExportAction;
  demo: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<KeyExportFailure | null>(null);
  const [exported, setExported] = useState<KeyExportDocument | null>(null);
  const [empty, setEmpty] = useState(false);

  /**
   * Held during the export by `working`, which this sets synchronously — the
   * contract `useArming` documents for a synchronous `run`. Mirrors
   * `FastSearchCard`'s `run`: fire, then settle from whichever branch the
   * promise takes.
   */
  const run = () => {
    if (action === undefined) return;
    setWorking(true);
    setFailure(null);
    setEmpty(false);
    void action
      .export()
      .then((result) => {
        if (result === null) {
          setEmpty(true);
        } else {
          setExported(result);
        }
      })
      .catch((error: unknown) => setFailure(describeKeyExportFailure(error)))
      .finally(() => setWorking(false));
  };

  /**
   * Two presses, and the second expires — the same shape `SettingsPane`'s
   * Disconnect uses. Exporting cannot be undone: the key is wherever the
   * owner puts it the moment it leaves this screen, so a mis-tap is exactly
   * the input `useArming` guards against.
   */
  const armed = useArming(run);

  const text = exported === null ? "" : JSON.stringify(exported, null, 2);
  const { label: copyLabel, copy } = useCopy(text, "Copy");

  return (
    <Card>
      <Text variant="rowSub">
        This document opens every note this workspace has ever encrypted, entirely on its
        own — the offline decryptor (
        <Text variant="mono" style={styles.inlineMono}>
          npx @supa-media/context-encryption-decryptor
        </Text>
        ) reads it with no Context service involved at all. Once it leaves this screen
        the key is wherever you put it; there is no way to un-export it.
      </Text>

      {action === undefined ? (
        <Text variant="foot" style={styles.readOnly}>
          {demo
            ? "Sign in and open your own context to export its keys."
            : "Only an owner of this workspace can export its encryption keys."}
        </Text>
      ) : (
        <Row style={styles.actions}>
          <Button
            label={
              working
                ? "Exporting…"
                : armed.stage === "armed"
                  ? "Press again to export"
                  : "Export encryption keys"
            }
            variant="danger"
            disabled={working}
            accessibilityLabel="Export this workspace's encryption keys in the clear"
            onPress={armed.press}
            testID="advanced-export-keys"
          />
        </Row>
      )}

      {armed.stage === "armed" ? (
        <Hint>
          <Text variant="hint">
            The keys leave this screen in the clear the moment you press again — have
            somewhere safe ready for them. There is no way to un-export them.
          </Text>
        </Hint>
      ) : null}

      {empty ? (
        <Text variant="rowSub" style={styles.rowSub}>
          This workspace has never encrypted a note, so there is no key to export yet.
        </Text>
      ) : null}

      {failure !== null ? (
        <FormError headline={failure.headline} next={failure.next} style={styles.notice} />
      ) : null}

      {exported !== null ? (
        <View style={styles.exportBox} testID="advanced-export-document">
          <ScrollView style={styles.exportScroll} nestedScrollEnabled>
            <Text variant="mono" selectable style={styles.exportText}>
              {text}
            </Text>
          </ScrollView>
          <Row style={styles.actions}>
            <Button label={copyLabel} onPress={copy} testID="advanced-export-copy" />
          </Row>
          <Hint>
            <Text variant="hint">
              Keep this somewhere offline and outside this workspace&apos;s own notes — a
              password manager, an encrypted drive. Anybody who has it can read every
              encrypted note here.
            </Text>
          </Hint>
        </View>
      ) : null}
    </Card>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    block: { marginTop: 30 },
    subHead: { marginBottom: 4 },
    subSub: { marginBottom: 12, maxWidth: 546 },
    rowSub: { marginTop: 2 },
    inlineMono: { fontSize: t.meta },
    actions: { marginTop: 15, gap: 9, flexWrap: "wrap" },
    notice: { marginTop: 15 },
    readOnly: { marginTop: 4 },
    exportBox: { marginTop: 15 },
    exportScroll: {
      maxHeight: 220,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 10,
      backgroundColor: colors.well,
      padding: 12,
    },
    exportText: { fontSize: t.meta },
  });
