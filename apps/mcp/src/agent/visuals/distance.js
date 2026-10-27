/**
 * HOW FAR EACH PLACE IS, FROM WHERE THEY ARE.
 *
 * Dev2's places card for flower shops (2026-10-27) had no distances, though
 * Tex knew their address: "tex knows my address yet no distance was put for
 * these places". The model cannot measure a distance, and a guessed one
 * would be worse than none. So a places card names where the person starts
 * (`from`, an address from their about-me note or their own words), and the
 * gateway works out each place's distance itself: it geocodes the start and
 * each place's address, and fills the distance as a straight line, with a
 * walking time when the walk is short.
 *
 * An address is looked up only when the turn saw it: in what the person
 * said, a page or tool result this turn read, or their about-me note
 * (`outgoingPictures.locates`). A lookup sends the address to a geocoder, so
 * an address the model made up is never one: that would be a way out for
 * whatever the model put in it. What a model wrote as a distance is kept.
 */

export const GEOCODE_TIMEOUT_MS = 4_000;
/** The start and four places. */
const MAX_LOOKUPS = 5;
const MAX_ADDRESS = 200;
/** Farther than this from the start is a different city's shop of the same name, not a place to go. */
const MAX_KM = 80;
/** Walking pace, with streets about a third longer than the straight line. */
const WALK_KM_PER_MIN = 5 / 60 / 1.3;
const WALK_UP_TO_MIN = 30;
/** Countries that measure a walk in miles. */
const MILES = new Set(["US", "GB", "LR", "MM"]);
const AGENT = "Mozilla/5.0 (compatible; ContextTex/1.0; +https://context.lc)";

const text = (value) => (typeof value === "string" ? value.trim().slice(0, MAX_ADDRESS) : "");
const blank = (value) => typeof value !== "string" || value.trim() === "";

/** One address as a point, by Photon (OpenStreetMap data), or null. */
export async function geocode(address, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(address)}`, {
      headers: { accept: "application/json", "user-agent": AGENT },
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const found = (await response.json())?.features?.[0];
    const [lon, lat] = found?.geometry?.coordinates ?? [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, country: String(found?.properties?.countrycode ?? "").toUpperCase() };
  } catch {
    return null;
  }
}

/** The great-circle distance between two points, in km. */
export function kmBetween(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A distance as the card shows it: "0.6 mi" over "12 min walk", or "4.2 km" over "away". */
export function distanceWords(km, country) {
  const miles = MILES.has(country);
  const amount = miles ? km / 1.609344 : km;
  const shown = amount < 10 ? amount.toFixed(1) : String(Math.round(amount));
  const walk = Math.max(1, Math.round(km / WALK_KM_PER_MIN));
  return { distance: `${shown} ${miles ? "mi" : "km"}`, distance_label: walk <= WALK_UP_TO_MIN ? `${walk} min walk` : "away" };
}

/**
 * A places card's data with each place's distance from `data.from` filled
 * in, and a line for the model about what was and was not measured.
 * `locates(address)` says whether this turn saw the address.
 */
export async function fillDistances(template, data, locates, fetchImpl = fetch) {
  if (template !== "places" || !data || typeof data !== "object" || !Array.isArray(data.items)) return { data, note: "" };
  const from = text(data.from);
  const wanted = data.items.map((item) => (item && typeof item === "object" && blank(item.distance) ? text(item.address) : ""));
  if (wanted.every((address) => address === "")) return { data, note: "" };
  if (from === "") return { data, note: "No distances: give from (where they start: their address from about-me, or where they said they are) and each place's address, and they are measured for you." };
  if (locates(from) !== true) return { data, note: "No distances: from must be an address they gave or their about-me note holds, written as it is there." };
  const looked = wanted.map((address) => (address !== "" && locates(address) === true ? address : ""));
  const start = await geocode(from, fetchImpl);
  if (start === null) return { data, note: `No distances: ${from} could not be found on a map; give a fuller address.` };
  const queries = looked.map((address) => (address === "" || /\d{3,}|,.*,/.test(address) ? address : `${address}, ${from}`));
  let budget = MAX_LOOKUPS - 1;
  const points = await Promise.all(queries.map((query) => (query !== "" && budget-- > 0 ? geocode(query, fetchImpl) : null)));
  const missed = [];
  const items = data.items.map((item, i) => {
    if (wanted[i] === "") return item;
    const km = points[i] === null ? null : kmBetween(start, points[i]);
    if (km === null || km > MAX_KM) {
      missed.push(text(item.name).slice(0, 40) || `place ${i + 1}`);
      return item;
    }
    return { ...item, ...distanceWords(km, start.country) };
  });
  const measured = wanted.filter(Boolean).length - missed.length;
  const parts = [];
  if (measured > 0) parts.push(`Distances measured from ${from} in a straight line; say "about" if you mention one.`);
  if (missed.length > 0) parts.push(`No distance for ${missed.join(", ")}: its address was not one this turn read, or could not be found near ${from}.`);
  return { data: { ...data, items }, note: parts.join(" ") };
}
