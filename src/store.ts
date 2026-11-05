import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  StopRef,
  StopsCatalogMeta,
  StoredWatch,
  ViaBeyondIndex,
  ViaCatalogMeta,
} from "./types";

const KEY_WATCHES = "watches";
const KEY_STOPS = "catalog:stops";
const KEY_STOPS_META = "catalog:stops:meta";
const KEY_VIA = "catalog:via-beyond";
const KEY_VIA_META = "catalog:via-beyond:meta";
const KEY_DEPLOY = "catalog:deployId";
const KEY_MIGRATED = "kvMigrated";

type WatchesMap = Record<string, StoredWatch>;

/** Singleton Durable Object: watches + GTFS catalog. */
export class AppStore extends DurableObject<Env> {
  private migrateInflight: Promise<void> | null = null;

  async getWatch(id: string): Promise<StoredWatch | null> {
    await this.ensureMigrated();
    const watches = await this.readWatches();
    return watches[id] ?? null;
  }

  async putWatch(watch: StoredWatch): Promise<void> {
    await this.ensureMigrated();
    const watches = await this.readWatches();
    watches[watch.id] = watch;
    await this.ctx.storage.put(KEY_WATCHES, watches);
  }

  async deleteWatch(id: string): Promise<boolean> {
    await this.ensureMigrated();
    const watches = await this.readWatches();
    if (!(id in watches)) return false;
    delete watches[id];
    await this.ctx.storage.put(KEY_WATCHES, watches);
    return true;
  }

  async listWatchIds(): Promise<string[]> {
    await this.ensureMigrated();
    return Object.keys(await this.readWatches());
  }

  async listAllWatches(): Promise<StoredWatch[]> {
    await this.ensureMigrated();
    return Object.values(await this.readWatches());
  }

  async getStopsCatalog(): Promise<{
    stops: StopRef[];
    meta: StopsCatalogMeta;
  } | null> {
    await this.ensureMigrated();
    const stops = await this.ctx.storage.get<StopRef[]>(KEY_STOPS);
    if (!Array.isArray(stops) || stops.length === 0) return null;
    const meta =
      (await this.ctx.storage.get<StopsCatalogMeta>(KEY_STOPS_META)) ?? {
        updatedAt: "",
        count: stops.length,
        source: "kv" as const,
      };
    return { stops, meta: { ...meta, source: "kv" } };
  }

  async putStopsCatalog(
    stops: StopRef[],
    meta: StopsCatalogMeta,
    deployId: string,
  ): Promise<void> {
    await this.ensureMigrated();
    await this.ctx.storage.put({
      [KEY_STOPS]: stops,
      [KEY_STOPS_META]: meta,
      [KEY_DEPLOY]: deployId,
    });
  }

  async getViaBeyond(): Promise<{
    via: ViaBeyondIndex;
    meta: ViaCatalogMeta;
  } | null> {
    await this.ensureMigrated();
    const via = await this.ctx.storage.get<ViaBeyondIndex>(KEY_VIA);
    if (!via || typeof via !== "object") return null;
    const meta =
      (await this.ctx.storage.get<ViaCatalogMeta>(KEY_VIA_META)) ?? {
        updatedAt: "",
        pairCount: Object.keys(via).length,
        source: "kv" as const,
      };
    return { via, meta: { ...meta, source: "kv" } };
  }

  async putViaBeyond(via: ViaBeyondIndex, meta: ViaCatalogMeta): Promise<void> {
    await this.ensureMigrated();
    await this.ctx.storage.put({
      [KEY_VIA]: via,
      [KEY_VIA_META]: meta,
    });
  }

  async getDeployId(): Promise<string | null> {
    await this.ensureMigrated();
    const id = await this.ctx.storage.get<string>(KEY_DEPLOY);
    return id ?? null;
  }

  private async readWatches(): Promise<WatchesMap> {
    const watches = await this.ctx.storage.get<WatchesMap>(KEY_WATCHES);
    return watches && typeof watches === "object" ? { ...watches } : {};
  }

  private async ensureMigrated(): Promise<void> {
    if (await this.ctx.storage.get<boolean>(KEY_MIGRATED)) return;
    if (!this.migrateInflight) {
      this.migrateInflight = this.migrateFromKv().finally(() => {
        this.migrateInflight = null;
      });
    }
    await this.migrateInflight;
  }

  /** One-shot copy from KV when first using Durable Object. */
  private async migrateFromKv(): Promise<void> {
    if (await this.ctx.storage.get<boolean>(KEY_MIGRATED)) return;

    const kv = this.env.WATCHES;
    if (!kv) {
      await this.ctx.storage.put(KEY_MIGRATED, true);
      return;
    }

    try {
      const existingWatches =
        await this.ctx.storage.get<WatchesMap>(KEY_WATCHES);
      if (!existingWatches || Object.keys(existingWatches).length === 0) {
        const indexRaw = await kv.get("index:watches");
        const ids = indexRaw ? (JSON.parse(indexRaw) as string[]) : [];
        const watches: WatchesMap = {};
        for (const id of ids) {
          const raw = await kv.get(id);
          if (!raw) continue;
          try {
            const stored = JSON.parse(raw) as StoredWatch;
            if (stored?.id) watches[stored.id] = stored;
          } catch {
            // skip corrupt
          }
        }
        if (Object.keys(watches).length > 0) {
          await this.ctx.storage.put(KEY_WATCHES, watches);
        }
      }

      if (!(await this.ctx.storage.get(KEY_STOPS))) {
        const stopsRaw = await kv.get(KEY_STOPS);
        if (stopsRaw) {
          const stops = JSON.parse(stopsRaw) as StopRef[];
          if (Array.isArray(stops) && stops.length > 0) {
            const metaRaw = await kv.get(KEY_STOPS_META);
            const meta = metaRaw
              ? (JSON.parse(metaRaw) as StopsCatalogMeta)
              : {
                  updatedAt: "",
                  count: stops.length,
                  source: "kv" as const,
                };
            await this.ctx.storage.put({
              [KEY_STOPS]: stops,
              [KEY_STOPS_META]: { ...meta, source: "kv" },
            });
          }
        }
      }

      if (!(await this.ctx.storage.get(KEY_VIA))) {
        const viaRaw = await kv.get(KEY_VIA);
        if (viaRaw) {
          const via = JSON.parse(viaRaw) as ViaBeyondIndex;
          if (via && typeof via === "object") {
            const metaRaw = await kv.get(KEY_VIA_META);
            const meta = metaRaw
              ? (JSON.parse(metaRaw) as ViaCatalogMeta)
              : {
                  updatedAt: "",
                  pairCount: Object.keys(via).length,
                  source: "kv" as const,
                };
            await this.ctx.storage.put({
              [KEY_VIA]: via,
              [KEY_VIA_META]: { ...meta, source: "kv" },
            });
          }
        }
      }

      if (!(await this.ctx.storage.get(KEY_DEPLOY))) {
        const deployId = await kv.get(KEY_DEPLOY);
        if (deployId) await this.ctx.storage.put(KEY_DEPLOY, deployId);
      }
    } catch {
      // best-effort
    }

    await this.ctx.storage.put(KEY_MIGRATED, true);
  }
}

export function appStore(env: Env): DurableObjectStub<AppStore> {
  return env.APP_STORE.getByName("app");
}
