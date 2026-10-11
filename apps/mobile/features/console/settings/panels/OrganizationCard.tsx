import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Switch } from "../../../design/components/Switch";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles } from "../../../design/theme";
import { PickMenu } from "./PickMenu";
import {
  NO_OFFER,
  ORGANIZATION_INTRO,
  ROLE_LABELS,
  domainTitle,
  joinedLine,
  offerLine,
  type DomainRole,
} from "./organization";

/**
 * "Your organization" (Dev2, 2026-10-09, board s3): a shared workspace opened
 * to everyone at an email domain. Owners of shared workspaces only; the
 * server refuses everybody else and decides which domains may be added. One
 * switch per domain, and what the people joining that way can do.
 */
export function OrganizationCard({ workspaceId }: { workspaceId: string }) {
  const styles = useThemedStyles(makeStyles);
  const id = workspaceId as Id<"workspaces">;
  const card = useQuery(api.functions.workspaceDomains.listWorkspaceDomains, { workspaceId: id });
  const addDomain = useMutation(api.functions.workspaceDomains.addWorkspaceDomain);
  const updateDomain = useMutation(api.functions.workspaceDomains.updateWorkspaceDomain);
  const removeDomain = useMutation(api.functions.workspaceDomains.removeWorkspaceDomain);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<unknown>) {
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError((failure as { data?: { message?: string } })?.data?.message ?? "That didn't work. Try again.");
    }
  }

  if (card === undefined) return null;
  const addable = card.offer.filter((row) => row.status === "ok");

  return (
    <View testID="organization">
      <Text variant="rowTitle" style={styles.head}>
        Your organization
      </Text>
      <Text variant="rowSub" style={styles.sub}>
        {ORGANIZATION_INTRO}
      </Text>
      <Card>
        {card.domains.map((row, index) => (
          <Row key={row.domain} divided={index > 0}>
            <Grow>
              <Text variant="rowTitle">{domainTitle(row.domain)}</Text>
              <Text variant="rowSub">{joinedLine(row.joined, row.enabled)}</Text>
            </Grow>
            <View style={styles.controls}>
              <PickMenu<DomainRole | "remove">
                label={ROLE_LABELS[row.role]}
                options={[
                  { key: "member", label: ROLE_LABELS.member },
                  { key: "editor", label: ROLE_LABELS.editor },
                  { key: "remove", label: "Remove domain", danger: true },
                ]}
                selected={row.role}
                onPick={(key) =>
                  void run(() =>
                    key === "remove"
                      ? removeDomain({ workspaceId: id, domain: row.domain })
                      : updateDomain({ workspaceId: id, domain: row.domain, role: key }),
                  )
                }
                accessibilityLabel={`What people at ${row.domain} can do`}
                testID={`organization-role-${index}`}
              />
              <Switch
                value={row.enabled}
                onValueChange={(enabled) => void run(() => updateDomain({ workspaceId: id, domain: row.domain, enabled }))}
                label={domainTitle(row.domain)}
                testID={`organization-switch-${index}`}
              />
            </View>
          </Row>
        ))}
        {adding ? (
          <View style={styles.offer}>
            {card.offer.length === 0 ? <Text variant="rowSub">{NO_OFFER}</Text> : null}
            {card.offer.map((row) => (
              <Row key={row.domain}>
                <Grow>
                  <Text variant="rowTitle">{row.domain}</Text>
                  <Text variant="rowSub">{offerLine(row.status, row.email)}</Text>
                </Grow>
                {row.status === "ok" ? (
                  <Button
                    label="Add"
                    variant="accent"
                    onPress={() =>
                      void run(async () => {
                        await addDomain({ workspaceId: id, domain: row.domain });
                        setAdding(false);
                      })
                    }
                    testID={`organization-add-${row.domain}`}
                  />
                ) : null}
              </Row>
            ))}
            <View style={styles.cancel}>
              <Button label="Cancel" onPress={() => setAdding(false)} />
            </View>
          </View>
        ) : (
          <Row divided={card.domains.length > 0}>
            <Grow>
              <Text variant="rowSub">
                {addable.length > 0 || card.offer.length === 0
                  ? "Let everyone at your organization in without inviting each person."
                  : "Every domain you sign in with is already here or can't be added."}
              </Text>
            </Grow>
            <Button label="Add a domain" onPress={() => setAdding(true)} testID="organization-add" />
          </Row>
        )}
      </Card>
      {error === null ? null : (
        <Text variant="error" role="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    head: { marginBottom: space.x1 },
    sub: { marginBottom: space.x3 },
    controls: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    offer: { paddingVertical: space.x2 },
    cancel: { paddingHorizontal: space.x3, paddingTop: space.x2, alignItems: "flex-start" },
    error: { marginTop: space.x2 },
  });
