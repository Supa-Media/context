import type { FunctionReference } from "convex/server";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import type {
  OrganizerDecision,
  OrganizerKind,
  OrganizerStatus,
  OrganizerSuggestion,
  ResolveResult,
  UndoToken,
} from "./types";

type Workspace = { workspaceId: Id<"workspaces"> };

/**
 * `api.functions.organizer.*`, typed by hand in exactly one place.
 *
 * Kept as a shim over `apps/convex/functions/organizer.ts` so an app build can
 * run against a deployment that predates it: there the status query errors,
 * which `organizerState` reads as "unavailable", and nothing is drawn.
 *
 * `undo` takes back an accept (the token `resolve` handed out) or an automatic
 * change named by its Activity row.
 */
export interface OrganizerApi {
  status: FunctionReference<"query", "public", Workspace, OrganizerStatus | null>;
  setEnabled: FunctionReference<"mutation", "public", Workspace & { on: boolean }, null>;
  acknowledgeNotice: FunctionReference<"mutation", "public", Workspace & { turnOff?: boolean }, null>;
  setAutopilot: FunctionReference<"mutation", "public", Workspace & { kind: OrganizerKind; on: boolean }, null>;
  sweepNow: FunctionReference<"mutation", "public", Workspace, null>;
  suggestions: FunctionReference<
    "action",
    "public",
    Workspace,
    { suggestions: OrganizerSuggestion[]; sweptAt: number | null }
  >;
  resolve: FunctionReference<
    "action",
    "public",
    Workspace & { id: string; decision: OrganizerDecision },
    ResolveResult
  >;
  undo: FunctionReference<
    "action",
    "public",
    Workspace & { token?: UndoToken; entry?: { at: string; kind: string; paths: string[] } },
    { applied: boolean; error?: string }
  >;
}

/**
 * The references, or `undefined` where this build has none to offer.
 *
 * A function rather than a constant: `api` is a proxy that mints a fresh
 * object on every access, and one read at module load and kept would be the
 * only reference in the app that is not re-read where it is used.
 */
export function organizerApi(): OrganizerApi | undefined {
  return (api.functions as unknown as { organizer?: OrganizerApi }).organizer;
}
