/**
 * Context's own icons: a hundred drawings in the brush of the built-in
 * folders' icons, offered first in the folder and note icon picker, with every
 * emoji still a tap away (decided by the owner, 2026-10-21: "a set of 100
 * context-styled emojis that will be the default ... great for uniformity").
 * Boards: the "Context icon set" canvas.
 *
 * ## How one is stored
 *
 * A chosen Context icon is `context:icon:<name>`, in the same icon rows and
 * the same `.context/folder-icons.json` an emoji goes in. The name is from
 * this list, never anything else, so the setter refuses an unknown one. The
 * drawing itself is the app's (`files/contextIcons/drawings.ts`); here is only
 * what every side needs to agree on: the names, what each is called, the words
 * search and the suggestion read, and its emoji twin.
 *
 * ## The emoji twin
 *
 * Wherever a drawing can't go (an AI client's answer, a notification, a plain
 * listing), the icon is written as its twin, so `context:icon:rocket` reads 🚀.
 * `iconAsText` is that rule.
 *
 * ## Built-in parts
 *
 * The folders Context files into inside Tex's folder and the Inbox draw from
 * the same brush in Tex blue (`context:part:<name>`, `folderIcons.cjs`'s
 * defaults). Those are drawn, never written, and nobody can choose one.
 */

const CONTEXT_ICON_PREFIX = "context:icon:";
const CONTEXT_PART_PREFIX = "context:part:";

/** The families, in the order the picker shows them. */
const CONTEXT_ICON_FAMILIES = Object.freeze([
  "work",
  "money",
  "home",
  "people",
  "learning",
  "making",
  "health",
  "travel",
  "nature",
  "community",
  "things",
  "symbols",
]);

const CONTEXT_ICON_FAMILY_LABEL = Object.freeze({
  work: "Work",
  money: "Money",
  home: "Home",
  people: "People",
  learning: "Learning",
  making: "Making",
  health: "Health",
  travel: "Travel",
  nature: "Nature",
  community: "Church & community",
  things: "Things",
  symbols: "Symbols",
});

// [name, label, emoji twin, family, more words search and the suggestion read]
const ROWS = [
  ["briefcase", "Briefcase", "💼", "work", "job office business career clients"],
  ["target", "Target", "🎯", "work", "goal goals aim okr focus"],
  ["rocket", "Rocket", "🚀", "work", "launch startup ship release"],
  ["lightbulb", "Idea", "💡", "work", "ideas brainstorm think"],
  ["chart", "Chart", "📊", "work", "metrics stats analytics report growth"],
  ["megaphone", "Announce", "📣", "work", "marketing announcements promo campaign"],
  ["flag", "Flag", "🚩", "work", "milestone country"],
  ["trophy", "Trophy", "🏆", "work", "win wins awards achievement"],
  ["calendar", "Calendar", "📅", "work", "schedule events dates planning"],
  ["clock", "Clock", "🕒", "work", "time hours timesheet"],
  ["pin", "Pin", "📌", "work", "pinned important"],
  ["checklist", "Checklist", "✅", "work", "todo todos tasks list"],
  ["coin", "Coin", "🪙", "money", "money finance finances dollar cash budget"],
  ["wallet", "Wallet", "👛", "money", "spending personal finance"],
  ["receipt", "Receipt", "🧾", "money", "receipts invoices expenses bills taxes"],
  ["card", "Card", "💳", "money", "credit payments subscriptions"],
  ["bank", "Bank", "🏦", "money", "banking accounts loans mortgage"],
  ["piggy", "Savings", "🐷", "money", "save saving piggy bank"],
  ["tag", "Price", "🏷️", "money", "pricing sale deals labels"],
  ["cart", "Shopping", "🛒", "money", "groceries buy store wishlist"],
  ["house", "Home", "🏠", "home", "house household apartment family"],
  ["key", "Key", "🔑", "home", "keys access rental landlord"],
  ["sofa", "Living", "🛋️", "home", "furniture interior decor"],
  ["plant", "Plant", "🪴", "home", "plants garden gardening"],
  ["mug", "Coffee", "☕", "home", "cafe tea breakfast"],
  ["utensils", "Food", "🍴", "home", "recipes cooking meals restaurants dinner"],
  ["baby", "Kids", "🍼", "home", "baby children parenting family"],
  ["paw", "Pets", "🐾", "home", "pet dog cat vet"],
  ["gift", "Gift", "🎁", "home", "gifts presents birthday christmas"],
  ["person", "Person", "👤", "people", "me profile contact someone"],
  ["people", "People", "👥", "people", "team contacts friends group"],
  ["chat", "Chat", "💬", "people", "messages conversations talk"],
  ["mail", "Mail", "✉️", "people", "email letters newsletter"],
  ["phone", "Phone", "📱", "people", "mobile calls texts app"],
  ["smile", "Smile", "🙂", "people", "happy fun personal journal mood"],
  ["heart", "Love", "❤️", "people", "relationship dating favourites favorites wedding"],
  ["id", "About", "🪪", "people", "identity profile bio documents passport"],
  ["party", "Party", "🎉", "people", "birthday celebration events cake"],
  ["book", "Book", "📖", "learning", "books reading library notes"],
  ["cap", "School", "🎓", "learning", "university college class course study education"],
  ["pencil", "Write", "✏️", "learning", "writing drafts essays blog"],
  ["notebook", "Notes", "📓", "learning", "journal diary notebook"],
  ["flask", "Science", "🧪", "learning", "research experiment lab chemistry"],
  ["globe", "World", "🌍", "learning", "website international geography languages"],
  ["puzzle", "Puzzle", "🧩", "learning", "problems integrations pieces"],
  ["brush", "Art", "🎨", "making", "design painting drawing creative palette"],
  ["music", "Music", "🎵", "making", "songs band setlist worship audio"],
  ["camera", "Photos", "📷", "making", "photography pictures images"],
  ["film", "Video", "🎬", "making", "videos film movies youtube"],
  ["mic", "Podcast", "🎙️", "making", "recording audio interview meetings"],
  ["code", "Code", "💻", "making", "programming software dev engineering"],
  ["laptop", "Computer", "🖥️", "making", "tech setup devices"],
  ["scissors", "Craft", "✂️", "making", "crafts diy sewing"],
  ["shirt", "Fashion", "👕", "making", "clothes style wardrobe merch"],
  ["gamepad", "Games", "🎮", "making", "gaming play hobby"],
  ["pulse", "Health", "🩺", "health", "medical doctor wellness"],
  ["dumbbell", "Fitness", "🏋️", "health", "gym workout training exercise"],
  ["apple", "Nutrition", "🍎", "health", "diet eating meal plan"],
  ["pill", "Medicine", "💊", "health", "prescriptions pharmacy"],
  ["run", "Running", "🏃", "health", "run marathon sport"],
  ["bike", "Cycling", "🚲", "health", "bike bicycle ride"],
  ["tooth", "Dentist", "🦷", "health", "teeth dental"],
  ["plane", "Travel", "✈️", "travel", "trips flights vacation holiday"],
  ["car", "Car", "🚗", "travel", "driving vehicle commute"],
  ["map-pin", "Place", "📍", "travel", "places location address local"],
  ["map", "Map", "🗺️", "travel", "maps itinerary plans"],
  ["tent", "Camping", "⛺", "travel", "camp outdoors retreat"],
  ["sun", "Sun", "☀️", "nature", "summer day morning daily"],
  ["moon", "Night", "🌙", "nature", "evening sleep monthly"],
  ["rain", "Weather", "🌧️", "nature", "rain cloud forecast"],
  ["snow", "Winter", "❄️", "nature", "snow cold christmas"],
  ["leaf", "Leaf", "🍃", "nature", "nature autumn fall eco"],
  ["tree", "Tree", "🌳", "nature", "trees park family tree"],
  ["flower", "Flower", "🌸", "nature", "flowers spring garden"],
  ["mountain", "Outdoors", "⛰️", "nature", "hiking mountains climbing"],
  ["waves", "Sea", "🌊", "nature", "ocean beach surf water"],
  ["fire", "Fire", "🔥", "nature", "hot urgent trending"],
  ["bolt", "Energy", "⚡", "nature", "power quick electric"],
  ["sprout", "Grow", "🌱", "nature", "growth habits new beginnings"],
  ["church", "Church", "⛪", "community", "faith worship ministry sunday"],
  ["candle", "Prayer", "🕯️", "community", "pray prayers devotional faith"],
  ["group", "Community", "🫂", "community", "small group members volunteers"],
  ["ticket", "Tickets", "🎟️", "community", "events concerts shows"],
  ["bookmark", "Saved", "🔖", "things", "bookmarks reading list later"],
  ["page", "Page", "📄", "things", "document docs file"],
  ["bell", "Reminders", "🔔", "things", "notifications alerts attention"],
  ["link", "Links", "🔗", "things", "urls web resources"],
  ["search", "Research", "🔍", "things", "find investigate explore"],
  ["umbrella", "Insurance", "☂️", "things", "cover protection rainy day"],
  ["shield", "Safety", "🛡️", "things", "security privacy protection"],
  ["scales", "Legal", "⚖️", "things", "law contracts lawyer justice"],
  ["news", "News", "📰", "things", "newsletter press articles"],
  ["star", "Star", "⭐", "symbols", "favourite favorite best"],
  ["sparkle", "Sparkle", "✨", "symbols", "magic new special ai"],
  ["check", "Done", "✔️", "symbols", "complete finished approved"],
  ["question", "Question", "❓", "symbols", "questions faq unknown help"],
  ["bang", "Important", "❗", "symbols", "urgent warning attention"],
  ["plus", "New", "➕", "symbols", "add extra more"],
  ["loop", "Repeat", "🔁", "symbols", "recurring routine routines habits"],
  ["hash", "Topic", "#️⃣", "symbols", "tag topics channel number"],
];

/** Every Context icon, in the picker's order. */
const CONTEXT_ICONS = Object.freeze(
  ROWS.map(([name, label, emoji, family, words]) =>
    Object.freeze({ name, label, emoji, family, words: `${label.toLowerCase()} ${name.replace(/-/g, " ")} ${words}` }),
  ),
);

const BY_NAME = new Map(CONTEXT_ICONS.map((icon) => [icon.name, icon]));

/** The stored spelling of the Context icon `name`. */
function contextIconMarker(name) {
  return `${CONTEXT_ICON_PREFIX}${name}`;
}

/** The Context icon an icon string names, or `null` for an emoji, a `:name:` or anything else. */
function contextIconOf(icon) {
  if (typeof icon !== "string" || !icon.startsWith(CONTEXT_ICON_PREFIX)) return null;
  return BY_NAME.get(icon.slice(CONTEXT_ICON_PREFIX.length)) ?? null;
}

/** The drawn built-in part an icon string names (`context:part:<name>`), or `null`. */
function contextPartOf(icon) {
  if (typeof icon !== "string" || !icon.startsWith(CONTEXT_PART_PREFIX)) return null;
  const name = icon.slice(CONTEXT_PART_PREFIX.length);
  return Object.prototype.hasOwnProperty.call(PART_EMOJI, name) ? name : null;
}

/**
 * The drawn icons of the folders Context files into inside Tex's folder and
 * the Inbox, each with the emoji it showed before (its twin).
 */
const PART_EMOJI = Object.freeze({
  tex_about: "🪪",
  tex_attention: "🔔",
  tex_dreams: "💤",
  tex_heartbeat: "💓",
  tex_housekeeping: "🧹",
  tex_jobs: "📋",
  tex_chats: "🗨️",
  tex_groups: "👥",
  tex_handbacks: "↩️",
  tex_routines: "🔁",
  tex_skills: "🧠",
  tex_transcripts: "💬",
  cadence_once: "📌",
  cadence_minute: "⏱️",
  cadence_hour: "⏳",
  cadence_day: "☀️",
  cadence_week: "📅",
  cadence_month: "🌙",
  cadence_year: "🎆",
  inbox_calendar: "🗓️",
  inbox_contacts: "📇",
  inbox_email: "✉️",
  inbox_forms: "📝",
  inbox_chat: "💬",
  inbox_imessage: "📲",
  inbox_meetings: "🎙️",
  inbox_memories: "💭",
  inbox_sessions: "🤖",
  inbox_capture: "📨",
  inbox_granola: "🥣",
});

function contextPartMarker(name) {
  return `${CONTEXT_PART_PREFIX}${name}`;
}

/**
 * An icon as text, for anywhere a drawing can't go: a Context icon or a drawn
 * part as its emoji twin, anything else (an emoji, a `:name:`) as it is.
 */
function iconAsText(icon) {
  const context = contextIconOf(icon);
  if (context !== null) return context.emoji;
  const part = contextPartOf(icon);
  if (part !== null) return PART_EMOJI[part];
  return icon;
}

/** The Context icons whose words hold every word of `query`, best first: a label match before a word match. */
function searchContextIcons(query) {
  const needles = String(query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
  if (needles.length === 0) return [];
  const scored = [];
  for (const icon of CONTEXT_ICONS) {
    const words = icon.words.split(" ");
    let score = 0;
    let all = true;
    for (const needle of needles) {
      if (icon.label.toLowerCase() === needle) score += 3;
      else if (words.includes(needle)) score += 2;
      else if (words.some((word) => word.startsWith(needle))) score += 1;
      else all = false;
    }
    if (all) scored.push({ icon, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.icon);
}

/** A random Context icon's stored spelling, never `not` (so Shuffle always changes it). */
function randomContextIcon(random = Math.random, not = null) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pick = contextIconMarker(CONTEXT_ICONS[Math.floor(random() * CONTEXT_ICONS.length)].name);
    if (pick !== not) return pick;
  }
  return contextIconMarker(CONTEXT_ICONS[0].name === contextIconOf(not)?.name ? CONTEXT_ICONS[1].name : CONTEXT_ICONS[0].name);
}

module.exports = {
  CONTEXT_ICON_PREFIX,
  CONTEXT_PART_PREFIX,
  CONTEXT_ICON_FAMILIES,
  CONTEXT_ICON_FAMILY_LABEL,
  CONTEXT_ICONS,
  PART_EMOJI,
  contextIconMarker,
  contextIconOf,
  contextPartMarker,
  contextPartOf,
  iconAsText,
  searchContextIcons,
  randomContextIcon,
};
