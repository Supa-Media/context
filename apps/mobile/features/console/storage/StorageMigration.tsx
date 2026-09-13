import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { Text } from "../../design/components/Text";
import { useThemedStyles } from "../../design/theme";
import { Confirm } from "../files/Dialogs";
import { openStore } from "../../offline/store";

/**
 * The one-time storage-layout update, and the two places it is offered from.
 *
 * ## Why it is not a button in the file tree's toolbar
 *
 * It was one: a gear sitting in `Explorer`'s toolbar beside New note, New
 * folder, Sort A-Z and Collapse every folder — four controls somebody uses
 * every day, and a fifth that reorganizes Context's own hidden objects under
 * `.context/` exactly once and changes not a single note. Permanent top-level
 * chrome for a one-time internal maintenance operation, and the owner said so.
 *
 * So it has two homes instead, and neither is chrome:
 *
 *  - **Settings → Storage**, permanently. It is a legitimate owner action and
 *    a findable one — the place somebody already goes to read what bucket this
 *    context is on. `StorageMigrationCard`.
 *  - **An inline notice in the console**, dismissible, drawn by `BrowsePane`
 *    in the same band the bucket and privacy notices use. Not a modal on load:
 *    an unprompted dialog on app open is its own bad UX, while a line of text
 *    with two buttons explains itself and can be ignored.
 *
 * Both raise the same `Confirm`, with the same words, and both call the same
 * `files.updateStorageLayout` — which is `undefined` for anybody who is not
 * the owner of this context (`useFileBrowser`), so an absent function is still
 * the only gate on either surface. That guard is not widened here: what moved
 * is where the control lives, not who may press it.
 */

/**
 * The confirmation, verbatim from the dialog the toolbar used to raise.
 *
 * Kept as it was because it is accurate and load-bearing: the first sentence
 * is the whole reason somebody can press this without reading the rest, and
 * `explorerActionGuards` asserted on it before this control had a second
 * entry point. One copy, so the two surfaces cannot come to say different
 * things about what the operation touches.
 */
export const STORAGE_MIGRATION_TITLE = "Update Context storage";
export const STORAGE_MIGRATION_CONFIRM_LABEL = "Update storage";
export const STORAGE_MIGRATION_BODY =
  "This reorganizes only Context’s hidden system files under .context/. Your notes, folders, privacy.md, and index.md are not changed. The update is resumable, keeps the old system copies for at least seven days, and removes them automatically when the bucket can do so safely.";

/** What the notice says, which is the offer rather than the consequences. */
export const STORAGE_MIGRATION_OFFER =
  "Context can reorganize its own hidden system files under .context/. It is a one-time background update that leaves every note, folder, privacy.md and index.md exactly where it is — and it is always here in Settings → Storage, whether you run it now or never.";

/** The dialog, raised once somebody has chosen to run it from either home. */
export function StorageMigrationConfirm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Confirm
      title={STORAGE_MIGRATION_TITLE}
      body={STORAGE_MIGRATION_BODY}
      confirmLabel={STORAGE_MIGRATION_CONFIRM_LABEL}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/**
 * Settings → Storage: the permanent home.
 *
 * A row like every other row in that section — what it is on the left, the
 * control on the right — rather than an icon whose only explanation is its
 * tooltip. It owns the confirmation state so the panel around it does not have
 * to; the panel decides only whether this context has the action at all.
 */
export function StorageMigrationCard({ run }: { run: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const [confirming, setConfirming] = useState(false);
  return (
    <Card testID="settings-storage-migration">
      <Row divided style={styles.row}>
        <Grow style={styles.grow}>
          <Text variant="rowTitle">{STORAGE_MIGRATION_TITLE}</Text>
          <Text variant="rowSub">
            A one-time reorganization of Context&apos;s own hidden files under .context/. Your
            notes are not touched, and nothing here is required — an older layout keeps
            working.
          </Text>
        </Grow>
        <Button
          label={STORAGE_MIGRATION_TITLE}
          accessibilityLabel={STORAGE_MIGRATION_TITLE}
          onPress={() => setConfirming(true)}
          testID="settings-storage-migration-run"
        />
      </Row>
      {confirming ? (
        <StorageMigrationConfirm
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            run();
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * Where a dismissed notice is remembered, per context.
 *
 * Its own key rather than one of `features/offline/keys.ts`' — that file's
 * scheme is for *copies of what a bucket said*, swept and invalidated as a
 * cache, and this is neither a copy nor disposable: forgetting it puts the
 * notice back in front of somebody who has already said no. Same argument
 * `appearancePrefs.ts` makes for sitting outside that namespace, and the same
 * port (`openStore()`: `AsyncStorage` on a device, `localStorage` on the web).
 *
 * Per workspace because the offer is per workspace: an owner of two contexts
 * answering for one has not answered for the other.
 */
export function storageMigrationDismissedKey(workspaceId: string): string {
  return `context.lc.storage-migration.dismissed.v1.${workspaceId}`;
}

/**
 * Whether to offer the notice for this context, and how to stop offering it.
 *
 * ## Why the dismissal is written down at all
 *
 * Nothing in the control plane says whether this bucket still needs the
 * update — the action is owner-only and idempotent, and the console is told
 * only that it *may* run it. So "available" is as close to "pending" as this
 * screen can honestly get, and a notice drawn from that alone would come back
 * on every reload, for ever, including for somebody who ran it last week.
 * That is a worse deal than the gear button this replaces, which at least
 * stayed quiet. Remembering the answer is what makes it an offer rather than
 * a nag.
 *
 * ## Why it starts hidden
 *
 * The device is asked before anything is drawn, and `visible` is false until
 * it answers. A notice that appears and then vanishes half a frame later is a
 * layout jump on the surface somebody came to read.
 *
 * `null` for a context with nothing to offer — no workspace yet, or an
 * `updateStorageLayout` this caller does not have — so the caller's guard
 * stays one expression and this hook is still called unconditionally.
 */
export function useStorageMigrationOffer(workspaceId: string | null): {
  visible: boolean;
  dismiss: () => void;
} {
  const [answered, setAnswered] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (workspaceId === null) return;
    let live = true;
    void openStore()
      .get(storageMigrationDismissedKey(workspaceId))
      .then((stored) => {
        if (!live) return;
        setDismissed(stored !== null);
        setAnswered(workspaceId);
      })
      .catch(() => {
        // A read that failed found nothing we can trust, and the honest branch
        // is the quiet one: a notice nobody can dismiss durably is worse than
        // no notice. See `store.web.ts` on why a read never throws upward.
        if (live) setDismissed(true);
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (workspaceId === null) return;
    // Fire and forget, on `writeStoredScheme`'s model: what a lost write costs
    // here is seeing the notice once more, not anybody's typing.
    void openStore()
      .set(storageMigrationDismissedKey(workspaceId), "1")
      .catch(() => {});
  }, [workspaceId]);

  return { visible: workspaceId !== null && answered === workspaceId && !dismissed, dismiss };
}

/**
 * The notice's own two controls, for the band `BrowsePane` draws them in.
 *
 * The words and the wash belong to that band — this is a row of buttons and
 * the dialog behind them, so the two entry points cannot drift in what they
 * do while looking alike.
 */
export function StorageMigrationActions({
  run,
  onDismiss,
  style,
}: {
  run: () => void;
  onDismiss: () => void;
  style?: View["props"]["style"];
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <View style={style}>
      <Button
        label={STORAGE_MIGRATION_TITLE}
        onPress={() => setConfirming(true)}
        testID="browse-storage-migration-run"
      />
      {/*
        "Not now", not "Dismiss". The other notices in that band report a state
        somebody has to fix; this one is an offer, and the word that turns it
        down should say that it can be taken up later — which it can, from
        Settings → Storage, as the sentence above the buttons says.
      */}
      <Button label="Not now" onPress={onDismiss} testID="browse-storage-migration-dismiss" />
      {confirming ? (
        <StorageMigrationConfirm
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            // Running it answers the offer: the notice goes with the press
            // rather than sitting there restating something now under way.
            onDismiss();
            run();
          }}
        />
      ) : null}
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    /**
     * The button drops below the words rather than squeezing them.
     *
     * `Row` does not wrap and `Grow` carries `minWidth: 0`, so inside a 390pt
     * phone's settings panel the text column was crushed to about 110pt: a
     * three-line heading beside a button at its full width. Wrapping needs
     * both halves — somewhere to wrap *to* (`flexWrap`), and a floor under the
     * text (`minWidth`) so the layout prefers a second line to a narrower
     * column. `alignItems` because a wrapped row's two lines should both start
     * at the left edge rather than centre on each other.
     */
    row: { flexWrap: "wrap", alignItems: "flex-start" },
    grow: { minWidth: 240 },
  });
