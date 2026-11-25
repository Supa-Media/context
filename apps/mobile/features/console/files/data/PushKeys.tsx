/**
 * A push source's keys (board 09), from the control plane: one list per
 * dataset sheet, names and counts only, never a key or its hash
 * (`apps/convex/functions/sheetSources.ts`). An owner sees every key; an
 * editor, their own. A member is shown none, as the sheet's own dialog does.
 */

import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Words } from "./SourceParts";
import { KeyList, type KeyLine } from "./SourceParts";
import { ago, monthDay, rowsWords } from "./words";

export interface KeySource {
  readonly sourceId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly rowsAdded: number;
}

export function keyLines(sources: readonly KeySource[], now: number): KeyLine[] {
  return sources.map((source) => ({
    id: source.sourceId,
    name: source.name,
    made: `Made ${monthDay(source.createdAt)}`,
    rows: rowsWords(source.rowsAdded),
    used: source.lastUsedAt === null ? "Not used yet" : `Used ${ago(source.lastUsedAt, now)}`,
  }));
}

export function PushKeys({ workspaceId, path, now }: { workspaceId: string; path: string; now: number }) {
  const sources = useQuery(api.functions.sheetSources.list, { workspaceId: workspaceId as Id<"workspaces">, path });
  const revoke = useMutation(api.functions.sheetSources.revoke);
  if (sources === undefined) return <Words text="Loading…" quiet />;
  if (sources.length === 0) return <Words text="No keys yet. New key makes one, shown once." quiet />;
  return <KeyList keys={keyLines(sources, now)} onRevoke={(id) => void revoke({ sourceId: id as Id<"sheetSources"> }).catch(() => {})} />;
}
