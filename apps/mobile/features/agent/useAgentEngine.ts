import { useCallback, useMemo, useState } from "react";
import { useConsoleGrant } from "./useConsoleGrant";
import type { GrantRefresh } from "./consoleGrantCache";
import type { Id } from "@context/convex/_generated/dataModel";
import { NO_PROVIDER, type AgentEngine } from "./engine";
import {
  agentEndpoint,
  agentRequest,
  providerLabel,
  readAnswer,
  refusalSentence,
} from "./gateway";
import { afterLocal, localRouteFrom, preferLocal, type LocalRoute } from "./local";
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
 * The in-memory session cache is shared with the editor and presence socket,
 * keyed by workspace, so those consumers do not invalidate each other's grant.
 * Nothing is persisted and an account change gets a new cache.
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
  const mint = useConsoleGrant();
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
    async (refresh: GrantRefresh): Promise<string> => {
      const minted = await mint({ workspaceId: workspaceId as Id<"workspaces"> }, refresh);
      return minted.accessToken;
    },
    [mint, workspaceId],
  );

  /**
   * The `claude` on this machine, or `null` everywhere else.
   *
   * Read once rather than per-ask: `window.desktop` is frozen by the preload
   * before the page runs and cannot appear later in a session, so re-reading it
   * on every question would be a lookup that can only ever return what it
   * returned the first time.
   */
  const local = useMemo<LocalRoute | null>(() => localRouteFrom(), []);

  const ask = useCallback(
    async ({ question, place }: { question: string; place: AgentPage }): Promise<string> => {
      /*
        The local road first, where there is one.

        It spends the subscription the person already pays for rather than
        billing their card per question, and it asks for no key. It is tried
        *before* the `route === null` guard below on purpose: a machine with a
        CLI can answer even when this console has no MCP endpoint to offer,
        and refusing first would turn a working road into `NO_PROVIDER`.

        A local failure does **not** fall through to the gateway. The sentences
        it returns name a fix on this machine — sign in, connect this Mac — and
        silently spending somebody's API key after telling them nothing would
        be the one outcome they came to this road to avoid.
      */
      if (preferLocal(local) && local !== null) {
        /*
          `null` on a throw, which `afterLocal` reads as "the shell went away"
          — the one outcome that falls through. Every other one ends the turn
          there; the reasoning, and the tests, are in `local.ts`.
        */
        const reply = await local.ask({ question, place }).catch(() => null);
        const next = afterLocal(reply);
        if (next.road === "answer") {
          setProvider(next.provider);
          return next.answer;
        }
        if (next.road === "stop") return next.sentence;
      }

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
        const token = await tokenFor(false);
        response = await send(token);
        // One re-mint, never a loop. See the header. Naming the refused token
        // lets the shared cache hand over a replacement another consumer
        // already minted instead of revoking it with a mint of its own.
        if (response.status === 401 || response.status === 403) {
          response = await send(await tokenFor({ rejected: token }));
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
    [local, route, tokenFor, workspaceId],
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
