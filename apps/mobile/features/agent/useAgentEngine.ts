import { useCallback, useMemo, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { NO_PROVIDER, type AgentEngine } from "./engine";
import {
  agentEndpoint,
  agentRequest,
  providerLabel,
  readAnswer,
  refusalSentence,
} from "./gateway";
import type { AgentPage } from "./page";

/**
 * The engine that actually asks something.
 *
 * ## The token, and why it is only ever in memory
 *
 * The gateway authenticates with an OAuth access token and nothing else, and
 * the console has never held one — it reads notes through Convex. So this mints
 * one: `mintConsoleGrant` issues an ordinary `oauthGrants` row for this app,
 * clamped to the caller's role, revocable from the connections list, an hour
 * long and with no refresh token.
 *
 * It is held in a ref and **never written anywhere**. Not `AsyncStorage`, not
 * `localStorage`, not a cookie. Minting another costs one round trip on a
 * session the person already holds, so the only thing persistence would buy is
 * a credential sitting on the device for somebody else to find — which is the
 * sentence non-negotiable #1 ends with.
 *
 * A ref and not state, deliberately: the token changing is not something any
 * pixel depends on, and putting it in state would re-render the panel — and
 * every child holding a draft — each time one is minted.
 *
 * **A ref outlives the props that filled it**, which is why the workspace is
 * stored beside the token: the console switches context without remounting,
 * so "the token is still alive" is not the same question as "the token is for
 * the context being asked about". See `token` below.
 *
 * ## Why the refusal on 401 is a re-mint and not a retry loop
 *
 * A token expires an hour in. The first turn after that gets a 401, and one
 * re-mint fixes it. It is attempted **once** per ask: a loop that re-mints on
 * every 401 would, against a gateway refusing for some other reason, mint
 * tokens until the rate limit caught it — and the person would see the
 * generic failure either way, an hour later than they should have.
 */
export function useAgentEngine(options: {
  /** The workspace this panel is asking about, or `null` before one is chosen. */
  workspaceId: string | null;
  /** The MCP endpoint the console already shows, e.g. `https://…/mcp`. */
  endpoint: string | null;
}): AgentEngine {
  const mint = useAction(api.functions.agentGrant.mintConsoleGrant);
  /**
   * The live grant, and **which context it is a grant for**.
   *
   * The workspace is held beside the token rather than inferred from the
   * closure, because this ref outlives the value of `workspaceId` that filled
   * it: switching context in the console is a `setState` inside the layout,
   * not a remount, so the hook keeps its ref straight across the switch. A
   * check on expiry alone reads "still alive" as "still the right one", and
   * the gateway resolves the session from the token — so the next turn is
   * answered out of the context the person just left, for the rest of that
   * hour, while `place.context` in the same request names the one they are in.
   *
   * One slot and not a map, deliberately. A cache per workspace would keep a
   * live credential in memory for a context nobody is looking at, which is the
   * thing the header above says this hook does not do; a switch back costs one
   * round trip on a session the person already holds.
   */
  const token = useRef<{ value: string; expiresAt: number; workspaceId: string } | null>(null);
  const route = options.endpoint === null ? null : agentEndpoint(options.endpoint);
  const workspaceId = options.workspaceId;
  /**
   * Which provider answered, in **state** and not a ref.
   *
   * This is a self-review finding rather than the first draft. It was a ref,
   * for the same reason the token is one — nothing re-renders when it changes —
   * and that was wrong: `AgentPanel`'s header renders it, and its own docstring
   * says why that matters ("it decides what the answer costs them and whose
   * machine saw the question"). A ref meant the header said "Your model"
   * forever, whatever answered.
   *
   * It changes once per session in practice — the first turn names the
   * provider and every turn after it names the same one — so the re-render it
   * costs is one, and `VoiceButton`'s note about the engine's identity being a
   * `useCallback` dependency is satisfied by it settling immediately.
   */
  const [provider, setProvider] = useState("");

  /**
   * A live token, minted if there is not one.
   *
   * Treated as expired a minute early, because a token that dies in flight
   * costs a whole turn: the person waits for the model, and gets a 401.
   */
  const tokenFor = useCallback(
    async (force: boolean): Promise<string> => {
      const held = token.current;
      if (
        !force &&
        held !== null &&
        held.workspaceId === workspaceId &&
        held.expiresAt - 60_000 > Date.now()
      ) {
        return held.value;
      }
      const minted = await mint({ workspaceId: workspaceId as Id<"workspaces"> });
      token.current = {
        value: minted.accessToken,
        expiresAt: minted.expiresAt,
        workspaceId: workspaceId as string,
      };
      return minted.accessToken;
    },
    [mint, workspaceId],
  );

  const ask = useCallback(
    async ({ question, place }: { question: string; place: AgentPage }): Promise<string> => {
      if (route === null || workspaceId === null) return NO_PROVIDER;

      const send = async (accessToken: string): Promise<Response> =>
        await fetch(route, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(agentRequest(question, place)),
        });

      let response: Response;
      try {
        response = await send(await tokenFor(false));
        // One re-mint, never a loop. See the header.
        if (response.status === 401 || response.status === 403) {
          response = await send(await tokenFor(true));
        }
      } catch {
        /*
          A network failure, or a mint that was refused. The reason is dropped
          rather than shown: a thrown `ConvexError` here carries a code written
          for an operator, and a `TypeError` from `fetch` carries the URL —
          which is this deployment's gateway, not something a person reading a
          chat panel needs.
        */
        return refusalSentence(0, null);
      }

      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      const read = readAnswer(response.status, body);
      if (typeof read === "string") return read;
      setProvider(read.provider);
      return read.answer;
    },
    [route, tokenFor, workspaceId],
  );

  return useMemo<AgentEngine>(
    () => ({
      provider: providerLabel(provider),
      /*
        Available where there is somewhere to send a turn and a context to send
        it about. Not gated on a model being *connected*: the console cannot
        see that without a query of its own, and the gateway's own refusal
        names where to connect one — which is a better answer than a greyed-out
        panel that says nothing.

        It is deliberately not gated on a Convex client either. `useConvex`
        was here and came out: it is `undefined` on every surface that renders
        this console without a provider, and nine render suites mock
        `convex/react` with the names they use — so the guard cost nine test
        files a line each and bought nothing, because none of those surfaces
        provides a `VoiceHost` for the engine to reach a panel through. A mint
        with no client throws, `ask` catches it, and the person gets a
        sentence.
      */
      available: route !== null && workspaceId !== null,
      unavailable: NO_PROVIDER,
      ask,
    }),
    [ask, provider, route, workspaceId],
  );
}
