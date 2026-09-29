import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { InAppMessageId } from "@context/shared";
import { openStore } from "../offline/store";
import { useMessages } from "./MessagesProvider";
import { accountAnswer, messageKey, seenFrom, type Seen } from "./rules";

/**
 * Ask for the screen for one message, whose answer is kept somewhere of its
 * own (the setup checklist on the membership, auto-organize's notice on its
 * settings). `eligible` is everything about the moment that the message's own
 * code decides — role, layout, state — and `seen` its own answer. `visible`
 * says whether it is this message's turn.
 */
export function useMessageSlot({
  id,
  workspaceId = null,
  variant = null,
  eligible,
  seen,
}: {
  id: InAppMessageId;
  workspaceId?: string | null;
  variant?: string | null;
  eligible: boolean;
  seen: Seen;
}): { visible: boolean } {
  const messages = useMessages();
  const owner = useId();
  const key = messageKey(id, workspaceId, variant);
  const { offer, withdraw } = messages;

  useEffect(() => {
    if (!eligible) return;
    offer(owner, { key, id, seen });
  }, [eligible, owner, key, id, seen, offer]);

  useEffect(() => {
    if (!eligible) return;
    return () => withdraw(owner);
  }, [eligible, owner, withdraw]);

  if (!eligible || seen !== false) return { visible: false };
  return { visible: messages.arbitrated ? messages.picked === key : true };
}

/**
 * A message answered through the shared list (`messageReads`): the account
 * keeps the answer, this device keeps a copy under `deviceKey` (which is also
 * where answers given before the account kept them are found and carried up),
 * and the arbiter says when it is this message's turn.
 *
 * Nothing is shown until both answers are in: a message that appears and
 * vanishes a frame later, for everybody who already answered it, is the
 * layout jump this app refuses everywhere. A device read that fails counts as
 * answered: a message nobody can put away for good is worse than none.
 */
export function useInAppMessage({
  id,
  workspaceId = null,
  variant = null,
  eligible,
  deviceKey,
}: {
  id: InAppMessageId;
  workspaceId?: string | null;
  variant?: string | null;
  eligible: boolean;
  /** Where this device keeps its copy; `null` for none. */
  deviceKey: string | null;
}): { visible: boolean; dismiss: () => void } {
  const { reads, mark } = useMessages();
  const [device, setDevice] = useState<{ key: string | null; seen: boolean } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = messageKey(id, workspaceId, variant);

  useEffect(() => {
    if (!eligible) return;
    if (deviceKey === null) {
      setDevice({ key: null, seen: false });
      return;
    }
    let live = true;
    void openStore()
      .get(deviceKey)
      .then((stored) => {
        if (live) setDevice({ key: deviceKey, seen: stored !== null });
      })
      .catch(() => {
        if (live) setDevice({ key: deviceKey, seen: true });
      });
    return () => {
      live = false;
    };
  }, [eligible, deviceKey]);

  const deviceSeen = device !== null && device.key === deviceKey ? device.seen : undefined;
  const account = accountAnswer(reads, id, workspaceId, variant, Date.now());
  const answer = seenFrom({ account, device: deviceSeen });
  const seen = dismissed === key ? true : answer.seen;

  const args = useMemo(() => build(id, workspaceId, variant), [id, workspaceId, variant]);
  // Once per message here: the account's answer arrives by subscription.
  const carried = useRef<string | null>(null);
  useEffect(() => {
    if (!eligible || !answer.carry || carried.current === key) return;
    carried.current = key;
    mark(args);
  }, [eligible, answer.carry, key, mark, args]);

  const { visible } = useMessageSlot({ id, workspaceId, variant, eligible, seen });

  const dismiss = useCallback(() => {
    setDismissed(key);
    if (deviceKey !== null) {
      // Both: the device write throws when storage is full, and the account
      // write fails offline. Either one keeps the answer.
      void openStore()
        .set(deviceKey, new Date().toISOString())
        .catch(() => {});
    }
    mark(args);
  }, [key, deviceKey, mark, args]);

  return { visible, dismiss };
}

function build(id: InAppMessageId, workspaceId: string | null, variant: string | null) {
  return {
    message: id,
    ...(workspaceId === null ? {} : { workspaceId }),
    ...(variant === null ? {} : { variant }),
  };
}
