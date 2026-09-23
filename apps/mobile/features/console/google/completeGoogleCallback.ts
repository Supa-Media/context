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

export async function completeGoogleCallback(args: GoogleCompletionArgs): Promise<void> {
  const client = new ConvexHttpClient(deploymentUrl(), {
    fetch: abortableFetch(GOOGLE_CALLBACK_TIMEOUT_MS),
    logger: false,
    skipConvexDeploymentUrlCheck: process.env.EXPO_PUBLIC_E2E_FIXTURE === "1",
  });
  await client.action(api.functions.googleConnect.completeGoogleConnect, args);
}
