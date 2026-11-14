/**
 * The old console's sections, drawn in the new console's page slot until each page is ported from
 * the artifact (a page drops its `Legacy` when it gains `render`). Kept in one file so deleting it
 * is the last step of the port: when no page names it, nothing imports this.
 */
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { View } from "react-native";
import { api } from "@context/convex/_generated/api";
import { CommunityLinks } from "../CommunityLinks";
import { EstateSection } from "../EstateSection";
import { FeaturesSection } from "../FeaturesSection";
import { unsetKnownSecrets } from "../report";
import { SearchSection } from "../SearchSection";
import { SecretsSection } from "../SecretsSection";
import { SignupAlerts } from "../SignupAlerts";
import { S } from "./state";

const days = () => Number(S.d) || 30;
const Col = ({ children }: { children: React.ReactNode }) => <View style={{ gap: 24 }}>{children}</View>;

function useUnset() {
  const secrets = useQuery(api.functions.admin.listSecrets, {});
  const unset = useMemo(() => unsetKnownSecrets(secrets ?? []), [secrets]);
  return { secrets, unset };
}

export const LegacyStorage = () => <EstateSection days={days()} />;
export const LegacySearch = () => <SearchSection />;
export function LegacyCredentials() {
  const { secrets, unset } = useUnset();
  return <SecretsSection secrets={secrets} unset={unset} />;
}
export const LegacyFlags = () => <FeaturesSection />;
export const LegacySettings = () => (
  <Col>
    <SignupAlerts />
    <CommunityLinks />
  </Col>
);
