import bundledStops from "./data/stops.json";
import { buildCatalogFromGtfs } from "./gtfsCatalog";
import type { Env } from "./types";
import { clearViaMemoryCache, saveViaBeyond } from "./via";

export interface StopRef {
  name: string;
  stopId: number;
  lat: number;
  lon: number;
}

export interface StopsCatalogMeta {
  updatedAt: string;
  count: number;
  source: "kv" | "bundle" | "gtfs";
  viaPairCount?: number;
}

const CATALOG_KEY = "catalog:stops";
const META_KEY = "catalog:stops:meta";

/** Isolate-lifetime cache so cron/API reuse one KV read. */
let memoryCatalog: StopRef[] | null = null;
let memoryMeta: StopsCatalogMeta | null = null;

export async function loadStopsCatalog(
  env: Env,
): Promise<{ stops: StopRef[]; meta: StopsCatalogMeta }> {
  if (memoryCatalog && memoryMeta) {
    return { stops: memoryCatalog, meta: memoryMeta };
  }

  const raw = await env.WATCHES.get(CATALOG_KEY);
  if (raw) {
    try {
      const stops = JSON.parse(raw) as StopRef[];
      if (Array.isArray(stops) && stops.length > 0) {
        const metaRaw = await env.WATCHES.get(META_KEY);
        const meta = metaRaw
          ? (JSON.parse(metaRaw) as StopsCatalogMeta)
          : {
              updatedAt: "",
              count: stops.length,
              source: "kv" as const,
            };
        meta.source = "kv";
        memoryCatalog = stops;
        memoryMeta = meta;
        return { stops, meta };
      }
    } catch {
      // fall through to bundle
    }
  }

  const stops = bundledStops as StopRef[];
  const meta: StopsCatalogMeta = {
    updatedAt: "",
    count: stops.length,
    source: "bundle",
  };
  memoryCatalog = stops;
  memoryMeta = meta;
  return { stops, meta };
}

export function resolveStop(query: string, stops: StopRef[]): StopRef | null {
  const q = normalize(query);
  if (!q) return null;

  let best: { stop: StopRef; score: number } | null = null;
  for (const stop of stops) {
    const name = normalize(stop.name);
    let score = 0;
    if (name === q) score = 1000;
    else if (name.startsWith(q + " ")) score = 800;
    else if (name.startsWith(q)) score = 700;
    else if (name.includes(q)) score = 500;
    else continue;

    if (
      q.split(" ").length <= 2 &&
      /(zeleznicni|zel st|nadrazi|hl n)/.test(name)
    ) {
      score += 120;
    }
    score -= Math.min(name.length, 60);

    if (!best || score > best.score) best = { stop, score };
  }
  return best?.stop ?? null;
}

/** Fetch GTFS, parse stops + via index, write KV. Daily cron / POST /api/refresh-stops. */
export async function refreshStopsCatalog(env: Env): Promise<StopsCatalogMeta> {
  const { stops, viaBeyond } = await buildCatalogFromGtfs();
  if (stops.length < 100) {
    throw new Error(`GTFS parse returned too few stops (${stops.length})`);
  }

  const updatedAt = new Date().toISOString();
  const viaMeta = await saveViaBeyond(env, viaBeyond, updatedAt);

  const meta: StopsCatalogMeta = {
    updatedAt,
    count: stops.length,
    source: "gtfs",
    viaPairCount: viaMeta.pairCount,
  };

  await env.WATCHES.put(CATALOG_KEY, JSON.stringify(stops));
  await env.WATCHES.put(META_KEY, JSON.stringify(meta));

  memoryCatalog = stops;
  memoryMeta = { ...meta, source: "kv" };
  return meta;
}

/** Clear isolate cache (tests / after manual KV wipe). */
export function clearStopsMemoryCache(): void {
  memoryCatalog = null;
  memoryMeta = null;
  clearViaMemoryCache();
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
