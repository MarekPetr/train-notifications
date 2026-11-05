import bundledStops from "./data/stops.json";
import { buildCatalogFromGtfs } from "./gtfsCatalog";
import {
  isBrnoMainStationName,
  looksLikeRailStation,
  normalize,
  placeCore,
} from "./names";
import {
  getDeployId,
  getStopsCatalog as storageGetStops,
  putStopsCatalog as storagePutStops,
} from "./storage";
import type { Env, StopRef, StopsCatalogMeta } from "./types";
import {
  clearViaMemoryCache,
  loadViaBeyond,
  saveViaBeyond,
} from "./via";

export type { StopRef, StopsCatalogMeta };

/** Isolate-lifetime cache so cron/API reuse one storage read. */
let memoryCatalog: StopRef[] | null = null;
let memoryMeta: StopsCatalogMeta | null = null;
let readyDeployId: string | null = null;
let ensureInflight: Promise<StopsCatalogMeta | null> | null = null;

export async function loadStopsCatalog(
  env: Env,
): Promise<{ stops: StopRef[]; meta: StopsCatalogMeta }> {
  if (memoryCatalog && memoryMeta) {
    return { stops: memoryCatalog, meta: memoryMeta };
  }

  const stored = await storageGetStops(env);
  if (stored) {
    memoryCatalog = stored.stops;
    memoryMeta = stored.meta;
    return stored;
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

  // Exact catalog name always wins (autocomplete picks).
  for (const stop of stops) {
    if (normalize(stop.name) === q) return stop;
  }

  // IDS names Brno main station "Hlavní nádraží"; boards/users say "Brno" / "Brno hl.n.".
  if (isBrnoMainStationName(query)) {
    const hl = stops.find((s) => normalize(s.name) === "hlavni nadrazi");
    if (hl) return hl;
  }

  const qCore = placeCore(q);
  let best: { stop: StopRef; score: number } | null = null;
  for (const stop of stops) {
    const name = normalize(stop.name);
    const sCore = placeCore(name);
    let score = 0;

    if (qCore && sCore && qCore === sCore) score = 920;
    else if (qCore && name.startsWith(qCore + " ")) score = 860;
    else if (
      qCore &&
      sCore &&
      (sCore.startsWith(qCore + " ") || qCore.startsWith(sCore + " "))
    )
      score = 820;
    else if (name.startsWith(q + " ")) score = 800;
    else if (name.startsWith(q)) score = 700;
    else if (qCore && name.includes(qCore) && qCore.length >= 4) score = 560;
    else if (name.includes(q)) score = 500;
    else continue;

    if (looksLikeRailStation(stop.name)) score += 150;
    // Prefer shorter names when place cores already match (station over suburb).
    if (qCore && sCore && qCore === sCore) score -= Math.min(sCore.length, 20);
    score -= Math.min(name.length, 60);

    if (!best || score > best.score) best = { stop, score };
  }
  return best?.stop ?? null;
}

/** Fetch GTFS, parse stops + via index, persist via STORAGE_BACKEND. */
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

  const deployId = currentDeployId(env);
  await storagePutStops(env, stops, meta, deployId);

  memoryCatalog = stops;
  memoryMeta = { ...meta, source: "kv" };
  readyDeployId = deployId;
  return meta;
}

/**
 * After each deploy (new DEPLOY_ID), rebuild stops + via once.
 * Also runs when catalog is missing/empty. Deduped per isolate.
 */
export async function ensureCatalogForDeploy(
  env: Env,
): Promise<{ refreshed: boolean; meta: StopsCatalogMeta | null }> {
  const deployId = currentDeployId(env);
  if (readyDeployId === deployId) {
    return { refreshed: false, meta: memoryMeta };
  }

  if (!ensureInflight) {
    ensureInflight = (async () => {
      const storedDeploy = await getDeployId(env);
      const { stops, meta } = await loadStopsCatalog(env);
      const { meta: viaMeta } = await loadViaBeyond(env);
      const needsRefresh =
        storedDeploy !== deployId ||
        meta.source === "bundle" ||
        stops.length < 100 ||
        viaMeta.source === "empty" ||
        viaMeta.pairCount === 0;

      if (!needsRefresh) {
        readyDeployId = deployId;
        return null;
      }

      return refreshStopsCatalog(env);
    })().finally(() => {
      ensureInflight = null;
    });
  }

  const meta = await ensureInflight;
  return { refreshed: meta != null, meta: meta ?? memoryMeta };
}

function currentDeployId(env: Env): string {
  return (env.DEPLOY_ID || "local").trim() || "local";
}

/** Clear isolate cache (tests / after manual storage wipe). */
export function clearStopsMemoryCache(): void {
  memoryCatalog = null;
  memoryMeta = null;
  readyDeployId = null;
  clearViaMemoryCache();
}
