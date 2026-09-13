import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useConvex } from "convex/react";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../../design/components/Button";
import { Card, Row } from "../../design/components/Card";
import { Dot } from "../../design/components/Dot";
import { Check, FieldGrid, Hint } from "../../design/components/Field";
import { FormError, Notice } from "../../design/components/Input";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { relativeTime } from "../format";
import { PaneHead } from "../ConsoleShell";
import { PanelHead } from "../settings/panels/PanelHead";
import { atName } from "../format";
import { EmailPanel } from "../settings/panels/EmailPanel";
import { CalendarPanel } from "../settings/panels/CalendarPanel";
import { ChatsPanel } from "../settings/panels/ChatsPanel";
import { MeetingsPanel } from "../settings/panels/MeetingsPanel";
import { FastSearchCard } from "../search/FastSearchCard";
import type { CheckoutOutcome } from "@context/shared";
import { OverviewPanel } from "../settings/panels/OverviewPanel";
import { PremiumPanel } from "../settings/panels/PremiumPanel";
import { MembersSection } from "../members/MembersSection";
import { GroupsPanel } from "../settings/panels/GroupsPanel";
import { PrivacyPanel } from "../settings/panels/PrivacyPanel";
import { shareBackSuggestions } from "../members/members";
import { SharedLinksPanel } from "../settings/panels/SharedLinksPanel";
import { AdvancedPanel } from "../settings/panels/AdvancedPanel";
import { PluginsPanel } from "../settings/panels/PluginsPanel";
import { selectedContext, type ConsoleData, type ConsoleStorage, type StorageActions } from "../types";
import type { SettingsSectionKey } from "../settings/sections";
import { useArming } from "../useArming";
import { ConnectForm } from "../storage/ConnectForm";
import { StorageChoice } from "../storage/StorageChoice";
import { VaultImport } from "../storage/VaultImport";
import { forcePathStyleToAddressing } from "../storage/connect";
import { describeStorageFailure } from "../storage/errors";
import { useReverify } from "../storage/useReverify";
import type { ReverifyState } from "../storage/reverify";
import { StorageMigrationCard } from "../storage/StorageMigration";
import { useManagedOffer } from "../../onboarding/useManagedOffer";
import { ManagedConfirm } from "../../onboarding/steps/ManagedConfirm";

/**
 * A context's settings: its bucket, its credentials, and its ingestion rules.
 *
 * This used to be a top-level "Storage" pane sitting beside Map and
 * Connections. It was in the wrong place, and not only visually — a storage
 * binding hangs off a `workspaceId`, never a `userId`, so two contexts can and
 * do point at two different buckets. A pane at app level was quietly claiming
 * there is one. It is reached now from the gear beside the storage chip in
 * Browse, which is where somebody looking at `R2 · brain` is already looking.
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
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const storage = data.storage;
  const actions = data.storageActions;
  const current = selectedContext(data);
  const [rebinding, setRebinding] = useState(false);

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
        description="Storage and ingestion rules. They belong here, not to your account — every other brain or workspace can point somewhere else entirely."
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
        {storage?.provider === "dropbox"
          ? "Your Dropbox, your folder. Unlink Context in your Dropbox account settings and it loses access immediately — every file stays exactly where it is."
          : "Your bucket, your credentials. Revoke the key at your provider and Context loses access immediately — no export needed."}
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
                ? "Context stores nothing of its own. Point it at a folder in your Dropbox, or at an S3-compatible bucket you own, and every note stays there."
                : "Only an owner of this context can connect storage to it."}
            </Text>
          </Card>
        )
      ) : rebinding && actions ? (
        // Two different jobs behind one flag, decided by what is connected now.
        //
        // Rotating an S3 key must not mean retyping an endpoint, so that path
        // gets the form back with everything but the secret prefilled. A
        // Dropbox binding has no key to rotate and nothing to prefill — what
        // its owner wants is either the same consent screen again or a bucket
        // instead, which is exactly the pair `StorageChoice` draws.
        storage.provider === "dropbox" ? (
          <SettingsStorageChoice
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
        <BindingCard
          storage={storage}
          actions={actions}
          demo={data.demo}
          onRebind={() => setRebinding(true)}
        />
      )}

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

        The console's *notice* takes one further condition — a connected
        binding, `storageMigrationWorthOffering` — and this row deliberately
        does not. The asymmetry is the difference between the two surfaces
        rather than an oversight in one of them: an offer that appears in
        front of somebody has to earn the interruption, while a row they went
        looking for should still be here when a probe is mid-flight. Neither
        condition decides who may run it.
      */}
      {data.files.updateStorageLayout !== undefined ? (
        <View style={styles.migration}>
          <StorageMigrationCard run={data.files.updateStorageLayout} />
        </View>
      ) : null}

      </>
      ) : null}

      {show("overview") ? (
      <>
      <PanelHead section="overview" sectioned={section !== undefined}>
        {current?.kind === "shared"
          ? "A workspace several people share. It has no address of its own — only a personal brain can be sent mail."
          : "One bucket, one set of privacy rules, one history."}
      </PanelHead>
      {/*
        The second half of that sentence used to be "— and every other brain
        or workspace can point somewhere else entirely", which explains the
        tenancy model to somebody who is already inside one context looking at
        their own bucket, and cost three lines at the top of the section
        settings opens on.
      */}
      <OverviewPanel data={data} onSelect={onSelect} />
      </>
      ) : null}

      {show("premium") ? (
      <>
      <PanelHead section="premium" sectioned={section !== undefined}>
        What this context costs, and what changes if it costs something.
        Downloading everything is free on either plan and still works after
        you cancel.
      </PanelHead>
      <PremiumPanel data={data} section={section} returned={returned} />
      </>
      ) : null}

      {show("people") ? (
      <>
      <PanelHead section="people" sectioned={section !== undefined}>
        Everyone who can reach this context, and what each of them may do. Write access
        is never implied by read — a role is granted, not inherited.
      </PanelHead>
      <MembersSection
        view={data.members}
        viewerRole={current?.role}
        /*
          Defensive because this pane is rendered from fixtures that carry only
          the half of `members` their own subject needs — the Dropbox screens
          test among them. A missing invitations list is "nobody to suggest",
          not a crash in a section that test is not about.
        */
        shareBackWith={
          Array.isArray(data.members?.invitations)
            ? shareBackSuggestions(data.contexts, data.members)
            : []
        }
      />
      </>
      ) : null}

      {show("shares") ? (
      <>
      <PanelHead section="shares" sectioned={section !== undefined}>
        Every note you have handed to somebody outside this context, one link at a
        time — with a Revoke beside each.
      </PanelHead>
      <SharedLinksPanel view={data.shares} />
      </>
      ) : null}

      {/*
        Its own file, and its own module beneath that. Privacy is the section
        whose every sentence is a claim about who can read somebody's notes, so
        the rows, the words and the one control all come from pure modules a
        test can drive — see `features/console/privacy/`.
      */}
      {/*
        Between People and Shared links, which is where it belongs: the three
        answer "who is here", "who is named as a set", and "what did I hand
        out one note at a time" in widening order.
      */}
      {show("groups") ? (
      <>
      <PanelHead section="groups" sectioned={section !== undefined}>
        A named set of people, so a folder rule can point at "leads" rather
        than at three usernames you have to keep in step by hand.
      </PanelHead>
      <GroupsPanel
          view={data.groups}
          members={data.members.members}
        slug={current?.slug.replace(/^@/, "") ?? ""}
      />
      </>
      ) : null}

      {show("privacy") ? <PrivacyPanel data={data} inline={section === undefined} /> : null}

      {/*
        Four panels where there was one section, each in its own file.

        "Mail, calendar & chats" was one block because a Google *account*
        carries Gmail, Calendar and Chat together — our plumbing, not
        anybody's question. Each of these answers one question a person
        actually has, and the bodies live under `settings/panels/` so this file
        gains four `show()` branches rather than four screens of copy. See
        `settings/sections.ts` for the argument.
      */}
      {show("email") ? <EmailPanel data={data} sectioned={section !== undefined} /> : null}
      {show("calendar") ? <CalendarPanel data={data} sectioned={section !== undefined} /> : null}
      {show("chats") ? <ChatsPanel data={data} sectioned={section !== undefined} /> : null}
      {show("meetings") ? <MeetingsPanel data={data} sectioned={section !== undefined} /> : null}

      {show("search") ? (
      <>
      <PanelHead section="search" sectioned={section !== undefined}>
        Where this context&apos;s search is answered from. Your Markdown never moves:
        the index is a copy that can be deleted and rebuilt, and it is off until an
        owner turns it on.
      </PanelHead>

      {/*
        Under the same gear as storage and ingestion, and here rather than at
        app level for the same reason this whole pane moved: what it switches
        is per context. Two brains can be answered from two different places,
        and a switch above the context picker would claim there is one setting
        for all of them.
      */}
      <FastSearchCard view={data.fastSearch} demo={data.demo} />
      </>
      ) : null}

      {show("plugins") ? (
      <>
      <PanelHead section="plugins" sectioned={section !== undefined}>
        The Obsidian plugins already in this context&apos;s bucket, and what each one can do
        here. Context reads <Text variant="mono">.obsidian/</Text> and never writes to it —
        nothing on this screen changes your vault.
      </PanelHead>
      <PluginsPanel view={data.plugins} grants={data.pluginGrants} browse={data.pluginBrowse} runtime={data.pluginRuntime} />
      </>
      ) : null}

      {show("advanced") ? (
      <>
      <PanelHead section="advanced" sectioned={section !== undefined}>
        Background folder moves, audit trail, and key export. Most people never need this.
      </PanelHead>
      <AdvancedPanel view={data.advanced} demo={data.demo} />
      </>
      ) : null}

    </View>
  );
}

/** Billing is optional in render fixtures and self-hosted builds. */
function SettingsStorageChoice({
  workspaceId,
  contextName,
  connect,
  onCancel,
  onOpenPremium,
}: {
  workspaceId: string;
  contextName: string;
  connect: StorageActions["connect"];
  onCancel?: () => void;
  onOpenPremium?: () => void;
}) {
  const client = useConvex();
  if (client === undefined) {
    return <StorageChoice workspaceId={workspaceId} connect={connect} onCancel={onCancel} />;
  }
  return (
    <SettingsStorageChoiceLive
      workspaceId={workspaceId as Id<"workspaces">}
      contextName={contextName}
      connect={connect}
      onCancel={onCancel}
      onOpenPremium={onOpenPremium}
    />
  );
}

function SettingsStorageChoiceLive({
  workspaceId,
  contextName,
  connect,
  onCancel,
  onOpenPremium,
}: {
  workspaceId: Id<"workspaces">;
  contextName: string;
  connect: StorageActions["connect"];
  onCancel?: () => void;
  onOpenPremium?: () => void;
}) {
  const managed = useManagedOffer({ workspaceId, returned: null, origin: "settings" });

  if (managed.mode === "confirm" && managed.status !== null) {
    return (
      <ManagedConfirm
        status={managed.status}
        contextName={contextName}
        state={managed.session}
        failure={managed.failure}
        onToggle={managed.toggle}
        onContinue={managed.proceed}
        onBack={managed.back}
      />
    );
  }

  return (
    <StorageChoice
      workspaceId={workspaceId}
      connect={connect}
      onCancel={onCancel}
      managed={!managed.available ? undefined : {
        price: managed.price,
        onChoose: () => {
          if (managed.paid) {
            if (managed.status?.selected.managedStorage) onOpenPremium?.();
            else {
              managed.toggle("managedStorage", true);
              onOpenPremium?.();
            }
            return;
          }
          managed.choose();
        },
      }}
    />
  );
}

/** Existing owners get the same create-only importer after storage is live. */
function SettingsVaultImport({ workspaceId }: { workspaceId: string }) {
  const client = useConvex();
  if (client === undefined) return null;
  return (
    <View style={{ marginTop: 24 }}>
      <VaultImport
        workspaceId={workspaceId as Id<"workspaces">}
        existingData
        testIDPrefix="settings-vault"
      />
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
export function StatusPill({ storage }: { storage: ConsoleStorage }) {
  if (storage.connected) {
    return (
      <Pill tone="ok" leading={<Dot tone="ok" />}>
        Connected
      </Pill>
    );
  }
  const broken = storage.status === "error";
  return (
    <Pill tone="warn" leading={<Dot tone={broken ? "crit" : "warn"} />}>
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
  // Which account, not just which provider — the two things the field was
  // stored for are saying whose Dropbox this is and noticing a *different*
  // one arriving on a reconnect. This is a live query value, so a reconnect
  // that changes the account replaces this row rather than leaving a stale
  // one behind.
  if (isDropbox && storage.dropboxAccountId) {
    fields.push({ label: "Connected as", value: storage.dropboxAccountId });
  }
  if (storage.bucket) fields.push({ label: "Bucket", value: storage.bucket });
  if (storage.endpoint) fields.push({ label: "Endpoint", value: storage.endpoint });
  if (storage.accessKey) fields.push({ label: "Access key", value: storage.accessKey });
  if (storage.rootPrefix) {
    fields.push({ label: isDropbox ? "Folder" : "Root prefix", value: storage.rootPrefix });
  } else if (isDropbox) {
    // Worth a row of its own rather than an absence: "which folder is this?"
    // is the first question somebody has about a Dropbox connection, and the
    // answer — the app folder Dropbox made for us, not their whole account —
    // is the thing the consent screen promised.
    fields.push({ label: "Folder", value: "Context's own app folder" });
  }
  // Shown only when somebody actually had to answer it — the same restraint the
  // connect form applies to asking.
  if (addressing !== null) {
    fields.push({
      label: "Addressing",
      value: addressing === "path" ? "bucket in the path" : "bucket in the hostname",
    });
  }

  const failure =
    storage.status === "error"
      ? describeStorageFailure(storage.errorCode, storage.lastError, storage.provider)
      : null;

  return (
    <Card>
      <FieldGrid fields={fields} />

      <View style={styles.checks}>
        {/*
          Every line in this block is a claim about somebody's own bucket, so
          each one has to come from something that looked.

          Reachability comes from the binding's status, which the verify probe
          sets by listing the bucket and writing to it. It says "at the last
          check" because that is the only tense it can honestly use: a key
          revoked at the provider a minute ago still reads `connected` here
          until something asks again. An `unverified` binding has never been
          checked at all, so it gets an amber row pointing at Re-verify rather
          than a green one — the status pill above already says "Not verified",
          and a green check disagreeing with it is how a pane loses its
          credibility.

          The object count is rendered only when something counted. Nothing
          does today, so on the live console `storage.objectCount` is undefined
          and the sentence simply ends. See `ConsoleStorage`.
        */}
        {failure !== null ? (
          <Check tone="warn">Last check couldn&apos;t confirm the bucket was usable</Check>
        ) : storage.connected ? (
          <Check tone="ok">
            {storage.objectCount === undefined
              ? "Reachable at the last check"
              : `Reachable at the last check — ${storage.objectCount} objects`}
          </Check>
        ) : (
          <Check tone="warn">
            Not checked since it was connected — Re-verify to confirm it is reachable
          </Check>
        )}
        {storage.conditionalWrite ? (
          <Check tone="ok">Conditional writes verified — concurrent edits are safe</Check>
        ) : (
          <Check tone="warn">
            Conditional writes unavailable — this provider cannot detect a concurrent edit
          </Check>
        )}
        {/*
          PARA detection and versioning state: absent, not "unknown". Nothing
          walks the bucket for PARA folders or reads a versioning setting, and a
          row saying "we don't know whether versioning is on" is noise on a card
          somebody opened to check their credentials. An absent row is quiet;
          the invented ones told a user with versioning already on to go and
          turn it on.
        */}
        {/*
          The note count, dated from the walk that produced it.
          `noteCountedAt` is stored apart from `lastVerifiedAt` precisely so
          this row can say when the number was taken — a months-old count
          printed bare is the #25 shape again, a plausible figure about
          somebody's bucket with nothing behind it. A truncated walk is a floor
          and says so; absent, as ever, is a missing row rather than a zero.
        */}
        {storage.noteCount === undefined ? null : (
          <Check tone="ok">
            {`${storage.noteCount.toLocaleString("en-US")}${
              storage.noteCountTruncated ? "+" : ""
            } notes${
              storage.noteCountedAt === undefined
                ? ""
                : ` — counted ${relativeTime(storage.noteCountedAt, Date.now())}`
            }`}
          </Check>
        )}
        {storage.paraPresent === undefined ? null : storage.paraPresent ? (
          <Check tone="ok">PARA structure present</Check>
        ) : (
          <Check tone="warn">No PARA folders found — Context works either way</Check>
        )}
        {storage.versioningOn === undefined ? null : storage.versioningOn ? (
          <Check tone="ok">Versioning is on — point-in-time recovery available</Check>
        ) : (
          <Check tone="warn">
            Versioning is off — turn it on at your provider for point-in-time recovery
          </Check>
        )}
      </View>

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
  rowSub: { marginTop: 2 },
  checks: {
    marginTop: 15,
    gap: 8,
  },
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
