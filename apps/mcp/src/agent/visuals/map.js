/**
 * A MAP ON THE CARD (owner, 2026-10-27, on a florists card: "there was a map
 * one specifically that would've been great here").
 *
 * Places get a map strip above their rows, each pin numbered like its row,
 * and the `map` template is stops on a map: a day's errands, a trip's sights.
 * The map is drawn here, never by the model, from the addresses on the card:
 *
 * - **Google Static Maps** when `GOOGLE_MAPS_KEY` is set: one picture, pins
 *   drawn by Google, addresses found by Google.
 * - **OpenStreetMap tiles** otherwise (owner's pick, 2026-10-27: "OSM now,
 *   Google later"): each address found by the geocoder, the tiles laid out
 *   by Web Mercator and the pins drawn on top in HTML.
 *
 * Every picture is downloaded by the gateway and put in the page as data
 * (`./photos.js`), so the key never reaches the page, and a map whose tiles
 * do not all come is left off whole: a map with a hole reads as broken.
 *
 * Only an address the turn read or the person wrote goes to a map service:
 * a model that copied a home address out of a note it was never shown this
 * turn does not get to send it to Google or OpenStreetMap.
 */

import { esc, list } from "./kit.js";
import { kmBetween } from "./distance.js";
import { downloadPhoto, names } from "./photos.js";

export const MAP_WIDTH = 536;
/** The strip above a places card's rows, and the map of the `map` template. */
export const STRIP_HEIGHT = 220;
export const MAP_HEIGHT = 340;
const TILE = 256;
export const MAX_TILES = 12;
/** Where pins may sit: room above a point for the pin's head, and a margin round the sides. */
const PAD = { top: 46, right: 26, bottom: 14, left: 26 };
const MAX_ZOOM = 16;
const MIN_ZOOM = 3;
/** One street address, as a map service is sent it. */
const MAX_ADDRESS = 140;
export const OSM_TILES = "https://tile.openstreetmap.org";
export const GOOGLE_STATIC = "https://maps.googleapis.com/maps/api/staticmap";
/** OpenStreetMap's tile policy asks for a user agent that names the app, and that tiles be cached. */
const TILE_FETCH = { headers: { "user-agent": "ContextTex/1.0 (+https://context.lc)" }, cf: { cacheEverything: true, cacheTtl: 7 * 24 * 3600 } };
/** Pin colours, by number: the places card's row colours (`./choices.js`). */
const PIN_COLORS = ["#1F5FD1", "#B4540A", "#1E7B4A", "#7A4BC2", "#C79A1B", "#16161A"];

/**
 * The stops a card's map shows, numbered as the card numbers them: a places
 * card's items, or a map card's stops. An address that does not name its
 * town is made whole with `near` ("Long Island City, NY"), else the town of
 * `from`, else the town the card's other addresses share: Dev2's ice cream
 * card (2026-10-27) had "75 9th Ave, inside Chelsea Market" beside two
 * "…, New York, NY 10011", and no near.
 */
export function mapStops(template, data) {
  if (!data || typeof data !== "object") return [];
  const items = template === "places" ? list(data.items, 4) : template === "map" ? list(data.stops, 6) : [];
  const stops = items.map((item, i) => ({ n: i + 1, street: clean(item.address), color: PIN_COLORS[i] })).filter((stop) => stop.street !== "");
  // Without near, the town of where they start (`from`, `./distance.js`): "…, Long Island City, NY 11101".
  const from = typeof data.from === "string" && data.from.includes(",") ? clean(data.from.slice(data.from.indexOf(",") + 1)) : "";
  const near = clean(typeof data.near === "string" && data.near.trim() !== "" ? data.near : from) || sharedTown(stops.map((stop) => stop.street));
  return stops.map((stop) => ({ ...stop, address: whole(stop.street, near) }));
}

/** The town at an address's end, as a US address writes it: "New York, NY" or "New York, NY 10011". */
const TOWN = /,\s*([^,]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)\s*$/;
export const townOf = (address) => TOWN.exec(address)?.[1].trim() ?? "";

/** The town most of the addresses name, or "". */
function sharedTown(addresses) {
  const counts = new Map();
  for (const town of addresses.map(townOf).filter(Boolean)) counts.set(town, (counts.get(town) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/** An address as a map service is sent it: no separators a request could be split on, and short. */
function clean(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[|\n\r\t<>"\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ADDRESS);
}

function whole(street, near) {
  if (near === "" || townOf(street) !== "" || street.toLowerCase().includes(near.split(",")[0].trim().toLowerCase())) return street;
  return `${street}, ${near}`.slice(0, MAX_ADDRESS);
}

/**
 * Whether the turn read this address, the person wrote it, or their about-me
 * holds it (`outgoingPictures.locates`); with no `locates`, whether `read`
 * names its street part as whole words.
 */
export function vouchedAddress(street, { locates = null, read = "" } = {}) {
  if (typeof locates === "function") return locates(street) === true || locates(street.split(",")[0]) === true;
  return typeof read === "string" && names(read, street.split(",")[0]);
}

/** Google's map of the stops: one picture, pins numbered and coloured like the card's rows. */
export function googleMapUrl(stops, { key, width = MAP_WIDTH, height = MAP_HEIGHT, route = false }) {
  const url = new URL(GOOGLE_STATIC);
  url.searchParams.set("size", `${width}x${height}`);
  url.searchParams.set("scale", "2");
  url.searchParams.set("maptype", "roadmap");
  // Other businesses' pins and transit icons crowd out the ones Tex is pointing at.
  url.searchParams.append("style", "feature:poi|visibility:off");
  url.searchParams.append("style", "feature:transit|element:labels.icon|visibility:off");
  for (const stop of stops) url.searchParams.append("markers", `size:mid|color:0x${stop.color.slice(1)}|label:${stop.n}|${stop.address}`);
  if (route && stops.length > 1) url.searchParams.append("path", `color:0x16161ACC|weight:4|${stops.map((stop) => stop.address).join("|")}`);
  if (stops.length === 1) url.searchParams.set("zoom", "15");
  url.searchParams.set("key", key);
  return url.toString();
}

/** A point's place on the world at `zoom`, in tile pixels (Web Mercator). */
export function worldPixel(lat, lng, zoom) {
  const size = TILE * 2 ** zoom;
  const sin = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
}

/**
 * The tiles and pin spots for points on a `width` x `height` map: the closest
 * zoom that keeps every pin inside, centred on them.
 */
export function tileLayout(points, { width = MAP_WIDTH, height = MAP_HEIGHT } = {}) {
  const roomX = width - PAD.left - PAD.right;
  const roomY = height - PAD.top - PAD.bottom;
  let zoom = MIN_ZOOM;
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
    const px = points.map((p) => worldPixel(p.lat, p.lng, z));
    const spanX = Math.max(...px.map((p) => p.x)) - Math.min(...px.map((p) => p.x));
    const spanY = Math.max(...px.map((p) => p.y)) - Math.min(...px.map((p) => p.y));
    if (spanX <= roomX && spanY <= roomY) {
      zoom = z;
      break;
    }
  }
  if (points.length === 1) zoom = Math.min(zoom, 15);
  const px = points.map((p) => worldPixel(p.lat, p.lng, zoom));
  const midX = (Math.max(...px.map((p) => p.x)) + Math.min(...px.map((p) => p.x))) / 2;
  const midY = (Math.max(...px.map((p) => p.y)) + Math.min(...px.map((p) => p.y))) / 2;
  // Centre the room the pins have, not the strip: a pin's head sits above its point.
  const left = Math.round(midX - PAD.left - roomX / 2);
  const top = Math.round(midY - PAD.top - roomY / 2);
  const count = 2 ** zoom;
  const tiles = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height - 1) / TILE); ty++) {
    if (ty < 0 || ty >= count) continue;
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width - 1) / TILE); tx++) {
      const wrapped = ((tx % count) + count) % count;
      tiles.push({ url: `${OSM_TILES}/${zoom}/${wrapped}/${ty}.png`, left: tx * TILE - left, top: ty * TILE - top });
    }
  }
  const pins = points.map((p, i) => ({ n: p.n, color: p.color, left: Math.round(px[i].x - left), top: Math.round(px[i].y - top) }));
  return { zoom, tiles, pins };
}

/**
 * The map for a card, ready for the page, or why there is none (said to the
 * model only where it can do something about it). `pictures` collects each
 * downloaded picture as [address, data]; the map names them as
 * `card-photo:N`, numbered after the `offset` photos already there.
 */
/** One line per card map, codes and counts only (never an address), so a missing map can be told apart in the logs. */
function logMap(outcome, fields = {}) {
  console.log(JSON.stringify({ event: "card_map", outcome, ...fields }));
}

function none(reason, said = null) {
  logMap("none", { reason });
  return { map: null, reason: said };
}

export async function drawMap(template, data, { key = "", geocode = null, locates = null, read = "", fetchImpl = fetch, offset = 0, height = MAP_HEIGHT } = {}) {
  const all = mapStops(template, data);
  if (all.length === 0) return none("no_address", template === "map" ? "No stop had an address, so the map was left off." : null);
  const stops = all.filter((stop) => vouchedAddress(stop.street, { locates, read }));
  if (stops.length === 0) return none("unseen", "Map left off: put each place's street address as you read it.");
  // A bare street with no town anywhere on the card could be in any city: its pin is left off, the rest still drawn.
  const placed = stops.filter((stop) => stop.address !== stop.street || stop.street.includes(","));
  if (placed.length === 0) return none("no_town", "Map left off: give near (the town or neighbourhood, 'Long Island City, NY') so each pin lands in the right place.");
  const route = template === "map" && data.route === true;
  const token = (i) => `card-photo:${offset + i + 1}`;
  if (typeof key === "string" && key !== "") {
    const url = googleMapUrl(placed, { key, height, route });
    const image = await downloadPhoto(url, fetchImpl);
    if (image === null) return none("google_failed");
    logMap("drawn", { provider: "google", pins: placed.length });
    return { map: { kind: "google", image: token(0), height }, pictures: [["google-static-map", image]] };
  }
  if (typeof geocode !== "function") return none("no_geocoder");
  const found = await Promise.all(placed.map((stop) => Promise.resolve(geocode(stop.address)).catch(() => null)));
  // The geocoder (`./distance.js`) answers { lat, lon }.
  const points = placed
    .map((stop, i) => ({ ...stop, lat: found[i]?.lat, lng: found[i]?.lon ?? found[i]?.lng }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  // A shop of the same name in another city would zoom the map out to a continent: keep the biggest group within 50 km.
  const near50 = (a) => points.filter((b) => kmBetween(a, { lat: b.lat, lon: b.lng }) <= 50);
  const kept = points.map((p) => near50({ lat: p.lat, lon: p.lng })).sort((a, b) => b.length - a.length)[0] ?? [];
  if (kept.length === 0) return none("geocode_failed");
  const layout = tileLayout(kept, { height });
  if (layout.tiles.length === 0 || layout.tiles.length > MAX_TILES) return none("no_tiles");
  const images = await Promise.all(layout.tiles.map((tile) => downloadPhoto(tile.url, fetchImpl, TILE_FETCH)));
  if (images.some((image) => image === null)) return none("tiles_failed");
  logMap("drawn", { provider: "osm", pins: kept.length });
  return {
    map: { kind: "tiles", height, tiles: layout.tiles.map((tile, i) => ({ ...tile, image: token(i) })), pins: layout.pins, route },
    pictures: layout.tiles.map((tile, i) => [tile.url, images[i]]),
  };
}

/** A numbered teardrop pin, its tip on the point: a 30px square turned 45°, so the tip is 21px below its centre. */
function pin(p) {
  return `<div style="position: absolute; left: ${p.left - 15}px; top: ${p.top - 36}px; width: 30px; height: 30px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg); background: ${p.color}; border: 2px solid #FFFFFF; box-shadow: 0 2px 6px rgba(0,0,0,0.35)"></div>
<div style="position: absolute; left: ${p.left - 15}px; top: ${p.top - 36}px; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; color: #FFFFFF; font-weight: 800; font-size: 14px">${Number(p.n)}</div>`;
}

/**
 * The map's place on a card: a rounded block the map fills, or nothing. Every
 * value in it is the gateway's own (numbers, its colours, `card-photo:N`).
 */
export function mapBlock(c, map) {
  if (!map || typeof map !== "object") return "";
  const height = Number(map.height) || MAP_HEIGHT;
  const frame = (inner) =>
    `<div style="position: relative; flex-shrink: 0; width: ${MAP_WIDTH}px; height: ${height}px; border-radius: 16px; overflow: hidden; border: 1px solid ${c.line}; background: ${c.track}">${inner}</div>`;
  if (map.kind === "google" && /^card-photo:\d{1,2}$/.test(map.image)) {
    return frame(`<div style="position: absolute; inset: 0; background: url('${map.image}') center / cover no-repeat"></div>`);
  }
  if (map.kind !== "tiles" || !Array.isArray(map.tiles)) return "";
  const tiles = map.tiles
    .filter((tile) => /^card-photo:\d{1,2}$/.test(tile.image))
    .map((tile) => `<div style="position: absolute; left: ${Number(tile.left)}px; top: ${Number(tile.top)}px; width: ${TILE}px; height: ${TILE}px; background: url('${tile.image}') 0 0 / ${TILE}px ${TILE}px no-repeat"></div>`)
    .join("");
  const pins = Array.isArray(map.pins) ? map.pins.filter((p) => Number.isFinite(p.left) && Number.isFinite(p.top)) : [];
  const line =
    map.route && pins.length > 1
      ? `<svg width="${MAP_WIDTH}" height="${height}" style="position: absolute; left: 0; top: 0"><polyline points="${pins.map((p) => `${p.left},${p.top}`).join(" ")}" fill="none" stroke="#16161A" stroke-opacity="0.75" stroke-width="4" stroke-linejoin="round" stroke-dasharray="2 8" stroke-linecap="round"/></svg>`
      : "";
  // OpenStreetMap's licence asks for its credit on every map drawn from its tiles.
  const credit = `<div style="position: absolute; right: 0; bottom: 0; padding: 2px 6px; font-size: 10px; background: rgba(255,255,255,0.8); color: #3E3E44; border-top-left-radius: 6px">${esc("© OpenStreetMap contributors")}</div>`;
  return frame(`${tiles}${line}${pins.map(pin).join("")}${credit}`);
}
