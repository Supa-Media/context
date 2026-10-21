import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_ICONS,
  CONTEXT_ICON_FAMILIES,
  CONTEXT_ICON_FAMILY_LABEL,
  PART_EMOJI,
  contextIconMarker,
  contextIconOf,
  contextPartMarker,
  contextPartOf,
  iconAsText,
  randomContextIcon,
  searchContextIcons,
} from "../../../packages/shared/src/contextIcons.cjs";
import { parseFolderIcons, serializeFolderIcons } from "../../../packages/shared/src/folderIcons.cjs";

test("the set is a hundred icons, each named once, in a known family, with an emoji twin", () => {
  assert.equal(CONTEXT_ICONS.length, 100);
  assert.equal(new Set(CONTEXT_ICONS.map((icon) => icon.name)).size, 100);
  assert.equal(new Set(CONTEXT_ICONS.map((icon) => icon.label)).size, 100);
  for (const icon of CONTEXT_ICONS) {
    assert.match(icon.name, /^[a-z][a-z-]*$/, icon.name);
    assert.ok(CONTEXT_ICON_FAMILIES.includes(icon.family), icon.name);
    assert.ok(icon.emoji.length > 0 && !/[a-z]/.test(icon.emoji), icon.name);
    // A stored icon fits the icon rows' length limit.
    assert.ok(contextIconMarker(icon.name).length <= 32, icon.name);
  }
  for (const family of CONTEXT_ICON_FAMILIES) assert.ok(CONTEXT_ICON_FAMILY_LABEL[family], family);
});

test("only a name in the set reads as a Context icon", () => {
  assert.equal(contextIconOf("context:icon:rocket")?.label, "Rocket");
  assert.equal(contextIconOf("context:icon:map-pin")?.emoji, "📍");
  for (const icon of ["context:icon:", "context:icon:nope", "context:icon:constructor", "context:icon:__proto__", "🚀", ":rocket:", "context:tex", null, undefined]) {
    assert.equal(contextIconOf(icon), null, String(icon));
  }
  assert.equal(contextPartOf(contextPartMarker("tex_skills")), "tex_skills");
  assert.equal(contextPartOf("context:part:constructor"), null);
  assert.equal(contextPartOf("context:icon:rocket"), null);
});

test("anywhere a drawing can't go, an icon is written as its emoji twin", () => {
  assert.equal(iconAsText("context:icon:rocket"), "🚀");
  assert.equal(iconAsText(contextPartMarker("tex_transcripts")), PART_EMOJI.tex_transcripts);
  assert.equal(iconAsText("🍳"), "🍳");
  assert.equal(iconAsText(":party-parrot:"), ":party-parrot:");
});

test("a chosen Context icon survives the export file as it is", () => {
  const icons = { "1-projects/launch": "context:icon:rocket", "2-areas/money": "context:icon:coin" };
  assert.deepEqual(parseFolderIcons(serializeFolderIcons(icons)), icons);
});

test("search reads labels and words, the label first", () => {
  assert.equal(searchContextIcons("rocket")[0]?.name, "rocket");
  const birthday = searchContextIcons("birthday").map((icon) => icon.name);
  assert.ok(birthday.includes("party") && birthday.includes("gift"), birthday.join());
  assert.equal(searchContextIcons("Health")[0]?.name, "pulse");
  assert.deepEqual(searchContextIcons("  "), []);
  assert.deepEqual(searchContextIcons("zzzz"), []);
  // Every word must match: "church music" is not every church icon and every music icon.
  assert.deepEqual(searchContextIcons("church music").map((icon) => icon.name), []);
});

test("Shuffle always lands on another icon in the set", () => {
  let previous = null;
  for (let i = 0; i < 50; i++) {
    const next = randomContextIcon(Math.random, previous);
    assert.notEqual(next, previous);
    assert.notEqual(contextIconOf(next), null);
    previous = next;
  }
  assert.notEqual(randomContextIcon(() => 0, "context:icon:briefcase"), "context:icon:briefcase");
});
