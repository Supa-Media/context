import { ConvexHttpClient } from "convex/browser";
import { api } from "@context/convex/_generated/api";

export type GoogleCompletionArgs = {
  state: string;
  code: string;
  completionSecret: string;
};

export const GOOGLE_CALLBACK_TIMEOUT_MS = 45_000;

function deploymentUrl(): string {
  const url = process.env.EXPO_PUBLIC_CONVEX_URL;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Google connect cannot finish because Convex is not configured.");
  }
  return url;
}

function abortableFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };
}

export type GoogleCompletionResult = { ai: boolean; workspaceId: string };

export async function completeGoogleCallback(args: GoogleCompletionArgs): Promise<GoogleCompletionResult> {
  const client = new ConvexHttpClient(deploymentUrl(), {
    fetch: abortableFetch(GOOGLE_CALLBACK_TIMEOUT_MS),
    logger: false,
    skipConvexDeploymentUrlCheck: process.env.EXPO_PUBLIC_E2E_FIXTURE === "1",
  });
  const result = await client.action(api.functions.googleConnect.completeGoogleConnect, args);
  return { ai: result.ai === true, workspaceId: result.workspaceId };
}

/*
  One completion call per OAuth state. A remount of the callback screen (or a
  second effect run) joins the call already in flight rather than spending the
  code again: the server deletes the attempt on its first use, so a second
  call would be refused. A success stays cached, so a remount after it sees
  success; a rejection is forgotten, so a real retry can run.
*/
const inFlight = new Map<string, Promise<GoogleCompletionResult>>();

/** The completion already started (or succeeded) for this OAuth state in this page, if any. */
export function joinGoogleCallback(state: string): Promise<GoogleCompletionResult> | null {
  return inFlight.get(state) ?? null;
}

export function completeGoogleCallbackOnce(
  args: GoogleCompletionArgs,
  run: (args: GoogleCompletionArgs) => Promise<GoogleCompletionResult> = completeGoogleCallback,
): Promise<GoogleCompletionResult> {
  const existing = inFlight.get(args.state);
  if (existing !== undefined) return existing;
  const started = run(args);
  inFlight.set(args.state, started);
  started.catch(() => {
    if (inFlight.get(args.state) === started) inFlight.delete(args.state);
  });
  return started;
}

export function __resetGoogleCallbackInFlightForTests(): void {
  inFlight.clear();
}
