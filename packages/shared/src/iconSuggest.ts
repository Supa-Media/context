/**
 * The emoji the icon picker suggests for a folder or note from its name, and
 * the ones it rolls when somebody asks for a random one (decided by the owner,
 * 2026-10-14: nothing is given an emoji on its own; the picker offers one
 * suggested from the name, and a random one).
 *
 * ## Why every emoji, narrowed down twice
 *
 * The suggestion comes from Clef (`lib/jev/`), which never writes text: it
 * picks one of at most 64 options it is given. The owner asked for the name
 * to be read against the whole emoji set, not a short list, and then for it
 * to be narrowed down rather than knocked out (2026-10-14: "choose one out of
 * 64 evenly divided groups ... then we do it again"). So the picker's own
 * table (`standardEmoji.generated.ts`, 1,870 emoji) is cut into 64 even runs
 * in Unicode's order, which keeps like with like; Clef picks the group most
 * likely to hold the icon, each group listed by its emoji, then the emoji in
 * it. 64 × 64 covers the table, so it is two requests. Every answer is an
 * emoji the picker itself offers, and an answer outside what was asked is no
 * suggestion rather than a guess.
 *
 * It replaced, the same day, a list of 27 topics that answered "none of
 * these" for a name like `once`, and then a knockout over every group that
 * took three requests and ~3.5 seconds.
 *
 * A name that says nothing (`untitled-2026-10-14`, `New folder`, `asdf`) is
 * never sent at all: there is nothing in it to read, and the random roll is
 * the honest answer.
 *
 * Pure, so the control plane and the live check share it and the tests need
 * no model.
 */

import { STANDARD_EMOJI_TABLE } from "./standardEmoji.generated";

/** One emoji a suggestion can be: the character the picker stores, and what Clef reads about it. */
export interface SuggestCandidate {
  readonly char: string;
  /** Its first shortcode, spaced: what a group lists it as. */
  readonly short: string;
  /** Its description and tags: what the second question reads. */
  readonly about: string;
}

let candidates: SuggestCandidate[] | null = null;

/** Every standard emoji, in the table's order, with its description and tags as Clef reads them. */
export function suggestCandidates(): readonly SuggestCandidate[] {
  if (candidates !== null) return candidates;
  candidates = [];
  for (const line of STANDARD_EMOJI_TABLE.split("\n")) {
    const [char, names, tags, description] = line.split("\t");
    if (char === undefined || char === "" || names === undefined || description === undefined) continue;
    const extra = tags === undefined || tags === "" ? "" : ` (${tags.split(" ").join(", ")})`;
    const short = `${char} ${names.split(",")[0]!.replace(/_/g, " ")}`;
    candidates.push({ char, short, about: `${char} ${description}${extra}` });
  }
  return candidates;
}

/** Options in one question: Clef's own ceiling, and so the number of groups. 64 × 64 covers the table. */
export const GROUPS = 64;

let groups: number[][] | null = null;

/** The table cut into `GROUPS` even runs, in its own order, so each holds like with like. */
export function suggestGroups(): readonly (readonly number[])[] {
  if (groups !== null) return groups;
  const total = suggestCandidates().length;
  groups = Array.from({ length: GROUPS }, (_, group) => {
    const start = Math.floor((group * total) / GROUPS);
    const end = Math.floor(((group + 1) * total) / GROUPS);
    return Array.from({ length: end - start }, (_, at) => start + at);
  });
  return groups;
}

/** The emoji a random roll draws from: ones that make a nice surprise, by shortcode. */
const RANDOM_LIST = `
  💼 briefcase 🏢 office 👔 necktie 🤝 handshake 📈 chart_with_upwards_trend 📊 bar_chart 📋 clipboard
  🗂️ card_index_dividers 📁 file_folder 📑 bookmark_tabs 🎯 dart 🏆 trophy 🚀 rocket 📌 pushpin 🧲 magnet
  🗓️ spiral_calendar 📆 calendar 📅 date ⏰ alarm_clock ⌛ hourglass ⏱️ stopwatch ✅ white_check_mark
  ☑️ ballot_box_with_check 📍 round_pushpin 📝 memo ✏️ pencil2 🚩 triangular_flag_on_post 🏁 checkered_flag
  🧭 compass 🗺️ world_map 📚 books 📖 book 📓 notebook 📒 ledger 📕 closed_book 📗 green_book 📘 blue_book
  📙 orange_book 📄 page_facing_up 📜 scroll 📰 newspaper ✒️ black_nib 🖋️ fountain_pen ✍️ writing_hand
  🔖 bookmark 💭 thought_balloon ✉️ envelope 📨 incoming_envelope 📩 envelope_with_arrow 📫 mailbox
  📞 telephone_receiver 📱 iphone 💬 speech_balloon 🗨️ left_speech_bubble 📢 loudspeaker 📣 mega 📡 satellite
  🌐 globe_with_meridians 📇 card_index 👋 wave 👥 busts_in_silhouette 👤 bust_in_silhouette 👪 family
  🫂 people_hugging ❤️ heart 💕 two_hearts 💑 couple_with_heart 👶 baby 🧒 child 🧓 older_adult 🙌 raised_hands
  🤗 hugs 💍 ring 💒 wedding 🎂 birthday 💰 moneybag 💵 dollar 💳 credit_card 🏦 bank 🧾 receipt 🪙 coin
  💸 money_with_wings 💎 gem ⚖️ balance_scale 🧮 abacus 🐷 pig 🏠 house 🏡 house_with_garden 🛋️ couch_and_lamp
  🛏️ bed 🔑 key 🔨 hammer 🔧 wrench 🧰 toolbox 🧹 broom 🪴 potted_plant 🚪 door 🛁 bathtub 🧺 basket 💡 bulb
  🧽 sponge 🍳 fried_egg 🍴 fork_and_knife 🍽️ plate_with_cutlery 🍔 hamburger 🍕 pizza 🍜 ramen 🍣 sushi
  🥗 green_salad ☕ coffee 🍵 tea 🍷 wine_glass 🍺 beer 🍰 cake 🍎 apple 🥑 avocado 🍞 bread 🧁 cupcake 🍲 stew
  🌮 taco 🛒 shopping_cart 💪 muscle 🏃 runner 💊 pill 🩺 stethoscope 🏥 hospital 💉 syringe 🦷 tooth 🧠 brain
  😴 sleeping 🧘 lotus_position 🚴 bicyclist 🏋️ weight_lifting 🏊 swimmer ⚽ soccer 🏀 basketball 🎾 tennis
  🥦 broccoli 🍏 green_apple ✈️ airplane 🧳 luggage 🌎 earth_americas 🏖️ beach_umbrella ⛰️ mountain 🏕️ camping
  🚗 car 🚆 train2 🚌 bus 🚢 ship 🛂 passport_control 🏨 hotel 🗽 statue_of_liberty 🏝️ desert_island
  🌍 earth_africa 🌱 seedling 🌲 evergreen_tree 🌳 deciduous_tree 🌿 herb 🍀 four_leaf_clover 🌻 sunflower
  🌸 cherry_blossom 🌹 rose ☀️ sunny 🌙 crescent_moon ⭐ star 🌈 rainbow 🌊 ocean 🔥 fire ❄️ snowflake ⚡ zap
  ☁️ cloud 🍄 mushroom 🌵 cactus 🍂 fallen_leaf 🐶 dog 🐱 cat 🦊 fox_face 🐻 bear 🐼 panda_face 🐰 rabbit 🦉 owl
  🐦 bird 🦋 butterfly 🐝 bee 🐢 turtle 🐙 octopus 🐳 whale 🐬 dolphin 🐴 horse 🦄 unicorn 🦁 lion
  🐵 monkey_face 🐧 penguin 🐸 frog 🎵 musical_note 🎶 notes 🎸 guitar 🎤 microphone 🎙️ studio_microphone
  🎧 headphones 🎹 musical_keyboard 🥁 drum 🎻 violin 🎺 trumpet 🎷 saxophone 📻 radio 🔊 loud_sound
  🎚️ level_slider 🎨 art 🖌️ paintbrush 🖍️ crayon 🖼️ framed_picture 📷 camera 📸 camera_flash 🎥 movie_camera
  🎬 clapper 🎞️ film_strip 📐 triangular_ruler ✂️ scissors 🧵 thread 🧶 yarn ✨ sparkles 🎭 performing_arts
  👗 dress 👕 shirt 💄 lipstick 💻 computer 🖥️ desktop_computer ⌨️ keyboard 🤖 robot ⚙️ gear 🔌 electric_plug
  🔋 battery 💾 floppy_disk 🐛 bug 🔒 lock 🛡️ shield 🔗 link 📦 package 🧩 jigsaw 🛠️ hammer_and_wrench
  🔬 microscope 🔭 telescope 🧪 test_tube 🧬 dna ⚛️ atom_symbol 🪐 ringed_planet 🌌 milky_way ⚗️ alembic
  🧫 petri_dish 🔢 1234 🎓 mortar_board 🏫 school 📏 straight_ruler 🔤 abc 🎒 school_satchel 🗣️ speaking_head
  🙏 pray ⛪ church 🛐 place_of_worship 🕊️ dove 🕯️ candle ✝️ latin_cross ✡️ star_of_david 🕌 mosque 🌅 sunrise
  🎉 tada 🎊 confetti_ball 🎈 balloon 🎁 gift 🎇 sparkler 🎆 fireworks 🎟️ tickets 🎪 circus_tent 💃 dancer
  🍾 champagne 🥂 clinking_glasses 🥳 partying_face 🎮 video_game 🕹️ joystick 🎲 game_die ♟️ chess_pawn
  🏈 football ⚾ baseball ⛳ golf 🏅 medal_sports 🥇 1st_place_medal 🎳 bowling 🏓 ping_pong 🔮 crystal_ball
  🔍 mag ❓ question 👀 eyes 💫 dizzy 🗄️ file_cabinet 🗃️ card_file_box 🗑️ wastebasket 📂 open_file_folder
  📥 inbox_tray 📤 outbox_tray 🗝️ old_key ⏳ hourglass_flowing_sand 🏛️ classical_building 📃 page_with_curl
  🪪 identification_card 🗳️ ballot_box 🛍️ shopping 🏷️ label 👓 eyeglasses 👜 handbag 👟 athletic_shoe ⌚ watch
  📺 tv 📽️ film_projector 🏗️ building_construction 🚧 construction 🧱 bricks 🔩 nut_and_bolt
`;

/** One emoji of the random pool: its character and shortcode. */
export interface SuggestEmoji {
  readonly char: string;
  readonly name: string;
}

/** Every emoji a random roll can land on, once each. */
export const SUGGEST_EMOJI: readonly SuggestEmoji[] = (() => {
  const parts = RANDOM_LIST.trim().split(/\s+/);
  const out: SuggestEmoji[] = [];
  for (let at = 0; at + 1 < parts.length; at += 2) out.push({ char: parts[at]!, name: parts[at + 1]! });
  return out;
})();

/** Emoji that make a poor surprise: fine when the name asks for them, not as a random pick. */
const NOT_RANDOM = new Set(["🗑️", "🐛", "💉", "💊", "🏥", "🩺", "🦷", "⚖️", "🪪", "🗳️", "🛂", "🔒", "🚧", "❓", "😴"]);

/** A random emoji from the list. `random` is `Math.random` unless a test passes its own. */
export function randomIcon(random: () => number = Math.random, not?: string | null): string {
  const pool = SUGGEST_EMOJI.filter((one) => !NOT_RANDOM.has(one.char) && one.char !== not);
  const at = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[at]!.char;
}

/** The longest name worth reading. Past this it is a sentence, and its start says enough. */
const MAX_NAME_CHARS = 120;
/** Words that name nothing: a placeholder, a default, a keyboard mash. */
const EMPTY_WORDS = new Set([
  "untitled", "new", "note", "notes", "folder", "file", "drawing", "copy", "of", "test", "tmp", "temp",
  "draft", "misc", "stuff", "things", "asdf", "qwerty", "foo", "bar", "baz", "x", "xx", "xxx", "todo",
]);

/**
 * The words of a folder's or note's name, as a person would read them: no
 * extension, no sort prefix, no dates or numbers, `-` and `_` as spaces.
 */
export function nameWords(path: string): string {
  const leaf = path.split("/").pop() ?? "";
  return leaf
    .replace(/\.excalidraw\.md$/i, "")
    .replace(/\.md$/i, "")
    .replace(/\d{4}-\d{2}-\d{2}(t[\d-]+z?)?/gi, " ")
    .replace(/[-_.]+/g, " ")
    .replace(/\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_CHARS);
}

/** Whether a name says anything worth asking about. `untitled-2026-10-14` and `New folder 2` do not. */
export function nameSaysSomething(path: string): boolean {
  const words = nameWords(path).toLowerCase().split(" ").filter((word) => /\p{L}/u.test(word));
  return words.some((word) => !EMPTY_WORDS.has(word) && word.length > 1);
}

/** What Clef reads: the name, and what kind of thing it is. Never a note's text. */
function stateFor(path: string, kind: "folder" | "note"): string {
  return `A ${kind} in someone's notes is named "${nameWords(path)}".`;
}

const groupInstructions = (kind: "folder" | "note") =>
  `Which of these groups of emoji most likely holds the best icon for this ${kind}, judging by its name?`;

const emojiInstructions = (kind: "folder" | "note") =>
  `Which emoji would make the best icon for this ${kind}, judging by its name? ` +
  "Pick the one whose meaning is closest to the name, even if none is perfect.";

/** A Clef request: what `jev.decide` and the live check's Worker both take. */
export interface SuggestRequest {
  state: string;
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
}

/** Asks Clef, and answers its answers or `null` when it did not. */
export type SuggestDecide = (request: SuggestRequest) => Promise<Record<string, unknown> | null>;

/** The first question: which group most likely holds the emoji? Each group is listed by its emoji. */
export function groupRequest(path: string, kind: "folder" | "note"): SuggestRequest {
  const all = suggestCandidates();
  const criteria: Record<string, string> = {};
  for (const [group, members] of suggestGroups().entries()) {
    criteria[`g${group}`] = members.map((index) => all[index]!.short).join(", ");
  }
  return { state: stateFor(path, kind), questions: { group: { type: "choice", instructions: groupInstructions(kind), criteria } } };
}

/** The second question: which emoji in that group? `null` for a group that does not exist. */
export function emojiRequest(path: string, kind: "folder" | "note", group: number): SuggestRequest | null {
  const members = suggestGroups()[group];
  if (members === undefined) return null;
  const all = suggestCandidates();
  const criteria: Record<string, string> = {};
  for (const index of members) criteria[`e${index}`] = all[index]!.about;
  return { state: stateFor(path, kind), questions: { emoji: { type: "choice", instructions: emojiInstructions(kind), criteria } } };
}

/**
 * The emoji Clef picked for each question of `request`, by index, leaving
 * out every answer that is not one of the options that question offered.
 */
export function readPicks(request: SuggestRequest, answers: Record<string, unknown> | null): number[] {
  const picks: number[] = [];
  for (const [name, question] of Object.entries(request.questions)) {
    const answer = answers?.[name] as { type?: unknown; choice?: unknown } | undefined;
    if (answer?.type !== "choice" || typeof answer.choice !== "string") continue;
    if (!Object.prototype.hasOwnProperty.call(question.criteria, answer.choice)) continue;
    picks.push(Number(answer.choice.slice(1)));
  }
  return picks;
}

/**
 * The emoji to suggest for `path`, from its name alone, or `null`: a name
 * that says nothing (nothing is asked), or Clef answering nothing usable.
 * Two questions, one after the other: the group, then the emoji in it.
 */
export async function suggestIconFor(path: string, decide: SuggestDecide): Promise<string | null> {
  if (!nameSaysSomething(path)) return null;
  const kind = path.toLowerCase().endsWith(".md") ? "note" : "folder";
  // The engine now and then fails one request; asked once more, it answers.
  const ask = async (request: SuggestRequest) => (await decide(request)) ?? (await decide(request));
  const first = groupRequest(path, kind);
  const [group] = readPicks(first, await ask(first));
  const second = group === undefined ? null : emojiRequest(path, kind, group);
  if (second === null) return null;
  const [pick] = readPicks(second, await ask(second));
  return pick === undefined ? null : suggestCandidates()[pick]!.char;
}
