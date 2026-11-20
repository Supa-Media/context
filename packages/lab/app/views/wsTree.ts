/**
 * The workspace browser's pure part (the artifact's `openWs`): a bench workspace's notes grouped by folder and the
 * note it opens on, for `Workspace.web.tsx` and the MCP's `tex_dev bench` (`engine/forMcp.ts`).
 */
import { WS } from "../labData.generated";

export function wsTree(ws: string, at?: string): { files: Record<string, string>; paths: string[]; cur: string; groups: Record<string, string[]> } {
  const files = WS[ws] || {};
  const paths = Object.keys(files);
  const cur = at || (files["index.md"] !== undefined ? "index.md" : paths[0]) || "";
  const groups: Record<string, string[]> = {};
  for (const q of paths) {
    const d = q.includes("/") ? q.slice(0, q.lastIndexOf("/")) : "";
    (groups[d] = groups[d] || []).push(q);
  }
  return { files, paths, cur, groups };
}
