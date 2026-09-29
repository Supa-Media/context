/**
 * The account menu's "Invite friends" and "Community" rows, and the dialog
 * the first one opens.
 *
 * The console frame is also drawn by fixtures and the homepage's visitor demo
 * with no Convex client, and a subscription there throws. So nothing here
 * subscribes unless the caller says the frame is live: `ReferralsWatch` is
 * only mounted then, and reports what the rows need back up as plain state.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Linking } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { InviteFriendsDialog } from "./InviteFriendsDialog";
import { discordLink, menuDetail } from "./invites";

interface ReferralFacts {
  inviteDetail?: string;
  communityUrl: string | null;
}

export interface ReferralMenuProps {
  onInviteFriends?: () => void;
  inviteDetail?: string;
  onOpenCommunity?: () => void;
}

export function useReferralMenu(live: boolean): { props: ReferralMenuProps; host: ReactNode } {
  const [facts, setFacts] = useState<ReferralFacts | null>(null);
  const [open, setOpen] = useState(false);
  if (!live) return { props: {}, host: null };
  const url = facts?.communityUrl ?? null;
  return {
    props: {
      onInviteFriends: () => setOpen(true),
      inviteDetail: facts?.inviteDetail,
      onOpenCommunity: url === null ? undefined : () => void Linking.openURL(url).catch(() => {}),
    },
    host: (
      <>
        <ReferralsWatch onChange={setFacts} />
        {open ? <InviteFriendsDialog onClose={() => setOpen(false)} /> : null}
      </>
    ),
  };
}

function ReferralsWatch({ onChange }: { onChange: (facts: ReferralFacts) => void }) {
  const mine = useQuery(api.functions.referrals.mine, {});
  const links = useQuery(api.functions.referrals.communityLinks, {});
  const inviteDetail = menuDetail(mine);
  const communityUrl = discordLink(links)?.url ?? null;
  useEffect(() => {
    onChange({ inviteDetail, communityUrl });
  }, [inviteDetail, communityUrl, onChange]);
  return null;
}
