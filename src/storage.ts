import { appStore } from "./store";
import type {
  Env,
  StopRef,
  StopsCatalogMeta,
  StoredWatch,
  ViaBeyondIndex,
  ViaCatalogMeta,
} from "./types";

export type StorageBackend = "kv" | "do";

const KEY_STOPS = "catalog:stops";
const KEY_STOPS_META = "catalog:stops:meta";
const KEY_VIA = "catalog:via-beyond";
const KEY_VIA_META = "catalog:via-beyond:meta";
const KEY_DEPLOY = "catalog:deployId";
const KEY_INDEX = "index:watches";

/** `STORAGE_BACKEND=kv` keeps Free/KV path; default `do` uses Durable Object. */
export function storageBackend(env: Env): StorageBackend {
  const raw = (env.STORAGE_BACKEND || "do").trim().toLowerCase();
  return raw === "kv" ? "kv" : "do";
}

function requireKv(env: Env): KVNamespace {
  if (!env.WATCHES) {
    throw new Error("WATCHES KV binding chybí (STORAGE_BACKEND=kv)");
  }
  return env.WATCHES;
}

export async function getWatch(
  env: Env,
  id: string,
): Promise<StoredWatch | null> {
  if (storageBackend(env) === "do") {
    return appStore(env).getWatch(id);
  }
  const raw = await requireKv(env).get(id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredWatch;
  } catch {
    return null;
  }
}

export async function putWatch(env: Env, watch: StoredWatch): Promise<void> {
  if (storageBackend(env) === "do") {
    await appStore(env).putWatch(watch);
    return;
  }
  const kv = requireKv(env);
  await kv.put(watch.id, JSON.stringify(watch));
  const ids = await listWatchIds(env);
  if (!ids.includes(watch.id)) {
    await kv.put(KEY_INDEX, JSON.stringify([...ids, watch.id]));
  }
}

export async function deleteWatch(env: Env, id: string): Promise<boolean> {
  if (storageBackend(env) === "do") {
    return appStore(env).deleteWatch(id);
  }
  const kv = requireKv(env);
  const existing = await kv.get(id);
  await kv.delete(id);
  const ids = await listWatchIds(env);
  const next = ids.filter((item) => item !== id);
  if (next.length !== ids.length) {
    await kv.put(KEY_INDEX, JSON.stringify(next));
  }
  return existing != null;
}

export async function listWatchIds(env: Env): Promise<string[]> {
  if (storageBackend(env) === "do") {
    return appStore(env).listWatchIds();
  }
  const raw = await requireKv(env).get(KEY_INDEX);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

export async function listAllWatches(env: Env): Promise<StoredWatch[]> {
  if (storageBackend(env) === "do") {
    return appStore(env).listAllWatches();
  }
  const ids = await listWatchIds(env);
  const watches: StoredWatch[] = [];
  const kv = requireKv(env);
  for (const id of ids) {
    const raw = await kv.get(id);
    if (!raw) continue;
    try {
      watches.push(JSON.parse(raw) as StoredWatch);
    } catch {
      // skip
    }
  }
  return watches;
}

export async function getStopsCatalog(
  env: Env,
): Promise<{ stops: StopRef[]; meta: StopsCatalogMeta } | null> {
  if (storageBackend(env) === "do") {
    return appStore(env).getStopsCatalog();
  }
  const kv = requireKv(env);
  const raw = await kv.get(KEY_STOPS);
  if (!raw) return null;
  try {
    const stops = JSON.parse(raw) as StopRef[];
    if (!Array.isArray(stops) || stops.length === 0) return null;
    const metaRaw = await kv.get(KEY_STOPS_META);
    const meta = metaRaw
      ? (JSON.parse(metaRaw) as StopsCatalogMeta)
      : { updatedAt: "", count: stops.length, source: "kv" as const };
    return { stops, meta: { ...meta, source: "kv" } };
  } catch {
    return null;
  }
}

export async function putStopsCatalog(
  env: Env,
  stops: StopRef[],
  meta: StopsCatalogMeta,
  deployId: string,
): Promise<void> {
  if (storageBackend(env) === "do") {
    await appStore(env).putStopsCatalog(stops, meta, deployId);
    return;
  }
  const kv = requireKv(env);
  await kv.put(KEY_STOPS, JSON.stringify(stops));
  await kv.put(KEY_STOPS_META, JSON.stringify(meta));
  await kv.put(KEY_DEPLOY, deployId);
}

export async function getViaBeyond(
  env: Env,
): Promise<{ via: ViaBeyondIndex; meta: ViaCatalogMeta } | null> {
  if (storageBackend(env) === "do") {
    return appStore(env).getViaBeyond();
  }
  const kv = requireKv(env);
  const raw = await kv.get(KEY_VIA);
  if (!raw) return null;
  try {
    const via = JSON.parse(raw) as ViaBeyondIndex;
    if (!via || typeof via !== "object") return null;
    const metaRaw = await kv.get(KEY_VIA_META);
    const meta = metaRaw
      ? (JSON.parse(metaRaw) as ViaCatalogMeta)
      : {
          updatedAt: "",
          pairCount: Object.keys(via).length,
          source: "kv" as const,
        };
    return { via, meta: { ...meta, source: "kv" } };
  } catch {
    return null;
  }
}

export async function putViaBeyond(
  env: Env,
  via: ViaBeyondIndex,
  meta: ViaCatalogMeta,
): Promise<void> {
  if (storageBackend(env) === "do") {
    await appStore(env).putViaBeyond(via, meta);
    return;
  }
  const kv = requireKv(env);
  await kv.put(KEY_VIA, JSON.stringify(via));
  await kv.put(KEY_VIA_META, JSON.stringify(meta));
}

export async function getDeployId(env: Env): Promise<string | null> {
  if (storageBackend(env) === "do") {
    return appStore(env).getDeployId();
  }
  return requireKv(env).get(KEY_DEPLOY);
}
