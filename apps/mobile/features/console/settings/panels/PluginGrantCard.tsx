import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Dot } from "../../../design/components/Dot";
import { Hint } from "../../../design/components/Field";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { useArming } from "../../useArming";
import {
  DEFAULT_CAPABILITIES,
  GRANTABLE_CAPABILITIES,
  STALE_NOTE,
  approvalOffer,
  capabilityDetail,
  capabilityLabel,
  isDestructive,
  offerNote,
  standingFor,
  standingPill,
  type GrantsView,
  type PluginCapability,
} from "../../plugins/grants";
import type { ConsolePlugin } from "../../plugins/plugins";

/**
 * What one plugin is allowed to do, and the control that changes it.
 *
 * Opens closed. A plugin list is a list, and a consent form unfurled under every
 * row would turn a page somebody came to read into a page they have to dismiss.
 * Pressing **Review access** is what opens it, which is also the honest verb for
 * what a person is being asked to do.
 *
 * Three things this component will not do, each a rule rather than a
 * preference:
 *
 *  - **It never offers an approval that cannot succeed.** `approvalOffer`
 *    decides, and a networked plugin gets the sentence rather than a button that
 *    returns `NETWORK_RUNTIME_UNAVAILABLE` when pressed.
 *  - **It never pre-ticks a capability that writes.** `DEFAULT_CAPABILITIES` is
 *    read-only; raising a plugin above reading is something a person does on
 *    purpose, once, with the sentence in front of them.
 *  - **It never reads a grant as a running plugin.** Approved means allowed. It
 *    does not mean loaded, and there is no state here that says otherwise.
 */
export function PluginGrantCard({
  plugin,
  view,
}: {
  plugin: ConsolePlugin;
  view: GrantsView;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<PluginCapability[]>([...DEFAULT_CAPABILITIES]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /*
    Two presses, like every other Revoke in this console. A grant is the only
    thing standing between a plugin and somebody's notes, and taking it away is
    cheap to do and expensive to do by accident on a phone.
  */
  const revokeArm = useArming(() => {
    void view.actions?.revoke(plugin.id);
  });

  const grants = view.grants;
  if (grants === undefined) return null;

  const standing = standingFor(plugin, grants);
  const pill = standingPill(standing);
  const offer = approvalOffer(plugin);
  const note = offerNote(offer);
  const actions = view.actions;

  const fingerprint = plugin.bundleFingerprint;
  const canApprove = offer.kind === "available" && actions !== undefined && fingerprint !== null;

  /*
    Nothing granted, nothing grantable, nothing to press — so draw nothing.

    Without this, all nineteen won't-run rows gain "There is nothing to approve:
    this plugin cannot run in Context", directly under the line that already told
    them to keep it in Obsidian. A sentence repeated on every row that cannot act
    is a sentence people stop reading, including on the rows where it carries
    something — the networked one, and the one whose bundle could not be read.
  */
  if (standing.kind === "none" && standing.revokedAt === undefined) {
    if (offer.kind === "not-runnable") return null;
    if (!canApprove && offer.kind === "available") return null;
  }

  async function approve() {
    if (!canApprove || fingerprint === null) return;
    setBusy(true);
    setFailure(null);
    try {
      await actions?.approve({
        pluginId: plugin.id,
        bundleFingerprint: fingerprint,
        capabilities: chosen,
      });
      setOpen(false);
    } catch (error) {
      /*
        The server's own refusal, kept. `approvePlugin` has real things to say —
        `PLUGIN_CHANGED` when the bundle moved between the scan and the press,
        `PLUGIN_NOT_RUNNABLE`, `NETWORK_RUNTIME_UNAVAILABLE` — and a form that
        closes silently on any of them looks like a button that does nothing.
      */
      setFailure(approvalFailure(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View testID={`plugin-grant-${plugin.id}`} style={styles.wrap}>
      <Row style={styles.head}>
        <Grow>
          {standing.kind === "active" ? (
            <Text variant="rowSub">
              {`Allowed to: ${standing.grant.capabilities.map(capabilityLabel).join(" · ").toLowerCase()}`}
            </Text>
          ) : null}
          {standing.kind === "stale" ? <Text variant="rowSub">{STALE_NOTE}</Text> : null}
          {note ? <Text variant="rowSub">{note}</Text> : null}
        </Grow>
        {pill ? (
          <Pill
            tone={pill.tone}
            dashed={pill.dashed}
            leading={pill.tone === "ok" ? <Dot tone="ok" /> : undefined}
          >
            {pill.label}
          </Pill>
        ) : null}
      </Row>

      <Row style={styles.controls}>
        {canApprove ? (
          <Button
            label={
              standing.kind === "stale"
                ? "Review the new bundle"
                : standing.kind === "active"
                  ? "Change what it can do"
                  : "Review access"
            }
            onPress={() => setOpen((was) => !was)}
          />
        ) : null}
        {standing.kind !== "none" && actions !== undefined ? (
          <Button
            label={revokeArm.stage === "armed" ? "Revoke — press again" : "Revoke"}
            variant="danger"
            onPress={revokeArm.press}
          />
        ) : null}
      </Row>

      {open && canApprove ? (
        <Card style={styles.form} testID={`plugin-approve-${plugin.id}`}>
          <Text variant="rowTitle">What may it do?</Text>
          <Text variant="rowSub" style={styles.lead}>
            Everything starts at reading. Anything that changes your notes is off until you turn
            it on here.
          </Text>

          {GRANTABLE_CAPABILITIES.map(
            (capability) => {
              const on = chosen.includes(capability);
              return (
                <Pressable
                  key={capability}
                  role="checkbox"
                  aria-checked={on}
                  aria-label={capabilityLabel(capability)}
                  testID={`capability-${capability}`}
                  style={styles.capability}
                  onPress={() =>
                    setChosen((was) =>
                      on ? was.filter((one) => one !== capability) : [...was, capability],
                    )
                  }
                >
                  <View style={[styles.box, on && styles.boxOn]}>
                    {on ? (
                      <Text variant="check" style={styles.tick}>
                        ✓
                      </Text>
                    ) : null}
                  </View>
                  <Grow>
                    <Text variant="rowTitle">{capabilityLabel(capability)}</Text>
                    <Text variant="rowSub">{capabilityDetail(capability)}</Text>
                  </Grow>
                  {isDestructive(capability) ? <Pill tone="warn">Changes notes</Pill> : null}
                </Pressable>
              );
            },
          )}

          <Hint style={styles.hint}>
            <Text variant="hint">
              This is bound to the exact bundle in your bucket right now. If the plugin updates,
              the new version has no access until you review it — nothing inherits an answer you
              gave about different code.
            </Text>
          </Hint>

          <Row style={styles.controls}>
            <Button
              label={busy ? "Approving…" : "Approve this bundle"}
              variant="white"
              disabled={busy || chosen.length === 0}
              onPress={() => void approve()}
            />
            <Button label="Cancel" onPress={() => setOpen(false)} />
          </Row>
          {failure ? (
            <Text variant="error" testID={`plugin-approve-failed-${plugin.id}`}>
              {failure}
            </Text>
          ) : null}

          {chosen.length === 0 ? (
            <Text variant="rowSub" style={styles.lead}>
              A grant with nothing in it would let the plugin load and do nothing. Pick at least
              one, or leave it unapproved.
            </Text>
          ) : null}
        </Card>
      ) : null}
    </View>
  );
}

/**
 * What to show when an approval is refused.
 *
 * A `ConvexError` carries the backend's own `message`, which is written for this
 * reader — "The plugin changed; review it again" is more use than anything this
 * component could compose. Anything else falls back to a sentence that says what
 * did not happen, because "an error occurred" tells somebody nothing about
 * whether their plugin is now approved.
 */
function approvalFailure(error: unknown): string {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message.trim();
  }
  if (typeof data === "string" && data.trim() !== "") return data.trim();
  return "That approval did not go through, so nothing was granted. Read the plugins again and try once more.";
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { marginTop: 9, gap: 8 },
  head: { alignItems: "flex-start", gap: 12 },
  controls: { gap: 8, flexWrap: "wrap", alignItems: "center" },
  form: { marginTop: 4, gap: 10, backgroundColor: colors.surface3 },
  lead: { marginTop: 4 },
  hint: { marginTop: 4 },
  capability: { flexDirection: "row", alignItems: "flex-start", gap: 11, paddingVertical: 7 },
  box: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    marginTop: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  tick: { color: colors.white, fontWeight: "700" },
});
