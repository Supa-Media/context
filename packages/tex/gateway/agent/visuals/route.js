/**
 * THE PATH ON A ROUTE MAP (owner, 2026-10-27, on a "3 mile run loop from my
 * house in LIC" card that showed one pin and no line: "i don't even see the
 * path").
 *
 * A `map` card with `route` (or `loop`, back to the first stop) asks the
 * router for the way along streets between its stops, in order, and the map
 * draws that line, fitted to it, with the length it measured. The router is
 * OpenStreetMap's (FOSSGIS `routing.openstreetmap.de`: foot, bike or car),
 * because the Maps key covers only Static Maps and Geocoding. It is sent the
 * stops' points only, each found from an address the turn saw
 * (`outgoingPictures.locates`), never words.
 *
 * Its answer is a Google encoded polyline, which Static Maps draws as given
 * (`enc:`), and which is decoded here for the OpenStreetMap tiles.
 */

export const ROUTER = "https://routing.openstreetmap.de";
export const ROUTE_TIMEOUT_MS = 6_000;
const PROFILES = { walk: "routed-foot", run: "routed-foot", bike: "routed-bike", drive: "routed-car" };
/** Static Maps refuses an address over 16,384 characters; the path keeps well under. */
const MAX_PATH_CHARS = 6_000;
const AGENT = "Mozilla/5.0 (compatible; ContextTex/1.0; +https://context.lc)";

/** The way along streets through `points` ({lat, lng}, in order), back to the first when `loop`: { polyline, coords, meters }, or null. */
export async function routeThrough(points, { loop = false, travel = "walk", fetchImpl = fetch } = {}) {
  const stops = loop && points.length > 1 ? [...points, points[0]] : points;
  if (stops.length < 2 || stops.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lng))) return null;
  const profile = PROFILES[travel] ?? PROFILES.walk;
  const where = stops.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  for (const overview of ["full", "simplified"]) {
    let answer;
    try {
      const response = await fetchImpl(`${ROUTER}/${profile}/route/v1/driving/${where}?overview=${overview}&geometries=polyline&steps=false`, {
        headers: { accept: "application/json", "user-agent": AGENT },
        signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      answer = await response.json();
    } catch {
      return null;
    }
    const route = answer?.code === "Ok" ? answer.routes?.[0] : null;
    if (typeof route?.geometry !== "string" || !Number.isFinite(route.distance)) return null;
    if (route.geometry.length > MAX_PATH_CHARS) continue;
    const coords = decodePolyline(route.geometry);
    if (coords.length < 2) return null;
    return { polyline: route.geometry, coords, meters: route.distance };
  }
  return null;
}

/** A Google encoded polyline (precision 5) as [{lat, lng}]; stops at the first malformed character. */
export function decodePolyline(text) {
  const out = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let shift = 0;
    let value = 0;
    for (;;) {
      if (i >= text.length) return null;
      const byte = text.charCodeAt(i++) - 63;
      if (byte < 0 || byte > 63) return null;
      value |= (byte & 0x1f) << shift;
      shift += 5;
      if (byte < 0x20) break;
      if (shift > 30) return null;
    }
    return value & 1 ? ~(value >> 1) : value >> 1;
  };
  while (i < text.length) {
    const dLat = next();
    const dLng = next();
    if (dLat === null || dLng === null) break;
    lat += dLat;
    lng += dLng;
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

/** "3.1 mi" in the US (and the other mile countries), "5.0 km" elsewhere. */
export function lengthWords(meters, miles = true) {
  return miles ? `${(meters / 1609.344).toFixed(1)} mi` : `${(meters / 1000).toFixed(1)} km`;
}
