/**
 * A readable name of three words, such as `chair-blast-tiger`, for a Tex
 * guest chat's group (`textGroupGuests.ts`; the owner, 2026-10-25: "a
 * readable 3 word id like chair-blast-tiger").
 *
 * Plain, short, everyday words, so a name can be said out loud and typed on a
 * phone. Whether a name is free is the names table's to say: the caller tries
 * again on a name that is taken.
 */

const WORDS = [
  "acorn", "amber", "anchor", "apple", "arrow", "aspen", "atlas", "badge", "bagel", "banjo",
  "basil", "beach", "beacon", "berry", "birch", "blast", "bloom", "blue", "board", "boat",
  "bolt", "brass", "bread", "brick", "brook", "cabin", "cable", "cactus", "camel", "candle",
  "canoe", "canyon", "cargo", "cedar", "chair", "chalk", "cherry", "chess", "cider", "cliff",
  "clock", "cloud", "clover", "coast", "cobalt", "comet", "copper", "coral", "cotton", "crane",
  "crest", "crown", "daisy", "delta", "denim", "desert", "dune", "eagle", "ember", "falcon",
  "fern", "fiddle", "field", "flint", "forest", "fox", "frost", "garden", "ginger", "glacier",
  "globe", "golden", "grape", "gravel", "harbor", "hazel", "heron", "honey", "island", "ivory",
  "jade", "jasper", "kettle", "kite", "lake", "lantern", "lemon", "lilac", "linen", "lotus",
  "maple", "marble", "meadow", "melon", "mesa", "mint", "moon", "moss", "mountain", "nectar",
  "night", "north", "oak", "ocean", "olive", "onyx", "orbit", "orchid", "otter", "owl",
  "palm", "panda", "paper", "pearl", "pepper", "pine", "planet", "plum", "pond", "poppy",
  "prairie", "quartz", "quill", "rain", "raven", "reef", "ridge", "river", "robin", "rocket",
  "rose", "ruby", "sage", "sail", "salt", "sand", "shell", "silver", "sky", "slate",
  "snow", "sparrow", "spruce", "star", "stone", "storm", "summit", "sun", "swan", "tango",
  "thunder", "tide", "tiger", "timber", "topaz", "trail", "tulip", "tundra", "valley", "velvet",
  "violet", "wave", "willow", "wind", "winter", "wolf", "wren", "zebra", "zephyr", "zinc",
] as const;

/** Three different words joined by hyphens, picked by `random` (in [0, 1)). */
export function threeWords(random: () => number = Math.random): string {
  const picked: string[] = [];
  while (picked.length < 3) {
    const word = WORDS[Math.floor(random() * WORDS.length) % WORDS.length];
    if (!picked.includes(word)) picked.push(word);
  }
  return picked.join("-");
}

export const THREE_WORD_LIST: readonly string[] = WORDS;
