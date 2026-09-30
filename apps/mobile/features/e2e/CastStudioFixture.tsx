import { useEffect, useState } from "react";
import type { PresenceMember } from "../console/presence/protocol";
import { setCastPace } from "@context/shared";
import { setNoteProperty } from "../../../mcp/src/lists.js";
import { CastStudio } from "../studio/CastStudio";
import { SOUNDS_PROPERTY } from "../studio/sounds/castSounds";

/**
 * `screen=cast-studio`: the cast studio on a fixed scene, as "Preview demo"
 * opens it, for `e2e/webkit/castStudio.spec.ts`. The stage inside it is the
 * real homepage playing the scene from its address, like the studio's own.
 * Sound choices and script edits are written into the fixture's own copy of
 * the note, which is on the window for the spec to read; `__castStudioAgent`
 * stands in for an agent writing the note through its tools.
 */
const SCENE = [
  "# Pricing :annoyed:",
  "",
  "Premium is $5 a month, everything included.",
  "",
  "Free is free, you cheapo.",
  "",
  "```cast",
  "@maya types: p.s. this page is live.",
  "@maya's Codex comments on \"you cheapo\": a little unprofessional?",
  "@jon replies: eh, I don't really care",
  "@jon resolves",
  "```",
  "",
].join("\n");

const ANNOYED = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

/** `screen=cast-studio-pages`: the scene goes on to another page (`opens:`). */
const GOES_ON = "@jon resolves\n@maya opens: team\n@maya types: and the team is on it.";
const TEAM = "# Team\n\nWho builds this.\n";

export function CastStudioFixture({ pages = false }: { pages?: boolean }) {
  const [draft, setDraft] = useState(pages ? SCENE.replace("@jon resolves", GOES_ON) : SCENE);
  const [members, setMembers] = useState<PresenceMember[]>([]);
  useEffect(() => {
    (window as unknown as { __castStudioAgent?: (from: string, to: string) => void }).__castStudioAgent = (from, to) => {
      setMembers([{ id: "agent", name: "@maya's Codex", color: null, anchor: null, head: null, canWrite: true, isAgent: true }]);
      setDraft((current) => current.replace(from, to));
    };
  }, []);
  return (
    <CastStudio
      draft={draft}
      title="Pricing"
      onClose={() => {}}
      onSaveSounds={(items) => {
        const changed = setNoteProperty(draft, SOUNDS_PROPERTY, items);
        if ("error" in changed) return changed.error ?? "refused";
        (window as unknown as { __castStudioNote?: string }).__castStudioNote = changed.text;
        setDraft(changed.text);
        return null;
      }}
      soundStorage={{
        // Kept in memory: the spec checks what was sent, and the server's own
        // checks are `apps/convex/__tests__/files/sceneSounds.test.ts`.
        store: async ({ bytes, contentType }) => {
          (window as unknown as { __castStudioUpload?: unknown }).__castStudioUpload = { size: bytes.byteLength, contentType };
          return { target: "sound-0123456789abcdef.wav" };
        },
        load: async () => null,
      }}
      onSavePace={(pace) => {
        const text = setCastPace(draft, pace);
        (window as unknown as { __castStudioNote?: string }).__castStudioNote = text;
        setDraft(text);
        return null;
      }}
      // A one-pixel picture for `:annoyed:`, as the workspace's emoji would answer.
      loadEmoji={async (name) => (name === "annoyed" ? ANNOYED : null)}
      onEditScript={(change) => {
        const text = change(draft);
        (window as unknown as { __castStudioNote?: string }).__castStudioNote = text;
        setDraft(text);
        return null;
      }}
      members={members}
      readPage={async (name) => (pages && name === "team" ? { name, title: "Team", markdown: TEAM } : null)}
    />
  );
}
