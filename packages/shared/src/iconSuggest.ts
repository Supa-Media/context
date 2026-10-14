/**
 * The emoji the icon picker suggests for a folder or note from its name, and
 * the ones it rolls when somebody asks for a random one (decided by the owner,
 * 2026-10-14: nothing is given an emoji on its own; the picker offers one
 * suggested from the name, and a random one).
 *
 * ## Why a short list and two questions
 *
 * The suggestion comes from Clef (`lib/jev/`), which never writes text: it
 * picks one of at most 64 options it is given. So it is asked twice. First
 * which of the topics below the name is about, or none of them; then which
 * emoji in that topic fits best. Every answer is therefore one of the emoji
 * written here, and every one of those is checked against the picker's own
 * table by `iconSuggest.test.ts`, so a suggestion is always something the
 * picker could have offered by hand.
 *
 * A name that says nothing (`untitled-2026-10-14`, `New folder`, `asdf`) is
 * never sent at all: there is nothing in it to read, and the random roll is
 * the honest answer.
 *
 * Pure, so the control plane and the app share it and the tests need no model.
 */

/** One emoji: the character the picker stores, and its shortcode (the option key Clef answers with). */
export interface SuggestEmoji {
  readonly char: string;
  readonly name: string;
}

export interface SuggestTopic {
  /** The option key. */
  readonly key: string;
  /** What Clef reads to decide whether a name is about this. */
  readonly about: string;
  readonly emoji: readonly SuggestEmoji[];
}

/** `"🗓️ spiral_calendar 📅 date"` to its pairs. Written this way so the list stays readable. */
function pairs(text: string): SuggestEmoji[] {
  const parts = text.trim().split(/\s+/);
  const out: SuggestEmoji[] = [];
  for (let at = 0; at + 1 < parts.length; at += 2) out.push({ char: parts[at]!, name: parts[at + 1]! });
  return out;
}

function topic(key: string, about: string, emoji: string): SuggestTopic {
  return { key, about, emoji: pairs(emoji) };
}

export const SUGGEST_TOPICS: readonly SuggestTopic[] = [
  topic("work", "Work, business, a company, a job, clients, meetings, reports",
    "💼 briefcase 🏢 office 👔 necktie 🤝 handshake 📈 chart_with_upwards_trend 📊 bar_chart 📋 clipboard 🗂️ card_index_dividers 📁 file_folder 📑 bookmark_tabs 🎯 dart 🏆 trophy 🚀 rocket 📌 pushpin 🧲 magnet"),
  topic("planning", "Plans, schedules, calendars, deadlines, to-do lists, goals, routines",
    "🗓️ spiral_calendar 📆 calendar 📅 date ⏰ alarm_clock ⌛ hourglass ⏱️ stopwatch ✅ white_check_mark ☑️ ballot_box_with_check 📍 round_pushpin 📝 memo ✏️ pencil2 🚩 triangular_flag_on_post 🏁 checkered_flag 🧭 compass 🗺️ world_map"),
  topic("writing", "Writing, reading, notes, journals, books, drafts, essays, quotes",
    "📚 books 📖 book 📓 notebook 📒 ledger 📕 closed_book 📗 green_book 📘 blue_book 📙 orange_book 📄 page_facing_up 📜 scroll 📰 newspaper ✒️ black_nib 🖋️ fountain_pen ✍️ writing_hand 🔖 bookmark 💭 thought_balloon"),
  topic("communication", "Messages, email, chat, phone calls, contacts, announcements, social media",
    "✉️ envelope 📨 incoming_envelope 📩 envelope_with_arrow 📫 mailbox 📞 telephone_receiver 📱 iphone 💬 speech_balloon 🗨️ left_speech_bubble 📢 loudspeaker 📣 mega 📡 satellite 🌐 globe_with_meridians 📇 card_index 👋 wave"),
  topic("people", "People, family, friends, relationships, a team, a community, kids, love",
    "👥 busts_in_silhouette 👤 bust_in_silhouette 👪 family 🫂 people_hugging 🤝 handshake ❤️ heart 💕 two_hearts 💑 couple_with_heart 👶 baby 🧒 child 🧓 older_adult 🙌 raised_hands 🤗 hugs 💍 ring 💒 wedding 🎂 birthday"),
  topic("money", "Money, finance, budgets, taxes, invoices, banking, investing, expenses, pricing",
    "💰 moneybag 💵 dollar 💳 credit_card 🏦 bank 🧾 receipt 🪙 coin 💸 money_with_wings 💎 gem ⚖️ balance_scale 🧮 abacus 📈 chart_with_upwards_trend 🐷 pig"),
  topic("home", "Home, house, apartment, chores, repairs, furniture, garden, moving house",
    "🏠 house 🏡 house_with_garden 🛋️ couch_and_lamp 🛏️ bed 🔑 key 🔨 hammer 🔧 wrench 🧰 toolbox 🧹 broom 🪴 potted_plant 🚪 door 🛁 bathtub 🧺 basket 💡 bulb 🧽 sponge"),
  topic("food", "Food, cooking, recipes, restaurants, groceries, drinks, coffee, meals",
    "🍳 fried_egg 🍴 fork_and_knife 🍽️ plate_with_cutlery 🍔 hamburger 🍕 pizza 🍜 ramen 🍣 sushi 🥗 green_salad ☕ coffee 🍵 tea 🍷 wine_glass 🍺 beer 🍰 cake 🍎 apple 🥑 avocado 🍞 bread 🧁 cupcake 🍲 stew 🌮 taco 🛒 shopping_cart"),
  topic("health", "Health, fitness, exercise, doctors, medicine, sleep, mental health, sport",
    "💪 muscle 🏃 runner 💊 pill 🩺 stethoscope 🏥 hospital 💉 syringe 🦷 tooth 🧠 brain 😴 sleeping 🧘 lotus_position 🚴 bicyclist 🏋️ weight_lifting 🏊 swimmer ⚽ soccer 🏀 basketball 🎾 tennis 🥦 broccoli 🍏 green_apple"),
  topic("travel", "Travel, trips, holidays, flights, hotels, places, cities, commuting, cars",
    "✈️ airplane 🧳 luggage 🗺️ world_map 🌎 earth_americas 🏖️ beach_umbrella ⛰️ mountain 🏕️ camping 🚗 car 🚆 train2 🚌 bus 🚢 ship 🛂 passport_control 🏨 hotel 🗽 statue_of_liberty 🏝️ desert_island 🧭 compass 🌍 earth_africa"),
  topic("nature", "Nature, plants, weather, seasons, the outdoors, the environment, sky, the sea",
    "🌱 seedling 🌲 evergreen_tree 🌳 deciduous_tree 🌿 herb 🍀 four_leaf_clover 🌻 sunflower 🌸 cherry_blossom 🌹 rose ☀️ sunny 🌙 crescent_moon ⭐ star 🌈 rainbow 🌊 ocean 🔥 fire ❄️ snowflake ⚡ zap ☁️ cloud 🍄 mushroom 🌵 cactus 🍂 fallen_leaf"),
  topic("animals", "Animals, pets, dogs, cats, birds, wildlife",
    "🐶 dog 🐱 cat 🦊 fox_face 🐻 bear 🐼 panda_face 🐰 rabbit 🦉 owl 🐦 bird 🦋 butterfly 🐝 bee 🐢 turtle 🐙 octopus 🐳 whale 🐬 dolphin 🐴 horse 🦄 unicorn 🦁 lion 🐵 monkey_face 🐧 penguin 🐸 frog"),
  topic("music", "Music, songs, bands, gigs, audio, podcasts, recording, playlists",
    "🎵 musical_note 🎶 notes 🎸 guitar 🎤 microphone 🎙️ studio_microphone 🎧 headphones 🎹 musical_keyboard 🥁 drum 🎻 violin 🎺 trumpet 🎷 saxophone 📻 radio 🔊 loud_sound 🎚️ level_slider"),
  topic("art", "Art, design, drawing, photos, video, film, fashion, crafts, creativity",
    "🎨 art 🖌️ paintbrush 🖍️ crayon 🖼️ framed_picture 📷 camera 📸 camera_flash 🎥 movie_camera 🎬 clapper 🎞️ film_strip 📐 triangular_ruler ✂️ scissors 🧵 thread 🧶 yarn ✨ sparkles 🎭 performing_arts 👗 dress 👕 shirt 💄 lipstick"),
  topic("tech", "Technology, software, code, apps, computers, AI, data, the internet, security",
    "💻 computer 🖥️ desktop_computer ⌨️ keyboard 📱 iphone 🤖 robot ⚙️ gear 🔌 electric_plug 🔋 battery 💾 floppy_disk 🐛 bug 🔒 lock 🔑 key 🛡️ shield 🔗 link 📦 package 🧩 jigsaw 🛠️ hammer_and_wrench 🌐 globe_with_meridians"),
  topic("science", "Science, research, experiments, space, medicine research, engineering, maths",
    "🔬 microscope 🔭 telescope 🧪 test_tube 🧬 dna ⚛️ atom_symbol 🧲 magnet 🪐 ringed_planet 🌌 milky_way ⚗️ alembic 🧫 petri_dish 📐 triangular_ruler 🔢 1234 🧮 abacus 🚀 rocket"),
  topic("learning", "School, learning, studying, courses, classes, teaching, homework, languages",
    "🎓 mortar_board 🏫 school 📚 books ✏️ pencil2 📏 straight_ruler 🔤 abc 🎒 school_satchel 🧠 brain 💡 bulb 📝 memo 🗣️ speaking_head 🌍 earth_africa"),
  topic("faith", "Faith, church, worship, prayer, ministry, spirituality, religion, a congregation",
    "🙏 pray ⛪ church 🛐 place_of_worship 🕊️ dove 🕯️ candle ✝️ latin_cross ✡️ star_of_david 🕌 mosque 🙌 raised_hands 🌅 sunrise 📖 book ❤️ heart 🎶 notes"),
  topic("events", "Events, parties, celebrations, birthdays, weddings, gatherings, tickets, festivals",
    "🎉 tada 🎊 confetti_ball 🎈 balloon 🎁 gift 🎂 birthday 🎇 sparkler 🎆 fireworks 🎟️ tickets 🎪 circus_tent 💃 dancer 🍾 champagne 🥂 clinking_glasses 🥳 partying_face 🎭 performing_arts"),
  topic("games", "Games, sport, play, competitions, hobbies, puzzles",
    "🎮 video_game 🕹️ joystick 🎲 game_die 🧩 jigsaw ♟️ chess_pawn ⚽ soccer 🏀 basketball 🏈 football ⚾ baseball 🎾 tennis ⛳ golf 🏆 trophy 🏅 medal_sports 🥇 1st_place_medal 🎳 bowling 🏓 ping_pong"),
  topic("ideas", "Ideas, thinking, brainstorming, questions, inspiration, dreams, research notes",
    "💡 bulb 💭 thought_balloon 🧠 brain ✨ sparkles 🔮 crystal_ball 🔍 mag ❓ question 👀 eyes ⭐ star 💫 dizzy 🌈 rainbow 🔭 telescope 🧩 jigsaw"),
  topic("storage", "Archives, old things, backups, storage, files kept for later, inbox, trash",
    "🗄️ file_cabinet 🗃️ card_file_box 📦 package 🗑️ wastebasket 🗂️ card_index_dividers 📁 file_folder 📂 open_file_folder 📥 inbox_tray 📤 outbox_tray 🗝️ old_key ⏳ hourglass_flowing_sand"),
  topic("legal", "Legal, contracts, government, policies, rules, documents, IDs, voting",
    "⚖️ balance_scale 🏛️ classical_building 📃 page_with_curl 📜 scroll ✒️ black_nib 🔒 lock 🛡️ shield 🪪 identification_card 🗳️ ballot_box 📋 clipboard"),
  topic("shopping", "Shopping, products, orders, wishlists, clothes, gifts to buy",
    "🛍️ shopping 🛒 shopping_cart 🎁 gift 🏷️ label 📦 package 💳 credit_card 🧾 receipt 👓 eyeglasses 👜 handbag 👟 athletic_shoe ⌚ watch 👗 dress"),
  topic("media", "News, media, TV, film, video, podcasts, press, content, publishing, a website",
    "📰 newspaper 📺 tv 📻 radio 🎥 movie_camera 🎬 clapper 📷 camera 🎙️ studio_microphone 📽️ film_projector 📢 loudspeaker 🌐 globe_with_meridians 🖥️ desktop_computer"),
  topic("marketing", "Marketing, growth, sales, launches, ads, brand, customers, outreach",
    "📣 mega 📈 chart_with_upwards_trend 🚀 rocket 🎯 dart 🌱 seedling ⭐ star 🔥 fire 🤝 handshake 💬 speech_balloon 🏆 trophy 🧲 magnet ✨ sparkles"),
  topic("building", "Building, construction, projects in progress, making things, engineering, renovation",
    "🏗️ building_construction 🚧 construction 🛠️ hammer_and_wrench 🧱 bricks 📐 triangular_ruler ⚙️ gear 🧰 toolbox 🔨 hammer 🔩 nut_and_bolt 🚀 rocket"),
];

/** The option Clef picks when the name is about none of the topics. */
export const NO_TOPIC = "none_of_these";

/** Every emoji in the list, once each, in order: what a random roll draws from. */
export const SUGGEST_EMOJI: readonly SuggestEmoji[] = (() => {
  const seen = new Set<string>();
  const all: SuggestEmoji[] = [];
  for (const { emoji } of SUGGEST_TOPICS) {
    for (const one of emoji) {
      if (seen.has(one.char)) continue;
      seen.add(one.char);
      all.push(one);
    }
  }
  return all;
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

/** The first question: which topic is this name about? */
export function topicRequest(path: string, kind: "folder" | "note") {
  const criteria: Record<string, string> = {};
  for (const one of SUGGEST_TOPICS) criteria[one.key] = one.about;
  criteria[NO_TOPIC] = "None of these: the name is not about any of these topics, or says nothing";
  return {
    state: stateFor(path, kind),
    questions: {
      topic: {
        type: "choice",
        instructions: `Which topic is this ${kind} about, judging by its name alone?`,
        criteria,
      },
    },
  };
}

/** The second question: which emoji in that topic fits the name best? */
export function emojiRequest(path: string, kind: "folder" | "note", topicKey: string) {
  const chosen = SUGGEST_TOPICS.find((one) => one.key === topicKey);
  if (chosen === undefined) return null;
  const criteria: Record<string, string> = {};
  for (const one of chosen.emoji) criteria[one.name] = one.name.replace(/_/g, " ");
  return {
    state: stateFor(path, kind),
    questions: {
      emoji: {
        type: "choice",
        instructions: `Which emoji would make the best icon for this ${kind}, judging by its name?`,
        criteria,
      },
    },
  };
}

function choiceOf(answers: Record<string, unknown> | null, question: string): string | null {
  const answer = answers?.[question] as { type?: unknown; choice?: unknown } | undefined;
  return answer?.type === "choice" && typeof answer.choice === "string" ? answer.choice : null;
}

/** The topic Clef picked, or `null` for none and anything unexpected. */
export function readTopic(answers: Record<string, unknown> | null): string | null {
  const choice = choiceOf(answers, "topic");
  return choice !== null && SUGGEST_TOPICS.some((one) => one.key === choice) ? choice : null;
}

/** The emoji Clef picked in `topicKey`, as its character, or `null` for anything not offered. */
export function readEmoji(answers: Record<string, unknown> | null, topicKey: string): string | null {
  const choice = choiceOf(answers, "emoji");
  const chosen = SUGGEST_TOPICS.find((one) => one.key === topicKey);
  return chosen?.emoji.find((one) => one.name === choice)?.char ?? null;
}
