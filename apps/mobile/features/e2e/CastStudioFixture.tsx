import { useState } from "react";
import { setNoteProperty } from "../../../mcp/src/lists.js";
import { CastStudio } from "../studio/CastStudio";
import { SOUNDS_PROPERTY } from "../studio/sounds/castSounds";

/**
 * `screen=cast-studio`: the cast studio on a fixed scene, as "Preview demo"
 * opens it, for `e2e/webkit/castStudio.spec.ts`. The stage inside it is the
 * real homepage playing the scene from its address, like the studio's own.
 * Sound choices are written into the fixture's own copy of the note, and the
 * line they make is on the window for the spec to read.
 */
const SCENE = [
  "# Pricing",
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

export function CastStudioFixture() {
  const [draft, setDraft] = useState(SCENE);
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
    />
  );
}
