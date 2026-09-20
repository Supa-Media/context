import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { FormError, Notice, TextField } from "../../../design/components/Input";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { selectedContext, type ConsoleData } from "../../types";
import {
  MODEL_PROVIDERS,
  canChangeModel,
  canConnectKey,
  connectionFor,
  keyProblem,
  type ModelConnection,
  type ModelProviderName,
} from "../../model/providers";
import { PanelHead } from "./PanelHead";

/**
 * The model account the agent spends.
 *
 * One card per provider, each either connected — with a fingerprint and a date,
 * never a fragment of the key — or holding a field to paste one into.
 *
 * ## What the copy may and may not claim
 *
 * This connects an **API key**, and the person's own account is billed. That
 * is stated once, plainly, at the top.
 *
 * What it deliberately does *not* say is the sentence an earlier draft of this
 * feature carried: that a Claude or ChatGPT subscription cannot be used by a
 * third-party app. Both halves are false — OpenAI ships "Sign in with ChatGPT"
 * for exactly that, and Anthropic's June 15 notice says it is *pausing* the
 * change it had announced, so Agent SDK and third-party usage still draw from a
 * subscription. Neither is what this screen connects today. A product that
 * tells somebody a thing is impossible, when it is merely not built here yet,
 * has spent trust it will want back when it does build it.
 *
 * ## Absent rather than disabled
 *
 * `connectProvider` is `editor` and above on the backend. A member, and the
 * landing page's console with no Convex client at all, are shown what is
 * connected and no control — `MeetingsDestination`'s rule, applied to a
 * credential rather than to a folder.
 */
export function ModelPanel({ data, sectioned }: { data: ConsoleData; sectioned: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const current = selectedContext(data);
  /*
    `useConvex` answers `undefined` where there is no provider — the landing
    page's copy of this console, and the render harnesses. Everything that
    queries or mutates lives in `ModelPanelLive`, a conditional *component*
    rather than a conditional hook. Same shape as `MeetingsDestination`.
  */
  const client = useConvex();
  const live = client !== undefined && current !== null;

  return (
    <>
      <PanelHead section="model" sectioned={sectioned}>
        The agent in this context answers with a model you connect. It is your own Anthropic
        or OpenAI key on your own account, so what it does is billed to you and nothing here
        marks it up.
      </PanelHead>

      <Notice tone="neutral">
        {/*
          Wrapped, not bare. `Notice` renders its children inside a `View`, and
          react-native-web puts a raw string there as a text node — which works
          on the web, warns in this jsdom suite, and is a hard error on native.
          The render test found it.
        */}
        <Text variant="rowSub">
          Your key is encrypted before it is stored, and decrypted only inside the gateway for
          the length of one request. It is never written into a note, never into your bucket,
          never into a log or a URL, and never onto this device.
        </Text>
      </Notice>

      {live ? (
        <ModelPanelLive
          workspaceId={current.id as Id<"workspaces">}
          role={current.role}
          slug={current.slug}
        />
      ) : (
        <Card style={styles.card}>
          <Text variant="rowSub">Connect a model from the app, signed in.</Text>
        </Card>
      )}

      <Text variant="foot" style={styles.foot}>
        The agent reads your notes through its own grant, so every read passes this context's
        privacy rules and lands in its audit trail — and it never edits a note. When it wants
        to, it files a proposal for you to look at.
      </Text>
    </>
  );
}

/** The half that queries and mutates. Rendered only where there is a client. */
function ModelPanelLive({
  workspaceId,
  role,
  slug,
}: {
  workspaceId: Id<"workspaces">;
  role: string | undefined;
  slug: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const connections = useQuery(api.functions.providers.listProviders, { workspaceId }) as
    | ModelConnection[]
    | undefined;
  const mayChange = canChangeModel(role);

  return (
    <View>
      {MODEL_PROVIDERS.map((provider) => (
        <ProviderCard
          key={provider.name}
          workspaceId={workspaceId}
          name={provider.name}
          label={provider.label}
          models={provider.models}
          where={provider.console}
          connection={connectionFor(connections, provider.name)}
          /*
            `undefined` is "not answered yet" and is not "none": the card says
            nothing about connectedness until the query lands, rather than
            drawing a Connect button over an account that is already connected.
          */
          answered={connections !== undefined}
          mayChange={mayChange}
        />
      ))}

      {mayChange ? null : (
        <Text variant="foot" style={styles.foot}>
          Only an owner or an editor of {slug} can connect or remove a model account.
        </Text>
      )}
    </View>
  );
}

function ProviderCard({
  workspaceId,
  name,
  label,
  models,
  where,
  connection,
  answered,
  mayChange,
}: {
  workspaceId: Id<"workspaces">;
  name: ModelProviderName;
  label: string;
  models: string;
  where: string;
  connection: ModelConnection | null;
  answered: boolean;
  mayChange: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const connect = useAction(api.functions.providers.connectProvider);
  const disconnect = useMutation(api.functions.providers.disconnectProvider);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const problem = draft.length === 0 ? null : keyProblem(draft);

  const close = () => {
    // The draft is cleared on the way out, not left in state for a later
    // render to put back on the glass. It is a key.
    setDraft("");
    setFailure(null);
    setEditing(false);
  };

  const save = () => {
    setBusy(true);
    setFailure(null);
    void connect({ workspaceId, provider: name, apiKey: draft })
      .then(close)
      .catch((reason: unknown) => {
        /*
          The control plane's own sentence. `connectProvider` refuses with
          messages written to be shown — and written, deliberately, never to
          quote the key back. Replacing them with "try again" would hide the
          only thing that says what to fix.
        */
        setFailure(reason instanceof Error ? reason.message : "That key did not save.");
        setDraft("");
      })
      .finally(() => setBusy(false));
  };

  const remove = () => {
    setBusy(true);
    setFailure(null);
    void disconnect({ workspaceId, provider: name })
      .catch((reason: unknown) =>
        setFailure(reason instanceof Error ? reason.message : "That did not disconnect."),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Card style={styles.card}>
      <Row>
        <Grow>
          <Text variant="rowTitle">{label}</Text>
          <Text variant="rowSub">
            {connection === null ? models : `${models} · added ${whenAdded(connection.connectedAt)}`}
          </Text>
        </Grow>
        {answered && connection !== null ? <Pill tone="ok">Connected</Pill> : null}
      </Row>

      {connection === null ? null : (
        <Row style={styles.factRow}>
          <Grow>
            <Text variant="eyebrow">Key</Text>
            {/*
              Eight hex of the key's SHA-256, and never the last four characters
              of the key itself. A hash rather than a fragment, which
              `appSecrets` decided first: what appears in a screenshot must not
              be part of the real value — and this one was issued by somebody
              else's console, so a leaked fragment points at a secret we cannot
              rotate.
            */}
            <Text variant="mono" style={styles.fingerprint}>
              {connection.fingerprint}
            </Text>
          </Grow>
          {mayChange ? (
            <Button
              label="Disconnect"
              accessibilityLabel={`Disconnect the ${label} account`}
              disabled={busy}
              onPress={remove}
              testID={`model-disconnect-${name}`}
            />
          ) : null}
        </Row>
      )}

      {mayChange && answered && connection === null && !editing ? (
        <Row style={styles.factRow}>
          <Grow>
            <Text variant="rowSub">Paste a key from {where}.</Text>
          </Grow>
          <Button
            label="Connect"
            accessibilityLabel={`Connect an ${label} account`}
            onPress={() => setEditing(true)}
            testID={`model-connect-${name}`}
          />
        </Row>
      ) : null}

      {editing ? (
        <View style={styles.form}>
          <TextField
            label={`${label} API key`}
            hint={`From ${where}. It is stored encrypted and never shown again.`}
            error={problem ?? undefined}
            value={draft}
            onChangeText={setDraft}
            autoCapitalize="none"
            autoCorrect={false}
            // A key is a secret being typed into a screen somebody may be
            // sharing. It is masked, and it is not offered to a password
            // manager as a password for this site, which it is not.
            secureTextEntry
            testID={`model-key-${name}`}
          />
          <Row style={styles.formRow}>
            <Grow>{null}</Grow>
            <Button label="Cancel" onPress={close} disabled={busy} />
            <Button
              label={busy ? "Connecting…" : "Connect"}
              variant="accent"
              disabled={busy || !canConnectKey(draft)}
              onPress={save}
              testID={`model-save-${name}`}
            />
          </Row>
        </View>
      ) : null}

      {failure === null ? null : <FormError headline={failure} />}
    </Card>
  );
}

/**
 * When an account was connected, in the words a person uses.
 *
 * A date rather than a time: nobody needs the minute they pasted a key, and a
 * relative string would make this row change under a reader who is looking at
 * it for a different reason.
 */
function whenAdded(at: number): string {
  try {
    return new Date(at).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    // A runtime with no `Intl` data is a worse row, never a crashed panel.
    return "earlier";
  }
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { marginTop: space.x3 },
    factRow: { marginTop: space.x3 },
    form: { marginTop: space.x3, gap: space.x3 },
    formRow: { gap: space.x2 },
    fingerprint: { color: colors.muted },
    foot: { marginTop: space.x3, color: colors.muted },
  });
