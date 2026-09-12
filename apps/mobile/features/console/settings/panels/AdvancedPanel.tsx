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
import { relativeTime } from "../../format";
import {
  auditActionLabel,
  auditActorLabel,
  describeKeyExportFailure,
  describeMoveProgress,
  type AdvancedView,
  type AuditView,
  type KeyExportAction,
  type KeyExportDocument,
  type KeyExportFailure,
} from "../../advanced/advanced";

/**
 * Advanced: this context's audit trail, and the export that keeps encryption
 * honest about `CLAUDE.md`'s first non-negotiable.
 *
 * The word "Advanced" is kept deliberately — it reliably means "not for me",
 * which is right here: a raw activity log and a control that hands an owner
 * AES key material in the clear are both real controls this context needs
 * somewhere, and neither belongs on a screen most people open.
 *
 * `keyExport` is **absent** — the whole property — for anyone who is not the
 * owner of this context, and in the demo. `exportEncryptionKeys` is owner-only
 * on the backend, so rendering the button for anybody else would be offering
 * a control whose only possible outcome is a permission error.
 */
export function AdvancedPanel({
  view,
  /** True on the landing page's picture of a console, which has no context. */
  demo = false,
}: {
  view: AdvancedView;
  demo?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <Text variant="rowTitle" style={styles.subHead}>
        Folder moves
      </Text>
      <Text variant="rowSub" style={styles.subSub}>
        Large moves continue safely in the background, even if you close the app.
      </Text>
      {view.moves.failure ? (
        <FormError
          headline={view.moves.failure.headline}
          next={[view.moves.failure.next, view.moves.failure.detail].filter(Boolean).join(" ")}
        />
      ) : (
        <Card>
          {view.moves.jobs.length === 0 ? (
            <Row divided>
              <Grow>
                <Text variant="rowSub">
                  {view.moves.loading
                    ? "Loading…"
                    : (view.moves.readOnlyReason ?? "No large folder moves are running.")}
                </Text>
              </Grow>
            </Row>
          ) : null}
          {view.moves.jobs.map((job) => {
            const words = describeMoveProgress(job);
            return (
              <View key={job.jobId} testID="durable-move-progress">
                <Row divided>
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
      )}

      <Text variant="rowTitle" style={styles.subHead}>
        Audit trail
      </Text>
      <Text variant="rowSub" style={styles.subSub}>
        Every change to this context, and who made it — including an AI app connected
        here. Owner-only: a row&apos;s path can name a note nobody else here is meant to
        see.
      </Text>
      <AuditCard view={view.audit} />

      <Text variant="rowTitle" style={styles.subHeadLater}>
        Encryption keys
      </Text>
      <Text variant="rowSub" style={styles.subSub}>
        Export the keys that open this context&apos;s encrypted notes, so you can always
        read them yourself — with no gateway and no control plane — even after revoking
        our access.
      </Text>
      <KeyExportCard action={view.keyExport} demo={demo} />
    </View>
  );
}

function AuditCard({ view }: { view: AuditView }) {
  const styles = useThemedStyles(makeStyles);
  const now = Date.now();

  // A query that came back as an error is neither an empty trail nor a
  // permanent "Loading…" — the same guard `MembersSection` and
  // `SharedLinksPanel` use, and for the same reason: `useAdvanced` subscribes
  // with `useQueries`, never `useQuery`.
  if (view.failure) {
    return (
      <View testID="audit-failure">
        <FormError
          headline={view.failure.headline}
          next={[view.failure.next, view.failure.detail].filter(Boolean).join(" ")}
        />
      </View>
    );
  }

  return (
    <Card>
      {view.events.length === 0 ? (
        <Row divided>
          <Grow>
            <Text variant="rowSub">
              {view.loading
                ? "Loading…"
                : (view.readOnlyReason ?? "Nothing has happened here yet.")}
            </Text>
          </Grow>
        </Row>
      ) : null}

      {view.events.map((event) => (
        <Row key={event.eventId} divided style={styles.wrapRow}>
          <Grow>
            <Text variant="rowTitle">{auditActionLabel(event.action)}</Text>
            <Text variant="rowSub" style={styles.rowSub}>
              {`${auditActorLabel(event)} · ${relativeTime(event.at, now)}`}
            </Text>
            {event.paths.length > 0 ? (
              <Text variant="rowSub" style={styles.rowSub} numberOfLines={1}>
                {event.paths.join(", ")}
              </Text>
            ) : null}
          </Grow>
        </Row>
      ))}
    </Card>
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
        This document opens every note this context has ever encrypted, entirely on its
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
            : "Only an owner of this context can export its encryption keys."}
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
            accessibilityLabel="Export this context's encryption keys in the clear"
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
          This context has never encrypted a note, so there is no key to export yet.
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
              Keep this somewhere offline and outside this context&apos;s own notes — a
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
    subHead: { marginBottom: 4 },
    subHeadLater: { marginTop: 30, marginBottom: 4 },
    subSub: { marginBottom: 12, maxWidth: 546 },
    rowSub: { marginTop: 2 },
    wrapRow: { flexWrap: "wrap" },
    inlineMono: { fontSize: 12 },
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
    exportText: { fontSize: 12 },
  });
