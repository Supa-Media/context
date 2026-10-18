/**
 * The account menu's "Invite friends" row and the dialog it opens. (A
 * "Community" row sat beside it until Dev2 took it off the card, 2026-10-18;
 * the community link still ends setup, in `SetupDone`.)
 *
 * The console frame is also drawn by fixtures and the homepage's visitor demo
 * with no Convex client, and a subscription there throws. So nothing here
 * subscribes unless the caller says the frame is live: `ReferralsWatch` is
 * only mounted then, and reports what the rows need back up as plain state.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { InviteFriendsDialog } from "./InviteFriendsDialog";
import { menuDetail } from "./invites";

interface ReferralFacts {
  inviteDetail?: string;
}

export interface ReferralMenuProps {
  onInviteFriends?: () => void;
  inviteDetail?: string;
}

export function useReferralMenu(live: boolean): { props: ReferralMenuProps; host: ReactNode } {
  const [facts, setFacts] = useState<ReferralFacts | null>(null);
  const [open, setOpen] = useState(false);
  if (!live) return { props: {}, host: null };
  return {
    props: {
      onInviteFriends: () => setOpen(true),
      inviteDetail: facts?.inviteDetail,
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
  const inviteDetail = menuDetail(mine);
  useEffect(() => {
    onChange({ inviteDetail });
  }, [inviteDetail, onChange]);
  return null;
}
