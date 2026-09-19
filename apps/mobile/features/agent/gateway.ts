import type { AgentPage } from "./page";

/**
 * The wire between this app's agent panel and the gateway's `/agent` route.
 *
 * Pure, and separate from the hook that drives it, for
 * `features/console/capabilities.ts`'s reason: every guard expressed inside a
 * component in this app was held by nothing. What goes on the wire, what comes
 * off it, and what somebody is told when it fails are each decided here.
 *
 * ## The payload is built, never forwarded
 *
 * `AgentPage` already carries references and never note text —
 * `features/agent/page.ts` argues that at length and `agentPage.test.ts`
 * searches the serialized object for a sentinel planted in the body. This
 * module still rebuilds the place field by field rather than sending the page
 * object through.
 *
 * That is not belt and braces for its own sake. The two files fail differently:
 * `page.ts` decides what the *console* knows about the room, and this decides
 * what leaves the device. A field added to `AgentPage` for a local purpose —
 * a cached body for an offline read, a draft for a diff — would be sent by a
 * spread and stopped by a build. `writable` and `role` are dropped here for the
 * same reason `visibility` is kept: the gateway re-derives authority from the
 * grant, so a client-supplied claim about it is at best noise.
 *
 * ## Why the app does not stream
 *
 * The route answers whole turns. A turn that finishes is worth more than one
 * that renders prettily, and when the gateway grows SSE this module changes and
 * `AgentEngine`'s shape does not.
 */

/** The `/agent` route, derived from the MCP endpoint the console already shows. */
export function agentEndpoint(mcpEndpoint: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(mcpEndpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  /*
    The origin and nothing else. The console's endpoint may carry a context in
    its path (`/@seyi/mcp`) and this deliberately drops it: the console's grant
    is minted for one workspace, so the *token* names the context and a slug in
    the path would be a second answer to the same question. The gateway resolves
    the workspace from the grant either way, which is the property
    `openStorageBinding`'s header calls two-factor.
  */
  return `${parsed.origin}/agent`;
}

/** What one turn sends. */
export interface AgentRequest {
  question: string;
  place: {
    context: string | null;
    note: { path: string; visibility: string; readable: boolean; unsaved: boolean } | null;
    meetingLive: boolean;
  };
}

/**
 * Build the body, field by field.
 *
 * Every field here is one the gateway's own `describePlace` reads. Nothing is
 * spread, and there is no `...place` anywhere in this file — the test
 * `nothing from the page rides along uninvited` asserts that by planting a
 * field on the page and checking it does not arrive.
 */
export function agentRequest(question: string, place: AgentPage | null): AgentRequest {
  const note = place?.note ?? null;
  return {
    question,
    place: {
      context: place?.context?.slug ?? null,
      note:
        note === null
          ? null
          : {
              path: note.path,
              // Disclosure, so the agent can warn somebody where a proposal
              // lands. Never authority — see `page.ts`.
              visibility: note.visibility,
              readable: note.readable,
              unsaved: note.unsaved,
            },
      meetingLive: place?.meetingLive ?? false,
    },
  };
}

/** What one turn did, for the panel to show while it runs and after. */
export interface AgentStep {
  tool: string;
  ok: boolean;
}

export interface AgentAnswer {
  answer: string;
  provider: string;
  steps: AgentStep[];
}

/**
 * The sentence somebody is shown when a turn does not produce an answer.
 *
 * One per outcome they could act on, and **one for everything else**. The
 * gateway's refusals are deliberately opaque — `model_unavailable` carries no
 * reason, because a provider's error body quotes the request that produced it —
 * so inventing detail here would be inventing it.
 */
export function refusalSentence(status: number, code: string | null): string {
  if (status === 401 || status === 403) {
    return "This app's connection to your context expired. Reload and ask again.";
  }
  if (code === "no_provider") {
    return "No model is connected to this context yet. Add your Anthropic or OpenAI key in Settings → Model, and ask me again.";
  }
  if (status === 409) {
    return "Something about this context's setup stopped the answer. Check Settings → Model.";
  }
  if (status === 400) {
    return "I could not read that question. Try asking it again.";
  }
  if (status === 502 || status === 503) {
    return "The model did not answer. That is usually the provider having a moment — try again.";
  }
  return "That did not work. Try again in a moment.";
}

/**
 * Read one turn's response.
 *
 * Throws nothing: a caller here is a panel with a person waiting at it, and
 * every outcome has to be a sentence. A body that is not the documented shape
 * is the same as a failure, because a turn whose answer this build cannot read
 * is a turn that did not happen.
 */
export function readAnswer(status: number, body: unknown): AgentAnswer | string {
  const parsed = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const code =
    typeof (parsed as { error?: unknown }).error === "string"
      ? ((parsed as { error: string }).error)
      : null;

  if (status !== 200) return refusalSentence(status, code);

  const answer = (parsed as { answer?: unknown }).answer;
  if (typeof answer !== "string" || answer.trim().length === 0) {
    return refusalSentence(status, code);
  }

  const steps = Array.isArray((parsed as { steps?: unknown }).steps)
    ? ((parsed as { steps: unknown[] }).steps)
        .filter(
          (step): step is { tool: string; ok?: unknown } =>
            typeof step === "object" &&
            step !== null &&
            typeof (step as { tool?: unknown }).tool === "string",
        )
        .map((step) => ({ tool: step.tool, ok: step.ok !== false }))
    : [];

  return {
    answer,
    provider:
      typeof (parsed as { provider?: unknown }).provider === "string"
        ? (parsed as { provider: string }).provider
        : "",
    steps,
  };
}

/**
 * What the panel calls the thing it is talking to.
 *
 * The provider's own name once a turn has answered, and a neutral word before
 * one has. Never "Claude" or "GPT" before the gateway has said which — the
 * console cannot see which provider is connected without a query of its own,
 * and a header that guesses is a header that is wrong for half the people
 * reading it.
 */
export function providerLabel(provider: string): string {
  if (provider === "anthropic") return "Claude";
  if (provider === "openai") return "GPT";
  /*
    The local road names itself, because what it is matters to the person
    reading the header: this turn spent their subscription rather than their
    API key, and "Claude Code" is the thing they already know they pay for.
    `features/agent/local.ts` is the only writer of this value.
  */
  if (provider === "claude-code") return "Claude Code";
  return "Your model";
}
