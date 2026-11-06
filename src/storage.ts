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

/** Persistence port — callers depend on this, not on DO/KV. */
export interface AppStorage {
  readonly backend: StorageBackend;
  getWatch(id: string): Promise<StoredWatch | null>;
  putWatch(watch: StoredWatch): Promise<void>;
  deleteWatch(id: string): Promise<boolean>;
  listWatchIds(): Promise<string[]>;
  listAllWatches(): Promise<StoredWatch[]>;
  getStopsCatalog(): Promise<{
    stops: StopRef[];
    meta: StopsCatalogMeta;
  } | null>;
  putStopsCatalog(
    stops: StopRef[],
    meta: StopsCatalogMeta,
    deployId: string,
  ): Promise<void>;
  getViaBeyond(): Promise<{
    via: ViaBeyondIndex;
    meta: ViaCatalogMeta;
  } | null>;
  putViaBeyond(via: ViaBeyondIndex, meta: ViaCatalogMeta): Promise<void>;
  getDeployId(): Promise<string | null>;
}

/** `STORAGE_BACKEND=kv` keeps Free/KV path; default `do` uses Durable Object. */
export function storageBackend(env: Env): StorageBackend {
  const raw = (env.STORAGE_BACKEND || "do").trim().toLowerCase();
  return raw === "kv" ? "kv" : "do";
}

/** Composition root: pick adapter from env. */
export function createStorage(env: Env): AppStorage {
  return storageBackend(env) === "kv"
    ? new KvAppStorage(env)
    : new DoAppStorage(env);
}

class DoAppStorage implements AppStorage {
  readonly backend = "do" as const;
  private readonly store: ReturnType<typeof appStore>;

  constructor(env: Env) {
    this.store = appStore(env);
  }

  getWatch(id: string): Promise<StoredWatch | null> {
    return this.store.getWatch(id);
  }

  putWatch(watch: StoredWatch): Promise<void> {
    return this.store.putWatch(watch);
  }

  deleteWatch(id: string): Promise<boolean> {
    return this.store.deleteWatch(id);
  }

  listWatchIds(): Promise<string[]> {
    return this.store.listWatchIds();
  }

  listAllWatches(): Promise<StoredWatch[]> {
    return this.store.listAllWatches();
  }

  getStopsCatalog(): Promise<{
    stops: StopRef[];
    meta: StopsCatalogMeta;
  } | null> {
    return this.store.getStopsCatalog();
  }

  putStopsCatalog(
    stops: StopRef[],
    meta: StopsCatalogMeta,
    deployId: string,
  ): Promise<void> {
    return this.store.putStopsCatalog(stops, meta, deployId);
  }

  getViaBeyond(): Promise<{
    via: ViaBeyondIndex;
    meta: ViaCatalogMeta;
  } | null> {
    return this.store.getViaBeyond();
  }

  putViaBeyond(via: ViaBeyondIndex, meta: ViaCatalogMeta): Promise<void> {
    return this.store.putViaBeyond(via, meta);
  }

  getDeployId(): Promise<string | null> {
    return this.store.getDeployId();
  }
}

class KvAppStorage implements AppStorage {
  readonly backend = "kv" as const;
  private readonly kv: KVNamespace;

  constructor(env: Env) {
    if (!env.WATCHES) {
      throw new Error("WATCHES KV binding chybí (STORAGE_BACKEND=kv)");
    }
    this.kv = env.WATCHES;
  }

  async getWatch(id: string): Promise<StoredWatch | null> {
    const raw = await this.kv.get(id);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredWatch;
    } catch {
      return null;
    }
  }

  async putWatch(watch: StoredWatch): Promise<void> {
    await this.kv.put(watch.id, JSON.stringify(watch));
    const ids = await this.listWatchIds();
    if (!ids.includes(watch.id)) {
      await this.kv.put(KEY_INDEX, JSON.stringify([...ids, watch.id]));
    }
  }

  async deleteWatch(id: string): Promise<boolean> {
    const existing = await this.kv.get(id);
    await this.kv.delete(id);
    const ids = await this.listWatchIds();
    const next = ids.filter((item) => item !== id);
    if (next.length !== ids.length) {
      await this.kv.put(KEY_INDEX, JSON.stringify(next));
    }
    return existing != null;
  }

  async listWatchIds(): Promise<string[]> {
    const raw = await this.kv.get(KEY_INDEX);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  async listAllWatches(): Promise<StoredWatch[]> {
    const ids = await this.listWatchIds();
    const watches: StoredWatch[] = [];
    for (const id of ids) {
      const raw = await this.kv.get(id);
      if (!raw) continue;
      try {
        watches.push(JSON.parse(raw) as StoredWatch);
      } catch {
        // skip
      }
    }
    return watches;
  }

  async getStopsCatalog(): Promise<{
    stops: StopRef[];
    meta: StopsCatalogMeta;
  } | null> {
    const raw = await this.kv.get(KEY_STOPS);
    if (!raw) return null;
    try {
      const stops = JSON.parse(raw) as StopRef[];
      if (!Array.isArray(stops) || stops.length === 0) return null;
      const metaRaw = await this.kv.get(KEY_STOPS_META);
      const meta = metaRaw
        ? (JSON.parse(metaRaw) as StopsCatalogMeta)
        : { updatedAt: "", count: stops.length, source: "kv" as const };
      return { stops, meta: { ...meta, source: "kv" } };
    } catch {
      return null;
    }
  }

  async putStopsCatalog(
    stops: StopRef[],
    meta: StopsCatalogMeta,
    deployId: string,
  ): Promise<void> {
    await this.kv.put(KEY_STOPS, JSON.stringify(stops));
    await this.kv.put(KEY_STOPS_META, JSON.stringify(meta));
    await this.kv.put(KEY_DEPLOY, deployId);
  }

  async getViaBeyond(): Promise<{
    via: ViaBeyondIndex;
    meta: ViaCatalogMeta;
  } | null> {
    const raw = await this.kv.get(KEY_VIA);
    if (!raw) return null;
    try {
      const via = JSON.parse(raw) as ViaBeyondIndex;
      if (!via || typeof via !== "object") return null;
      const metaRaw = await this.kv.get(KEY_VIA_META);
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

  async putViaBeyond(via: ViaBeyondIndex, meta: ViaCatalogMeta): Promise<void> {
    await this.kv.put(KEY_VIA, JSON.stringify(via));
    await this.kv.put(KEY_VIA_META, JSON.stringify(meta));
  }

  getDeployId(): Promise<string | null> {
    return this.kv.get(KEY_DEPLOY);
  }
}
