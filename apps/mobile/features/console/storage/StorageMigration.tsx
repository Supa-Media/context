import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Whether the *notice* is worth drawing, which is not the same question as
 * who may run this.
 *
 * `updateStorageLayout` is the only gate on both entry points and it is
 * untouched — an owner has it, nobody else does. This is the extra thing the
 * interrupting half has to be true for, and it narrows rather than widens: a
 * context with no bucket connected, or one whose binding has not answered
 * yet, has nothing to reorganize, and the console is already telling its
 * owner so in a louder notice two lines above. Offering to tidy the hidden
 * files of a bucket that is not there is noise at the worst possible moment.
 *
 * The settings row does **not** take this condition, deliberately: it is a
 * place somebody went looking rather than something that appeared in front of
 * them, and a control that vanishes from its permanent home because a probe
 * is mid-flight is a control people stop trusting is there.
 *
 * ## And whether there is anything left to offer
 *
 * The second condition is the one this notice was missing entirely.
 * `layoutState` is what the binding remembers of the migration — recorded by
 * the migration itself, so it is the same on every device this person signs in
 * on. Every state is an answer, and an offer to do something already done is
 * the nag this control kept becoming.
 *
 * Before it, the only thing that could quieten the notice was a flag on the
 * device, so running the migration on a laptop left the phone offering it
 * again, for ever. See `docs/decisions/storage-and-credentials.md`.
 *
 * ## Why an absent state is not enough, and `layoutChecked` exists
 *
 * **The recorded state fixed this for contexts migrated after it existed, and
 * for nobody else.** It was only ever written by a migration pass, so a
 * context migrated before that shipped kept `complete` in its own bucket and
 * nothing on its binding — and an absent state was read as "nobody has run
 * it". The notice came back on every device, for ever, for exactly the people
 * who had already run it. Recording the outcome did not end that nag for the
 * person who reported it; it ended it for everybody who came after them.
 *
 * So absent is two answers and the offer needs the right one. `layoutChecked`
 * is whether the bucket has been **asked** — by `observeStorageLayout`, which
 * runs nothing, or by any migration pass. Unasked is not an invitation to
 * offer: it is a question the console has not put yet, and
 * `useStorageLayoutObservation` puts it.
 *
 * The settings row does not take either condition — it reports the state
 * instead, which is what somebody who went looking came to find out, and it
 * keeps its button while the answer is unknown because pressing it is still
 * correct and now records what it finds.
 */
export function storageMigrationWorthOffering(
  storage:
    | { connected?: boolean; layoutState?: StorageLayoutState; layoutChecked?: boolean }
    | null
    | undefined,
): boolean {
  return (
    storage?.connected === true &&
    storage.layoutChecked === true &&
    storage.layoutState === undefined
  );
}

/**
 * Where the storage-layout migration got to, as the binding remembers it.
 *
 * The migration's own six words — see `functions/lib/storageLayout.ts`, which
 * is where they are defined and where the union that validates them lives.
 */
export type StorageLayoutState =
  | "copying"
  | "copied"
  | "cleaning"
  | "conflict"
  | "unsupported"
  | "complete";

/**
 * What Settings → Storage says about a state somebody went looking for, and
 * whether it still has a control.
 *
 * `offer: false` for a state with nothing left to press, which is most of
 * them: a migration that is done, under way, or waiting out its rollback
 * window is a fact to report, and a button whose outcome is "no change"
 * teaches people to distrust the ones that do something. `unsupported` is the sharpest case —
 * `runStorageLayoutMigration` refuses a bucket without conflict-safe writes on
 * every call, so a button there could only ever produce that refusal again.
 *
 * `conflict` keeps its button. It is the one answered state that is still
 * somebody's to act on, and the migration is resumable by construction.
 */
export function storageMigrationRow(state: StorageLayoutState | undefined): {
  sub: string;
  offer: boolean;
} {
  switch (state) {
    case undefined:
      return {
        sub:
          "A one-time reorganization of Context's own hidden files under .context/. Your notes " +
          "are not touched, and nothing here is required — an older layout keeps working.",
        offer: true,
      };
    case "complete":
      return {
        sub: "Done. Context's hidden files are already on the current layout.",
        offer: false,
      };
    case "copying":
    case "cleaning":
      return {
        sub:
          "Under way. It runs in the background, in bounded passes, and picks up where it left " +
          "off — nothing here needs to stay open.",
        offer: false,
      };
    case "copied":
      return {
        sub:
          "Copied and verified. The old system copies are kept for the seven-day rollback " +
          "window and then removed automatically.",
        offer: false,
      };
    case "conflict":
      return {
        sub:
          "Stopped: something under .context/ changed while it was copying. Nothing was deleted. " +
          "Running it again picks up from where it stopped.",
        offer: true,
      };
    case "unsupported":
      return {
        sub:
          "This bucket does not support conflict-safe writes, so the update cannot run here. " +
          "Nothing is wrong with the context — the older layout keeps working, and stays " +
          "readable.",
        offer: false,
      };
  }
}

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
export function StorageMigrationCard({
  run,
  state,
  workspaceId = null,
}: {
  run: () => void;
  /** What the binding remembers. `undefined` is "nobody has run it". */
  state?: StorageLayoutState;
  /**
   * Whose offer running it here answers.
   *
   * The row's own text sends nobody anywhere, but the *notice*'s text sends
   * people here — and running it here used to leave that notice sitting in the
   * console restating something already under way, until the recorded state
   * came back through the subscription. Answering the offer from both surfaces
   * closes that window. `null` where there is no workspace to answer for.
   */
  workspaceId?: string | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const [confirming, setConfirming] = useState(false);
  const row = storageMigrationRow(state);
  return (
    <Card testID="settings-storage-migration">
      <Row divided style={styles.row}>
        <Grow style={styles.grow}>
          <Text variant="rowTitle">{STORAGE_MIGRATION_TITLE}</Text>
          <Text variant="rowSub">{row.sub}</Text>
        </Grow>
        {row.offer ? (
          <Button
            label={STORAGE_MIGRATION_TITLE}
            onPress={() => setConfirming(true)}
            testID="settings-storage-migration-run"
          />
        ) : null}
      </Row>
      {confirming ? (
        <StorageMigrationConfirm
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            if (workspaceId !== null) dismissStorageMigrationOffer(workspaceId);
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
    dismissStorageMigrationOffer(workspaceId);
  }, [workspaceId]);

  return { visible: workspaceId !== null && answered === workspaceId && !dismissed, dismiss };
}

/**
 * Ask the bucket where the migration got to, once, when nobody has asked yet.
 *
 * This is the half that makes `layoutChecked` ever become true for a context
 * that was migrated before any of this existed — which is every context that
 * kept being offered the update after the outcome started being recorded. The
 * bucket has always known; until now nothing asked it except the migration
 * itself, so the only way to find out whether it had run was to run it again.
 *
 * Fire and forget, and deliberately quiet: nobody is waiting on it, the
 * console renders the same either way, and the visible consequence of it
 * landing is a notice that stops coming back. A refusal — not the owner, a
 * binding that went away, the rate limit — costs one more appearance of a
 * notice that can already be dismissed, so it is swallowed rather than turned
 * into an error somebody has to read.
 *
 * Guarded on `checked` rather than only on the backend's own guard so a
 * console that re-renders does not re-ask; the mutation refuses a spent
 * question anyway, and this keeps the call from being made at all.
 *
 * `contextId` is the **dedup key and nothing else** — `observe` already names
 * the context it acts on, because `useLiveConsoleData` binds it to the same
 * `selectedContextId` that `storage` here was read from. Passing an id in
 * would be a second answer to a question that has one, and during a context
 * switch the two disagree: `files.contextId` moves a commit later than the
 * console's selection does. So the id this takes is the browser's, the
 * workspace asked is the console's, and they are only ever the same binding
 * once the switch has settled.
 */
export function useStorageLayoutObservation(
  contextId: string | null,
  storage: { connected?: boolean; layoutChecked?: boolean } | null | undefined,
  observe: (() => Promise<unknown>) | undefined,
): void {
  const unasked = storage?.connected === true && storage.layoutChecked !== true;
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (contextId === null || observe === undefined || !unasked) return;
    if (asked.current === contextId) return;
    asked.current = contextId;
    void observe().catch(() => {});
  }, [contextId, unasked, observe]);
}

/**
 * Remember that this context's offer has been answered, on this device.
 *
 * Belt and braces rather than the mechanism: the answer that travels is the
 * binding's `layoutState`, recorded by the migration itself and the same on
 * every device this person signs in on. This covers the seconds between
 * pressing and that state arriving, and it is the whole of the answer for
 * "Not now" — which records a preference rather than an outcome, and so has
 * nothing on the binding to record.
 *
 * Fire and forget, on `writeStoredScheme`'s model: what a lost write costs
 * here is seeing the notice once more, not anybody's typing.
 */
export function dismissStorageMigrationOffer(workspaceId: string): void {
  void openStore()
    .set(storageMigrationDismissedKey(workspaceId), "1")
    .catch(() => {});
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
