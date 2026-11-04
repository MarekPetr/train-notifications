/** Shared stop / board-destination name matching (ČD board vs IDS/GTFS catalog). */

export function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Core place tokens: drop station suffixes and ČD "u regionu" qualifiers
 * ("Hustopeče u Brna" → "hustopece", "Židlochovice, železniční stanice" → "zidlochovice").
 */
export function placeCore(value: string): string {
  let s = normalize(value);
  if (!s) return "";

  s = s.replace(/\bhl n\b/g, " ").replace(/\s+/g, " ").trim();

  const uIdx = s.indexOf(" u ");
  if (uIdx > 0) s = s.slice(0, uIdx).trim();

  s = s
    .replace(
      /\b(zeleznicni stanice|zeleznicni zastavka|autobusove nadrazi|aut st|zel st|hlavni nadrazi)\b/g,
      " ",
    )
    .replace(/\b(zeleznicni|autobusove|stanice|zastavka|nadrazi|hlavni)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

export function namesLooselyMatch(a: string, b: string): boolean {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left);
}

/** Board / watch names that mean Brno hlavní nádraží in IDS JMK. */
export function isBrnoMainStationName(value: string): boolean {
  const n = normalize(value);
  if (!n) return false;
  if (n === "hlavni nadrazi" || n === "hl n") return true;
  if (!/\bbrno\b/.test(n) && !n.startsWith("brno")) return false;
  // "Brno", "Brno hl.n.", "Brno hlavní" — not "Brno-Černovice" / "Brno, Obora"
  const core = placeCore(n);
  if (core === "brno") return true;
  return /\b(hl n|hlavn)/.test(n);
}

/**
 * Whether a board destination and a catalog stop (or watch target) refer to the same place.
 * Handles ČD vs IDS naming: "Hustopeče u Brna" ↔ "Hustopeče, autobusové nádraží",
 * "Brno hl.n." ↔ "Hlavní nádraží", "Židlochovice" ↔ "Židlochovice, železniční stanice".
 */
export function destinationsMatch(a: string, b: string): boolean {
  if (namesLooselyMatch(a, b)) return true;
  if (isBrnoMainStationName(a) && isBrnoMainStationName(b)) return true;

  const ca = placeCore(a);
  const cb = placeCore(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  // Single-token board name vs multi-token place ("Slavkov" vs "slavkov u …" already
  // handled by stripping " u …"; this covers "brezova" vs "brezova nad svitavou").
  return ca.startsWith(cb + " ") || cb.startsWith(ca + " ");
}

export function looksLikeRailStation(name: string): boolean {
  return /(zeleznicni|zel st|nadrazi|hl n|hlavni)/.test(normalize(name));
}
