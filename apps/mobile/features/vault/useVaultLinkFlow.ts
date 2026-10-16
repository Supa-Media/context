import { useCallback, useEffect, useRef, useState } from "react";
import type { VaultDraft } from "./VaultAddForm";
import type { VaultEdit } from "./VaultKeyEditor";
import type { Described, Outcome, RevealedEntry, VaultRequest } from "./vaultLink";

/** The server calls behind one vault link, each taking the link's token. */
export interface VaultLinkCalls {
  describe: (token: string) => Promise<VaultRequest>;
  save: (token: string, draft: VaultDraft) => Promise<{ name: string; site: string }>;
  share?: (token: string) => Promise<{ name: string; grantee: string | null }>;
  reveal: (token: string) => Promise<RevealedEntry>;
  /** Settings › Vault only: save a key changed in place on a view link; resolves what changed, by name. */
  edit?: (token: string, edit: VaultEdit) => Promise<{ changed: string[] }>;
  /** Settings › Vault only: delete the key a view link opened. */
  remove?: (token: string) => Promise<{ name: string }>;
}

/**
 * One vault link's states, shared by the page Tex texts (`/vault/<token>`)
 * and Settings › Vault, which opens the same link in place. The request is
 * described once, when `ready`; nothing is saved, shared or revealed until a
 * press. Revealed values live in this state while it is mounted, and nowhere
 * else.
 */
export function useVaultLinkFlow(token: string | null, ready: boolean, calls: VaultLinkCalls) {
  const [described, setDescribed] = useState<Described>({ kind: "idle" });
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const asked = useRef<string | null>(null);
  // The calls are rebuilt by each render; the latest are used on each press.
  const latest = useRef(calls);
  latest.current = calls;

  useEffect(() => {
    if (!ready || token === null || asked.current === token) return;
    asked.current = token;
    setDescribed({ kind: "loading" });
    setOutcome({ kind: "idle" });
    latest.current.describe(token).then(
      (request) => setDescribed({ kind: "shown", request }),
      (error: unknown) => setDescribed({ kind: "failed", error }),
    );
  }, [ready, token]);

  // Resolves true on success so the form can drop the password it held.
  const onSave = useCallback(
    async (draft: VaultDraft): Promise<boolean> => {
      if (token === null) return false;
      setOutcome({ kind: "busy" });
      try {
        const saved = await latest.current.save(token, draft);
        setOutcome({ kind: "saved", ...saved, type: draft.type });
        return true;
      } catch (error: unknown) {
        setOutcome({ kind: "failed", error });
        return false;
      }
    },
    [token],
  );

  const onShare = useCallback(() => {
    const share = latest.current.share;
    if (token === null || share === undefined) return;
    setOutcome({ kind: "busy" });
    share(token).then(
      (shared) => setOutcome({ kind: "shared", ...shared }),
      (error: unknown) => setOutcome({ kind: "failed", error }),
    );
  }, [token]);

  // One call per press; the answer stays in this state and is never logged.
  const onReveal = useCallback(() => {
    if (token === null) return;
    setOutcome({ kind: "busy" });
    latest.current.reveal(token).then(
      (entry) => setOutcome({ kind: "revealed", entry }),
      (error: unknown) => setOutcome({ kind: "failed", error }),
    );
  }, [token]);

  return { described, outcome, setOutcome, onSave, onShare, onReveal };
}
