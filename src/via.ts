import type { Env } from "./types";

/** fromStopId|toStopId → terminus stopIds that continue past `to`. */
export type ViaBeyondIndex = Record<string, number[]>;

export interface ViaCatalogMeta {
  updatedAt: string;
  pairCount: number;
  source: "kv" | "empty";
}

const VIA_KEY = "catalog:via-beyond";
const VIA_META_KEY = "catalog:via-beyond:meta";

let memoryVia: ViaBeyondIndex | null = null;
let memoryMeta: ViaCatalogMeta | null = null;

export async function loadViaBeyond(
  env: Env,
): Promise<{ via: ViaBeyondIndex; meta: ViaCatalogMeta }> {
  if (memoryVia && memoryMeta) {
    return { via: memoryVia, meta: memoryMeta };
  }

  const raw = await env.WATCHES.get(VIA_KEY);
  if (raw) {
    try {
      const via = JSON.parse(raw) as ViaBeyondIndex;
      if (via && typeof via === "object") {
        const metaRaw = await env.WATCHES.get(VIA_META_KEY);
        const meta = metaRaw
          ? (JSON.parse(metaRaw) as ViaCatalogMeta)
          : {
              updatedAt: "",
              pairCount: Object.keys(via).length,
              source: "kv" as const,
            };
        meta.source = "kv";
        memoryVia = via;
        memoryMeta = meta;
        return { via, meta };
      }
    } catch {
      // fall through
    }
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
  await env.WATCHES.put(VIA_KEY, JSON.stringify(via));
  await env.WATCHES.put(VIA_META_KEY, JSON.stringify(meta));
  memoryVia = via;
  memoryMeta = meta;
  return meta;
}

export function clearViaMemoryCache(): void {
  memoryVia = null;
  memoryMeta = null;
}
