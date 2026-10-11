/**
 * The words a run's answer id is made of: four picked from this list, joined
 * by hyphens (`amber-fox-quiet-lane`). Short, common, lowercase, and nothing a
 * reader could take for a setup, a model or a person. Changing the list
 * changes every id, so treat it as append-only: a result note's key maps ids
 * to runs, and a re-judged result must keep the ids it was written with.
 */
export const WORDS = Object.freeze([
  "acorn", "air", "alder", "almond", "amber", "anchor", "angel", "apple",
  "apron", "arch", "arrow", "ash", "aspen", "atlas", "attic", "autumn",
  "avid", "awake", "badge", "bagel", "bamboo", "banjo", "barley", "barn",
  "basil", "beach", "beacon", "bean", "bear", "beech", "bell", "belt",
  "bench", "berry", "birch", "bison", "blade", "blaze", "blossom", "blue",
  "boat", "bold", "bolt", "book", "boot", "bottle", "bramble", "brass",
  "bread", "brick", "bridge", "brook", "brush", "bubble", "bucket", "cabin",
  "cable", "cactus", "camel", "camp", "canary", "candle", "canoe", "canyon",
  "cape", "cargo", "carrot", "cedar", "cello", "chalk", "charm", "cherry",
  "chess", "cider", "circle", "clay", "cliff", "cloak", "clock", "cloud",
  "clover", "coal", "coast", "cocoa", "comet", "copper", "coral", "cotton",
  "cove", "crane", "cricket", "crisp", "crown", "cube", "cup", "curve",
  "daisy", "dawn", "delta", "denim", "desk", "dew", "dial", "diner",
  "dolphin", "dove", "drift", "drum", "dune", "dusk", "eagle", "earth",
  "easel", "echo", "elm", "ember", "fable", "fern", "ferry", "field",
  "fig", "finch", "flame", "flask", "fleet", "flint", "flower", "flute",
  "focus", "forest", "fox", "frame", "frost", "garden", "garnet", "gate",
  "gem", "ginger", "glade", "glass", "glen", "globe", "glow", "gold",
  "grain", "grape", "grass", "gravel", "grove", "guitar", "harbor", "harp",
  "hazel", "hedge", "heron", "hill", "hive", "honey", "hood", "horse",
  "house", "ink", "island", "ivory", "ivy", "jade", "jar", "jet",
  "jewel", "kayak", "kelp", "kettle", "kite", "koala", "ladder", "lagoon",
  "lake", "lamp", "lantern", "lark", "laurel", "leaf", "ledge", "lemon",
  "lens", "lilac", "lily", "linen", "lion", "lodge", "loom", "lotus",
  "lynx", "magnet", "maple", "marble", "marsh", "meadow", "melon", "mesa",
  "mint", "mirror", "mist", "moon", "moss", "mural", "nectar", "nest",
  "nickel", "night", "noble", "north", "nova", "oak", "oasis", "ocean",
  "olive", "onyx", "opal", "orbit", "orchid", "otter", "owl", "oyster",
  "paddle", "palm", "panda", "pansy", "paper", "parrot", "pearl", "pebble",
  "pepper", "petal", "pigeon", "pine", "pilot", "planet", "plum", "pocket",
  "poem", "pond", "poppy", "prairie", "prism", "puffin", "quail", "quartz",
  "quill", "rabbit", "raven", "reef", "river", "robin", "rose", "ruby",
  "saddle", "sage", "sail", "salmon", "sand", "satin", "scarf", "seal",
  "shade", "shell", "shore", "silk", "silver", "slate", "snow", "solar",
  "spark", "sparrow", "spruce", "stone", "storm", "stream", "summit", "swift",
  "thistle", "thyme", "tide", "tiger", "timber", "topaz", "torch", "tower",
  "trail", "tulip", "tundra", "turtle", "valley", "velvet", "violet", "walnut",
  "wave", "willow", "wind", "winter", "wolf", "wren", "yarn", "yellow",
  "zinc",
]);
