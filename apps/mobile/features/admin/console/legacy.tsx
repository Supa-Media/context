/**
 * The old console's sections, drawn in the new console's page slot until each page is ported from
 * the artifact (a page drops its `Legacy` when it gains `render`). Kept in one file so deleting it
 * is the last step of the port: when no page names it, nothing imports this.
 */
import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { View } from "react-native";
import { api } from "@context/convex/_generated/api";
import { ActivitySection } from "../ActivitySection";
import { AgentSection } from "../AgentSection";
import { AiCostsSection } from "../AiCostsSection";
import { GrowthSection } from "../GrowthSection";
import { unsetKnownSecrets } from "../report";
import { TexBasics } from "../TexBasics";
import { UsageSection } from "../UsageSection";
import { S, go } from "./state";

const days = () => Number(S.d) || 30;
const Col = ({ children }: { children: React.ReactNode }) => <View style={{ gap: 24 }}>{children}</View>;

function useUnset() {
  const secrets = useQuery(api.functions.admin.listSecrets, {});
  const unset = useMemo(() => unsetKnownSecrets(secrets ?? []), [secrets]);
  return { secrets, unset };
}

export function LegacyGrowth() {
  const { unset, secrets } = useUnset();
  return (
    <Col>
      <TexBasics />
      <GrowthSection days={days()} unsetCount={secrets === undefined ? 0 : unset.length} onCredentials={() => go("credentials")} />
    </Col>
  );
}
export const LegacyHome = LegacyGrowth;
export const LegacyUsage = () => (
  <Col>
    <UsageSection days={days()} />
    <ActivitySection days={days()} />
  </Col>
);
export function LegacyTurns() {
  const [open, setOpen] = useState<string | null>(null);
  return <AgentSection openId={open} onOpen={setOpen} />;
}
export function LegacyCosts() {
  const [open, setOpen] = useState<string | null>(null);
  return <AiCostsSection days={days()} openId={open} onOpen={setOpen} />;
}
