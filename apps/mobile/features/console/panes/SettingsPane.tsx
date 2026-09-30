import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Row } from "../../design/components/Card";
import { Dot } from "../../design/components/Dot";
import { FieldList, Hint } from "../../design/components/Field";
import { FormError, Notice } from "../../design/components/Input";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { TextLink } from "../../design/components/TextLink";
import { leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { PaneHead } from "../ConsoleShell";
import { PanelHead, SubHead } from "../settings/panels/PanelHead";
import { atName } from "../format";
import { SourcesPanel } from "../settings/panels/SourcesPanel";
import { MeetingsPanel } from "../settings/panels/MeetingsPanel";
import { ModelPanel } from "../settings/panels/ModelPanel";
import { FastSearchCard } from "../search/FastSearchCard";
import type { CheckoutOutcome } from "@context/shared";
import { OverviewPanel } from "../settings/panels/OverviewPanel";
import { PremiumPanel } from "../settings/panels/PremiumPanel";
import { ConnectedAppsCard } from "../settings/AccountSections";
import { DomainSection } from "../settings/panels/DomainPanel";
import { EmojiPanel } from "../settings/panels/EmojiPanel";
import { SettingsStorageChoice, SettingsVaultImport } from "../storage/SettingsStorageChoice";
import { ActivityPanel } from "../settings/panels/ActivityPanel";
import { SharingSection } from "../settings/panels/SharingSection";
import { EncryptionKeysBlock, FolderMovesCard } from "../settings/panels/StorageTools";
import { DeleteWorkspaceCard } from "../settings/DeleteWorkspaceCard";
import { PluginsPanel } from "../settings/panels/PluginsPanel";
import { selectedContext, type ConsoleData, type ConsoleStorage, type StorageActions } from "../types";
import type { SettingsSectionKey } from "../settings/sections";
import { useArming } from "../useArming";
import { ConnectForm } from "../storage/ConnectForm";
import { EncryptionRow } from "../storage/EncryptionRow";
import { StorageHealth } from "../settings/panels/StorageHealth";
import { forcePathStyleToAddressing } from "../storage/connect";
import { describeStorageFailure } from "../storage/errors";
import { useReverify } from "../storage/useReverify";
import type { ReverifyState } from "../storage/reverify";
import { StorageMigrationCard } from "../storage/StorageMigration";
import { HANDOFF_FORM_LEDE } from "../storage/handoff/copy";
import { HandoffCard } from "../storage/handoff/HandoffCard";
import type { SetupAgent } from "../../agentSetup/guides";

/**
 * A context's settings: its bucket, its credentials, and its ingestion rules.
 *
 * This used to be a top-level "Storage" pane sitting beside Map and
 * Connections. It was in the wrong place, and not only visually — a storage
 * binding hangs off a `workspaceId`, never a `userId`, so two contexts can and
 * do point at two different buckets. A pane at app level was quietly claiming
 * there is one. It is reached now from the gear beside the storage chip in
 * Browse, which is where somebody looking at `R2 · notes-bucket` is already looking.
 *
 * The components below are the Storage pane's, moved rather than rewritten:
 * the same binding card, the same connect form, the same re-verify state
 * machine.
 *
 * Only two capability lines are live, and only those two are drawn.
 * `getStorageBinding` returns `capabilities.conditionalWrite` and a status;
 * nobody counts the objects in a bucket, looks for its PARA folders, or reads
 * its versioning setting. Those three used to be rendered anyway, from
 * constants, with a green check mark beside them — a bucket holding six
 * objects was told it held 1,284, a bucket with no PARA scaffold was told it
 * had one, and a bucket with versioning already on was told to go and turn it
 * on (#25). They are absent now, and stay absent until the connect-time probe
 * persists what it actually saw.
 *
 * Every control here comes from `data.storageActions`, which is **absent** in
 * the demo console and for anyone who is not the owner of this context. That is
 * deliberate: `bindStorage`, `reverifyStorage`, and `disconnectStorage` are all
 * owner-only, so rendering them for an editor would be offering a button whose
 * only possible outcome is a permission error.
 */
export function SettingsPane({
  data,
  onClose,
  onSelect,
  section,
  returned = null,
  onConnectAgent,
}: {
  data: ConsoleData;
  onClose: () => void;
  /**
   * Open another section, for the blocks that link to one.
   *
   * Absent on the whole-pane scroll — the landing page's console and the
   * `/settings` fallback — where every block is already on screen and a link
   * to one of them would be a link to somewhere the reader is. Overview's
   * facts render as plain facts there, which is what they were.
   */
  onSelect?: (key: SettingsSectionKey) => void;
  /**
   * Render one section rather than the whole scroll.
   *
   * Absent is the original pane — every section in order, with its own head
   * and Done button — which is what the landing page's picture of the console
   * still draws and what the redirected `/settings` route falls back to. When
   * present the overlay owns the chrome and the section list, and this renders
   * only the block it was asked for.
   */
  section?: SettingsSectionKey;
  /** What a return from Stripe said, from the route. Only Premium reads it. */
  returned?: CheckoutOutcome | null;
  onConnectAgent?: (agent: SetupAgent) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const storage = data.storage;
  const actions = data.storageActions;
  const current = selectedContext(data);
  const [rebinding, setRebinding] = useState(false);
  const [switchingBack, setSwitchingBack] = useState(false);

  /**
   * Whether a block belongs on screen. No `section` is the original pane —
   * everything, in order — so this is the identity there; with one, it is the
   * only block drawn and the overlay is drawing the rest of the chrome.
   */
  const show = (key: SettingsSectionKey) => section === undefined || section === key;

  return (
    <View>
      {section !== undefined ? null : (
      <PaneHead
        title={`${atName(current?.slug ?? "this context")} settings`}
        description="Storage and ingestion rules. They belong here, not to your account — every other workspace can point somewhere else entirely."
        trailing={
          <View style={styles.headActions}>
            {/*
              Ahead of the storage pill, because it qualifies everything below
              it. Somebody who cannot connect a bucket here, cannot change the
              allow-list here, and cannot see this context's private notes is
              being told all three by one chip and two absent controls.
            */}
            {storage ? <StatusPill storage={storage} /> : null}
            <Button
              label="Done"
              accessibilityLabel="Close settings and go back to browsing"
              onPress={onClose}
              testID="settings-close"
            />
          </View>
        }
      />
      )}

      {show("storage") ? (
      <>
      {/*
        The sentence has to name the thing the reader can actually go and do,
        and that differs by backend: an S3 owner revokes a key at their
        provider, a Dropbox owner unlinks Context in their Dropbox account.
        Telling the second to revoke a key sends them looking for a screen that
        does not exist.
      */}
      <PanelHead section="storage" sectioned={section !== undefined} first>
        {storage?.managed === true
          ? "Context runs this bucket for you. You can take every file with you at any time, free, on any plan."
          : storage?.provider === "dropbox"
          ? "Your notes are plain files in your own Dropbox. Unlink Context in your Dropbox settings and it loses access right away; every file stays where it is."
          : "Your notes are plain files in storage you own. Remove Context's key at your provider and it loses access right away."}
      </PanelHead>

      {storage === null || storage === undefined ? (
        // `undefined` is the binding still in flight, which is what the
        // spinner is for; `data.loading` is the workspace list and lands
        // first. See `ConsoleData.storage`.
        data.loading || storage === undefined ? (
          <Card>
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.text2} size="small" />
              <Text variant="rowSub">Loading…</Text>
            </View>
          </Card>
        ) : actions ? (
          <SettingsStorageChoice
            workspaceId={actions.workspaceId}
            contextName={current == null ? "this context" : `@${current.slug}`}
            connect={actions.connect}
            onOpenPremium={onSelect === undefined ? undefined : () => onSelect("premium")}
          />
        ) : (
          <Card>
            <Text variant="rowTitle">No storage connected</Text>
            <Text variant="rowSub" style={styles.rowSub}>
              {data.demo
                ? "Context stores nothing of its own. Point it at an S3-compatible bucket you own, and every note stays there."
                : "Only an owner of this context can connect storage to it."}
            </Text>
          </Card>
        )
      ) : switchingBack && actions ? (
        // Back to Context's storage while its copy is still kept: the same
        // choice a new workspace gets, whose managed option adopts that copy.
        <SettingsStorageChoice
          workspaceId={actions.workspaceId}
          contextName={current == null ? "this context" : `@${current.slug}`}
          connect={async (values) => {
            const result = await actions.connect(values);
            setSwitchingBack(false);
            return result;
          }}
          onCancel={() => setSwitchingBack(false)}
          onOpenPremium={onSelect === undefined ? undefined : () => onSelect("premium")}
        />
      ) : rebinding && actions ? (
        // Two different jobs behind one flag, decided by what is connected now.
        //
        // Rotating an S3 key must not mean retyping an endpoint, so that path
        // gets the form back with everything but the secret prefilled. A
        // Dropbox binding has no key to rotate and nothing to prefill — what
        // its owner wants is either the same consent screen again or a bucket
        // instead, which is exactly the pair `StorageChoice` draws.
        storage.managed === true ? (
          <ConnectForm
            lede={HANDOFF_FORM_LEDE}
            connect={async (values) => {
              await actions.handoff(values);
              setRebinding(false);
              return { status: "copying" };
            }}
            onCancel={() => setRebinding(false)}
          />
        ) : storage.provider === "dropbox" ? (
          <SettingsStorageChoice allowDropbox
            workspaceId={actions.workspaceId}
            contextName={current == null ? "this context" : `@${current.slug}`}
            connect={async (values) => {
              const result = await actions.connect(values);
              setRebinding(false);
              return result;
            }}
            onCancel={() => setRebinding(false)}
            onOpenPremium={onSelect === undefined ? undefined : () => onSelect("premium")}
          />
        ) : (
          <ConnectForm
            connect={async (values) => {
              const result = await actions.connect(values);
              setRebinding(false);
              return result;
            }}
            // Everything but the credential is prefilled: rotating a key should
            // not mean retyping an endpoint. The secret is never sent back down
            // from the control plane, so it is the one field that starts empty.
            //
            // `?? ""` on all three, and it is load-bearing rather than tidy.
            // These three became optional when Dropbox arrived, and `initial`
            // is spread *over* `emptyConnectForm()` — so an explicit
            // `undefined` wins, and `values.endpoint.trim()` throws on the
            // next render. `Partial<ConnectFormValues>` accepts `undefined`
            // happily, so the type checker has nothing to say about it.
            initial={{
              endpoint: storage.endpoint ?? "",
              region: storage.region ?? "",
              bucket: storage.bucket ?? "",
              rootPrefix: storage.rootPrefix ?? "",
              forcePathStyle: storage.forcePathStyle ?? null,
            }}
            onCancel={() => setRebinding(false)}
          />
        )
      ) : (
        <>
          <BindingCard
            storage={storage}
            actions={actions}
            demo={data.demo}
            onRebind={() => setRebinding(true)}
          />
          <HandoffCard
            storage={storage}
            owner={actions !== undefined}
            onMove={() => setRebinding(true)}
            onStop={actions?.cancelHandoff}
            onChooseExisting={actions?.chooseExistingFiles}
            onDownload={data.demo ? undefined : () => data.files.download("", "folder")}
            onSwitchBack={() => setSwitchingBack(true)}
          />
        </>
      )}

      <FolderMovesCard view={data.advanced.moves} />

      {storage?.connected === true && actions ? (
        <SettingsVaultImport workspaceId={actions.workspaceId} />
      ) : null}

      {/*
        The one-time storage-layout update, in the section about where this
        context's files are kept — which is the only place somebody would
        think to look for it.

        Gated on nothing but the action's presence, which is the guard it has
        always had: `useFileBrowser` hands `updateStorageLayout` to an owner
        and to nobody else, so an absent function is an absent row.

        The console's *notice* takes two further conditions — a connected
        binding and nothing recorded yet, `storageMigrationWorthOffering` —
        and this row deliberately takes neither. The asymmetry is the
        difference between the two surfaces rather than an oversight in one of
        them: an offer that appears in front of somebody has to earn the
        interruption, while a row they went looking for should still be here
        when a probe is mid-flight, and should still be here to *answer* them
        once the migration has run. Neither condition decides who may run it.

        So the row stays and its words change: `storageMigrationRow` turns the
        binding's recorded state into what somebody who came looking wants to
        know, and drops the button for the states where pressing it would do
        nothing.
      */}
      {data.files.updateStorageLayout !== undefined ? (
        <View style={styles.migration}>
          <StorageMigrationCard
            run={data.files.updateStorageLayout}
            state={data.storage?.layoutState}
            workspaceId={data.files.contextId}
          />
        </View>
      ) : null}

      {/*
        The index, under the bucket it is built from.

        Search was a row of its own, one below Storage, and the two rows asked
        the same question at two depths: where are my notes kept, and where is
        the thing that finds them. An index is a disposable derivative of the
        files — `CLAUDE.md` #3, rebuildable and never the only copy of
        anything — so it belongs under them rather than beside them.

        What it switches is still per context, which is why it is here at all
        and not at app level: two workspaces can be answered from two
        different places, and a switch above the context picker would claim
        there is one setting for all of them.
      */}
      <SubHead title="Search">
        How search finds your notes. The search index is a copy that can be deleted
        and rebuilt; your notes never move.
      </SubHead>
      <FastSearchCard view={data.fastSearch} demo={data.demo} />
      <EncryptionKeysBlock action={data.advanced.keyExport} demo={data.demo} />

      </>
      ) : null}

      {show("workspace") ? (
      <>
      {/*
        What this workspace is, and the one lever that acts on the whole of
        it. "Advanced" used to follow, holding folder moves, the audit trail,
        key export and deletion; since the settings cleanup (2026-09-29) the
        trail is its own Activity section, moves and keys sit with Storage,
        and deletion is here under a heading that says what it is.
      */}
      <PanelHead section="workspace" sectioned={section !== undefined}>
        This workspace&apos;s name and picture, and deleting it.
      </PanelHead>
      <OverviewPanel data={data} onSelect={onSelect} />
      {data.advanced.deletion === undefined || data.demo ? null : (
        <>
          <Text variant="eyebrow" style={styles.danger}>
            Can&apos;t be undone
          </Text>
          <DeleteWorkspaceCard
            deletion={data.advanced.deletion}
            people={data.members.loading ? undefined : data.members.members.length}
          />
        </>
      )}
      </>
      ) : null}

      {show("activity") ? (
        <ActivityPanel
          view={data.advanced.audit}
          members={data.members?.members}
          sectioned={section !== undefined}
        />
      ) : null}

      {show("premium") ? (
      <>
      <PanelHead section="premium" sectioned={section !== undefined}>
        What this workspace pays for. Premium is per workspace, so your other
        workspaces stay as they are. Downloading everything is free on either plan
        and still works after you cancel.
      </PanelHead>
      <PremiumPanel data={data} section={section} returned={returned} onSelect={onSelect} />
      </>
      ) : null}

      {show("sharing") ? (
        <SharingSection data={data} sectioned={section !== undefined} />
      ) : null}

      {show("website") ? (
      <DomainSection sectioned={section !== undefined} workspaceId={data.files.contextId ?? null}
        handle={current?.slug.replace(/^@/, "") ?? ""} demo={data.demo}
        onOpenPremium={onSelect === undefined ? undefined : () => onSelect("premium")} />
      ) : null}

      {show("emoji") ? <EmojiPanel sectioned={section !== undefined} /> : null}

      {show("integrations") ? (
      <>
      {/*
        Everything that talks to this context without being typed into it.

        It was five rows — AI apps, Email, Calendar, Chats — under a heading
        nobody navigates by. The split was right about one thing and wrong
        about the other: a person does ask "why isn't my mail here" rather than
        "what does my Google account do", and that question is answered on one
        page whatever number of mechanisms it takes. But five pages to ask five
        versions of "what is plugged in" is the list Sayo called overwhelming.

        AI apps leads, because an MCP client is the first thing most people
        connect and the word they arrive with. It is account-scoped — a
        connection reaches every workspace its person is a live member of — and
        the block says so in its own sentence, which is what keeps an
        account-wide fact on a context-scoped page from being a lie.

        Meetings is deliberately *not* here. It is the one capture surface
        people open on purpose rather than configure once, and Sayo asked for
        it separately by name.
      */}
      <PanelHead section="integrations" sectioned={section !== undefined}>
        Everything that fills this context without being typed into it: the AI
        apps holding a grant, the mailboxes and calendars we read, and the chats.
      </PanelHead>

      <SubHead title="AI apps">
        One address, added once per app. A connection reaches every workspace you
        are a live member of, and each app can be cut off on its own without
        touching the others.
      </SubHead>
      <ConnectedAppsCard data={data} onConnectAgent={onConnectAgent} />

      <SourcesPanel data={data} />
      </>
      ) : null}

      {show("model") ? <ModelPanel data={data} sectioned={section !== undefined} /> : null}

      {show("meetings") ? <MeetingsPanel data={data} sectioned={section !== undefined} /> : null}

      {show("plugins") ? (
      <>
      <PanelHead section="plugins" sectioned={section !== undefined}>
        {/*
          It said "the Obsidian plugins already in this context's bucket", which
          named one of the two places they live and was the top of a screen
          where every other sentence named the same one. A person whose plugins
          were all installed through Context read that and concluded Context
          ignores its own folder — and the panel, which showed nothing until a
          scan was pressed, gave them no reason to think otherwise.
        */}
        The plugins in this context — the ones Context installed, and any your Obsidian vault
        syncs here. Context reads <Text variant="mono">.obsidian/</Text> and never writes to
        it, so nothing on this screen changes your vault.
      </PanelHead>
      <PluginsPanel
        view={data.plugins}
        contextPlugins={data.contextPlugins}
        installs={data.pluginInstalls}
        grants={data.pluginGrants}
        browse={data.pluginBrowse}
        runtime={data.pluginRuntime}
      />
      </>
      ) : null}
    </View>
  );
}

/**
 * A label and its value, on one row.
 *
 * The shape the settings redesign is built on: what a thing is on the left,
 * what it currently is on the right, and no control unless there is something
 * to change. It replaces a column of full-width fields where every value had
 * the same visual weight as every other.
 */
/**
 * Exported because the overlay draws it, not the pane.
 *
 * Sectioning skips `PaneHead`, and this pill is the one thing in it that
 * qualifies everything below — "you cannot connect a bucket here" is said by
 * this chip and two absent controls. The overlay carries it in its header
 * instead, which is also the only place a phone can see it: the top bar's
 * storage chip is pointer-only.
 */
export function StatusPill({
  storage,
  testID,
}: {
  storage: ConsoleStorage;
  testID?: string;
}) {
  if (storage.connected) {
    return (
      <Pill tone="ok" leading={<Dot tone="ok" />} testID={testID}>
        Connected
      </Pill>
    );
  }
  const broken = storage.status === "error";
  return (
    <Pill tone="warn" leading={<Dot tone={broken ? "crit" : "warn"} />} testID={testID}>
      {broken ? "Not working" : "Not verified"}
    </Pill>
  );
}

function BindingCard({
  storage,
  actions,
  demo,
  onRebind,
}: {
  storage: ConsoleStorage;
  actions: StorageActions | undefined;
  demo: boolean;
  onRebind: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  // The third argument is which context is being verified. A probe's result
  // belongs to one workspace and must never be shown for another — see
  // `useReverify`.
  const reverify = useReverify(
    storage,
    actions ? actions.reverify : null,
    actions ? actions.workspaceId : null,
  );
  const [disconnecting, setDisconnecting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const disconnect = useArming(() => {
    if (actions === undefined) return;
    setDisconnecting(true);
    void actions.disconnect().finally(() => setDisconnecting(false));
  });

  const addressing = forcePathStyleToAddressing(storage.forcePathStyle);
  const isDropbox = storage.provider === "dropbox";
  const isManaged = storage.managed === true;

  /**
   * Only the fields this backend actually has.
   *
   * Built by pushing what is present rather than by listing four and letting
   * three of them be `undefined`: a Dropbox binding has no bucket, endpoint,
   * region or access key, and an empty labelled well reads as a field somebody
   * failed to fill in rather than one that does not exist here. Same rule the
   * capability rows below follow — absent, never a placeholder.
   */
  const fields: Array<{ label: string; value: string }> = [
    {
      label: "Provider",
      value: isManaged ? "Context-managed storage" : isDropbox ? "Dropbox" : storage.provider,
    },
  ];
  /*
    The rest sit behind "Connection details" (settings cleanup, 2026-09-29).
    An endpoint hostname, a masked access key and "bucket in the hostname"
    answer nothing somebody opening Storage is asking; they are there to be
    copied into a support thread or checked against the provider's console,
    so they are one press away rather than the first thing on the page.
  */
  const details: Array<{ label: string; value: string }> = [];
  // Which account, not just which provider: saying whose Dropbox this is,
  // and noticing a *different* one arriving on a reconnect.
  if (isDropbox && storage.dropboxAccountId) {
    details.push({ label: "Connected as", value: storage.dropboxAccountId });
  }
  if (storage.bucket) fields.push({ label: "Bucket", value: storage.bucket });
  if (storage.endpoint) details.push({ label: "Endpoint", value: storage.endpoint });
  if (storage.accessKey) details.push({ label: "Access key", value: storage.accessKey });
  if (storage.rootPrefix) {
    (isDropbox ? fields : details).push({
      label: isDropbox ? "Folder" : "Root prefix",
      value: storage.rootPrefix,
    });
  } else if (isDropbox) {
    // "Which folder is this?" is the first question somebody has about a
    // Dropbox connection, and the answer is the thing the consent screen
    // promised, so it stays on the page.
    fields.push({ label: "Folder", value: "Context's own app folder" });
  }
  // Shown only when somebody actually had to answer it at connect time.
  if (addressing !== null) {
    details.push({
      label: "Addressing",
      value: addressing === "path" ? "bucket in the path" : "bucket in the hostname",
    });
  }

  const failure =
    storage.status === "error"
      ? describeStorageFailure(storage.errorCode, storage.lastError, storage.provider)
      : null;

  return (
    <>
    <StorageHealth storage={storage} failed={failure !== null} />
    <Card testID="storage-binding">
      <FieldList fields={showDetails ? [...fields, ...details] : fields} testIDPrefix="storage-field" />
      {details.length === 0 ? null : (
        <TextLink
          label={showDetails ? "Hide connection details" : "Show connection details"}
          onPress={() => setShowDetails((open) => !open)}
          style={styles.detailsToggle}
          testID="storage-details-toggle"
        />
      )}
      <EncryptionRow storage={storage} />
      {/*
        A binding in `error` is the state this pane exists to get someone out
        of, so it gets the failure, the fix, and the provider's own words —
        not a one-line `Check` buried among four healthy ones.
      */}
      {failure ? (
        <FormError
          headline={failure.headline}
          next={joinSentences(failure.next, failure.detail)}
          style={styles.failure}
        />
      ) : null}

      <ReverifyStatus state={reverify.state} />

      <Row style={styles.actions}>
        {/*
          Re-verify stays available in every status — including `connected`,
          which is exactly when someone checks, because the gateway started
          failing and a credential revoked at the provider still reads
          `connected` here until something asks.
        */}
        <Button
          label={reverify.state.kind === "running" ? "Checking…" : "Re-verify"}
          accessibilityLabel="Check this bucket again"
          disabled={reverify.start === null || reverify.state.kind === "running"}
          onPress={() => reverify.start?.()}
          trailing={
            reverify.state.kind === "running" ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : null
          }
          testID="storage-reverify"
        />
        {/*
          One button, two honest labels. A Dropbox binding has no key to
          rotate, so offering "Rotate key" against one would name a credential
          that has never existed for it — the same lie the failure copy avoids
          by not telling a Dropbox owner to paste an access key.
        */}
        {isManaged ? null : (
          <Button
            label={isDropbox ? "Reconnect" : "Rotate key"}
            accessibilityLabel={
              isDropbox
                ? "Reconnect Dropbox, or connect a bucket instead"
                : "Paste a new access key and secret"
            }
            disabled={actions === undefined || disconnecting}
            onPress={onRebind}
            testID="storage-rebind"
          />
        )}
        {/*
          Two presses, and the second expires.

          This was one tap with no confirmation, sitting in the same row and at
          the same size as Re-verify and Rotate key — the two buttons people
          open this pane to use — differing only in border colour. What it does
          is delete the binding, and the encrypted secret goes with it: this
          pane says a few lines above that "the secret is never sent back down
          from the control plane", so reconnecting needs a value R2 or S3 shows
          exactly once, at creation. There is no undo and no copy of it here.
        */}
        {isManaged ? null : (
          <Button
            label={
              disconnecting
                ? "Disconnecting…"
                : disconnect.stage === "armed"
                  ? "Press again to disconnect"
                  : "Disconnect"
            }
            variant="danger"
            disabled={actions === undefined || disconnecting}
            onPress={disconnect.press}
            testID="storage-disconnect"
          />
        )}
      </Row>

      {/*
        The reversibility the product actually promises, at the moment of the
        press rather than in a paragraph scrolled off the top of the pane — and
        beside the one thing that is *not* reversible.
      */}
      {!isManaged && disconnect.stage === "armed" ? (
        <Hint>
          <Text variant="hint">
            Your bucket and every file in it are untouched — Context only forgets how
            to reach them, and you can reconnect by pasting a key. What it cannot give
            back is this secret: it is never sent down from the control plane, so you
            will need the one your provider showed you when you created the key.
          </Text>
        </Hint>
      ) : null}

      {!demo && actions === undefined ? (
        <Text variant="foot" style={styles.readOnly}>
          You have read-only access to this context&apos;s storage. Only an owner can
          re-verify, rotate, or disconnect it.
        </Text>
      ) : null}
      </Card>

    </>
  );
}

/** What Re-verify is doing, and what came back. */
function ReverifyStatus({ state }: { state: ReverifyState }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  switch (state.kind) {
    case "idle":
      return null;
    case "running":
      return (
        <Notice style={styles.notice}>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.text2} size="small" />
            <Text variant="check" role="status" style={styles.noticeBody}>
              Checking your bucket — listing it, writing a probe file, and cleaning up after
              itself.
            </Text>
          </View>
        </Notice>
      );
    case "ok":
      return (
        <Notice tone="ok" style={styles.notice}>
          <Text variant="check" role="status" style={styles.okText}>
            {state.message}
          </Text>
        </Notice>
      );
    case "timeout":
      return (
        <Notice tone="warn" style={styles.notice}>
          <Text variant="check" role="status" style={styles.warnText}>
            {state.message}
          </Text>
        </Notice>
      );
    case "failed":
      return (
        <FormError
          headline={state.failure.headline}
          next={joinSentences(state.failure.next, state.failure.detail)}
          style={styles.notice}
        />
      );
  }
}

/** "What to do" then "what the provider said", skipping whichever is missing. */
function joinSentences(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.length === 0 ? undefined : kept.join(" ");
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  /** A re-homed pane's row: what it is on the left, the way in on the right. */
  sectionRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  sectionRowText: { flexGrow: 1, flexShrink: 1, minWidth: 0 },

  headActions: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  danger: { marginTop: 36, marginBottom: 10, color: colors.critText },
  rowSub: { marginTop: 2 },
  detailsToggle: { marginTop: 10, alignSelf: "flex-start" },
  failure: { marginTop: 15 },
  notice: { marginTop: 15 },
  /** The same 24pt gap the vault importer above it takes from the card. */
  migration: { marginTop: 24 },
  noticeBody: { flex: 1, minWidth: 0 },
  okText: { color: colors.okText },
  warnText: { color: colors.warnText },
  actions: { marginTop: 17, gap: 9, flexWrap: "wrap" },
  readOnly: { marginTop: 12, lineHeight: leading(12.5, 1.6) },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
});
