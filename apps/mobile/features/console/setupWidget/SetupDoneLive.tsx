import { useState, type ComponentProps } from "react";
import { Linking } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { InviteFriendsDialog } from "../../referrals/InviteFriendsDialog";
import { discordLink } from "../../referrals/invites";
import { SetupDone } from "./SetupDone";

/**
 * "You're set up.", with the two rows the control plane knows about: the
 * Discord join link staff keep in the console, and the invites this person
 * can send. Split from `SetupDone` so the card itself stays a picture that
 * fixtures can draw without a Convex client.
 */
export function SetupDoneLive(props: Omit<ComponentProps<typeof SetupDone>, "onJoinCommunity" | "invitesLeft" | "onInviteFriends">) {
  const mine = useQuery(api.functions.referrals.mine, {});
  const links = useQuery(api.functions.referrals.communityLinks, {});
  const [inviting, setInviting] = useState(false);
  const discord = discordLink(links);
  const canInvite = mine !== undefined && mine !== null && !mine.off && mine.locked === null;
  return (
    <>
      <SetupDone
        {...props}
        onJoinCommunity={discord === null ? undefined : () => void Linking.openURL(discord.url).catch(() => {})}
        invitesLeft={canInvite ? mine.left : undefined}
        onInviteFriends={canInvite ? () => setInviting(true) : undefined}
      />
      {inviting ? <InviteFriendsDialog onClose={() => setInviting(false)} /> : null}
    </>
  );
}
