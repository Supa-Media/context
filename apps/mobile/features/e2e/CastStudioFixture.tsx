import { CastStudio } from "../studio/CastStudio";

/**
 * `screen=cast-studio`: the cast studio on a fixed scene, as "Preview demo"
 * opens it, for `e2e/webkit/castStudio.spec.ts`. The stage inside it is the
 * real homepage playing the scene from its address, like the studio's own.
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
  return <CastStudio draft={SCENE} title="Pricing" onClose={() => {}} />;
}
