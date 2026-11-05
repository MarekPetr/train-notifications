import {
  getViaBeyond as storageGetVia,
  putViaBeyond as storagePutVia,
} from "./storage";
import type { Env, ViaBeyondIndex, ViaCatalogMeta } from "./types";

export type { ViaBeyondIndex, ViaCatalogMeta };

let memoryVia: ViaBeyondIndex | null = null;
let memoryMeta: ViaCatalogMeta | null = null;

export async function loadViaBeyond(
  env: Env,
): Promise<{ via: ViaBeyondIndex; meta: ViaCatalogMeta }> {
  if (memoryVia && memoryMeta) {
    return { via: memoryVia, meta: memoryMeta };
  }

  const stored = await storageGetVia(env);
  if (stored) {
    memoryVia = stored.via;
    memoryMeta = stored.meta;
    return stored;
  }

  const empty: ViaBeyondIndex = {};
  const meta: ViaCatalogMeta = {
    updatedAt: "",
    pairCount: 0,
    source: "empty",
  };
  memoryVia = empty;
  memoryMeta = meta;
  return { via: empty, meta };
}

export async function saveViaBeyond(
  env: Env,
  via: ViaBeyondIndex,
  updatedAt = new Date().toISOString(),
): Promise<ViaCatalogMeta> {
  const meta: ViaCatalogMeta = {
    updatedAt,
    pairCount: Object.keys(via).length,
    source: "kv",
  };
  await storagePutVia(env, via, meta);
  memoryVia = via;
  memoryMeta = meta;
  return meta;
}

export function clearViaMemoryCache(): void {
  memoryVia = null;
  memoryMeta = null;
}
