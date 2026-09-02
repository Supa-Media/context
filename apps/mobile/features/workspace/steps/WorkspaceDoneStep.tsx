import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { CopyField } from "../../design/components/CopyField";
import { Check } from "../../design/components/Field";
import { Notice } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { endpointForContext } from "../../console/endpoints";
import { MCP_ENDPOINT } from "../../console/placeholderData";
import {
  describeInvitesSent,
  doneAddressedCheck,
  doneEndpointNote,
  doneLede,
  peopleCaveat,
} from "../create";
import type { CreateWorkspaceController } from "../useCreateWorkspace";

/**
 * Step 5 — what exists now, and what each person has to do.
 *
 * ## The endpoint is the workspace's, not the person's
 *
 * A grant covers **one context**, so every member connects their own client to
 * this workspace separately and each grant is separately revocable. That is a
 * thing people get wrong in exactly one direction — they paste the endpoint
 * into a channel and assume it is now connected for the team — so this screen
 * says who has to do what, rather than handing over a string and stopping.
 *
 * ## What it will not say
 *
 * It does not report how many people now have access, because the answer is
 * one. Invitations are outstanding until they are answered; see
 * `describeInvitesSent`.
 */
export function WorkspaceDoneStep({
  controller,
  onOpenWorkspace,
}: {
  controller: CreateWorkspaceController;
  onOpenWorkspace: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const slug = controller.created?.slug ?? "the workspace";
  // The workspace's **own** URL, not the bare endpoint: a grant covers one
  // context, so the thing worth copying is the one that names this one. `null`
  // for a self-hosted deployment whose routing this screen must not guess at —
  // see `endpointForContext` — in which case the plain endpoint is still true.
  const endpoint = endpointForContext(MCP_ENDPOINT, slug) ?? MCP_ENDPOINT;
  const sent = controller.sendResult?.sent.length ?? 0;
  const invitesLine = describeInvitesSent(sent);
  const caveat = peopleCaveat(controller.shape);

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        {doneLede(slug)}
      </Text>

      {caveat ? (
        <Notice tone="warn" style={styles.caveat}>
          <Text variant="check" role="status" style={styles.warnText}>
            {caveat}
          </Text>
        </Notice>
      ) : null}

      <Card>
        <View style={styles.checks}>
          <Check tone="ok">
            {doneAddressedCheck(slug)}
          </Check>
          <Check tone="ok">
            Its bucket, its access map and its audit trail are its own. Revoking its credential
            leaves your brain untouched, and vice versa.
          </Check>
          <Check tone="ok">
            Its folders are readable by its members. A folder marked private in privacy.md is
            held back to owners.
          </Check>
        </View>
      </Card>

      {invitesLine ? (
        <Text variant="rowSub" style={styles.invites}>
          {invitesLine}
        </Text>
      ) : (
        <Text variant="rowSub" style={styles.invites}>
          Nobody is invited yet, so the workspace has one member: you. Invitations are in its
          members list, under the gear at the foot of the file tree.
        </Text>
      )}

      <Text variant="eyebrow" style={styles.head}>
        The workspace&apos;s MCP endpoint
      </Text>
      <CopyField
        value={endpoint}
        label="Copy the MCP endpoint"
        testID="workspace-done-endpoint"
      />
      <Text variant="foot" style={styles.under}>
        {doneEndpointNote(slug)}
      </Text>

      <View style={styles.actions}>
        <Button
          label={`Open @${slug}`}
          variant="white"
          onPress={onOpenWorkspace}
          testID="workspace-done-open"
        />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  lede: { marginBottom: 18, lineHeight: leading(12.5, 1.7) },
  caveat: { marginBottom: 16 },
  warnText: { color: colors.warnText },
  checks: { gap: 10 },
  invites: { marginTop: 16, lineHeight: leading(12.5, 1.7) },
  head: { marginTop: 22, marginBottom: 8 },
  under: { marginTop: 10, lineHeight: leading(12.5, 1.7) },
  actions: { marginTop: 22, flexDirection: "row", alignItems: "center", gap: 14 },
});
