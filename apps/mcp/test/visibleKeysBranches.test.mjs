import test from "node:test";
import assert from "node:assert/strict";
import { listAllNoteKeys } from "../src/notes/visibleKeys.js";

test("note inventory splits large archive branches without losing keys", async () => {
  const keys = [
    "index.md",
    ".context/private.md",
    "0-inbox/email/account/2026-08-01.md",
    "4-archive/communications/imessage/2024/people/a/2024-01.md",
    "4-archive/communications/imessage/2024/people/a/2024-02.md",
    "4-archive/communications/imessage/2024/people/a/2024-03.md",
    "4-archive/communications/imessage/2025/people/b/2025-01.md",
    "4-archive/0-inbox/imessage/2023/people/c/2023-01.md",
    "4-archive/0-inbox/imessage/2023/people/c/image.png",
  ];
  const flatPrefixes = [];
  const store = {
    async list({ prefix = "", delimiter, cursor } = {}) {
      if (!delimiter) flatPrefixes.push({ prefix, cursor });
      const entries = new Map();
      for (const key of keys.filter((key) => key.startsWith(prefix))) {
        const rest = key.slice(prefix.length);
        const slash = delimiter ? rest.indexOf("/") : -1;
        const value = slash < 0 ? key : `${prefix}${rest.slice(0, slash + 1)}`;
        entries.set(value, slash < 0 ? "object" : "prefix");
      }
      const page = [...entries].sort(([a], [b]) => a.localeCompare(b)).slice(Number(cursor || 0), Number(cursor || 0) + 2);
      const next = Number(cursor || 0) + page.length;
      return {
        objects: page.filter(([, kind]) => kind === "object").map(([key]) => ({ key })),
        delimitedPrefixes: page.filter(([, kind]) => kind === "prefix").map(([key]) => key),
        truncated: next < entries.size,
        cursor: next < entries.size ? String(next) : undefined,
      };
    },
  };
  const listed = (await listAllNoteKeys(store)).map(({ key }) => key).sort();
  assert.deepEqual(listed, keys.filter((key) => key.endsWith(".md") && !key.startsWith(".")).sort());
  assert.ok(flatPrefixes.some(({ prefix }) => prefix.startsWith("4-archive/communications/imessage/2024/")));
  assert.ok(!flatPrefixes.some(({ prefix, cursor }) => prefix === "4-archive/" && cursor));
});
