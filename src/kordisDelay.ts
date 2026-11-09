/** Live vehicle delays from KORDIS (Brno GIS stream). Delay is minutes. */

const STREAM_URL =
  "wss://gis.brno.cz/geoevent/ws/services/Kordis_stream/StreamServer/subscribe";

/** Ignore position samples older than this. */
const MAX_AGE_MS = 5 * 60_000;
/** Cap absurd dispatcher values (minutes). */
const MAX_DELAY_MIN = 180;
/** Wall-clock budget for one fleet snapshot attempt. */
const SNAPSHOT_MS = 8_000;
/** Stop collecting after this quiet period once data arrived. */
const IDLE_MS = 400;

export interface VehicleDelay {
  id: number;
  line: string;
  delayMinutes: number;
  lastStopId: number | null;
  finalStopId: number | null;
  updatedAt: number;
}

export interface DelayIndex {
  byId: Map<number, VehicleDelay>;
  /** normalize(line)|finalStopId → vehicles */
  byLineFinal: Map<string, VehicleDelay[]>;
  fetchedAt: number;
  source: "kordis_stream" | "none";
}

interface StreamAttributes {
  ID?: number;
  LineName?: string;
  Delay?: number;
  LastStopID?: number;
  FinalStopID?: number;
  TimeUpdated?: number;
}

export function emptyDelayIndex(): DelayIndex {
  return {
    byId: new Map(),
    byLineFinal: new Map(),
    fetchedAt: 0,
    source: "none",
  };
}

/** One WebSocket snapshot of active vehicles with explicit Delay. */
export async function fetchDelayIndex(now = Date.now()): Promise<DelayIndex> {
  const byId = new Map<number, VehicleDelay>();
  // Stream occasionally skips the initial dump — retry once.
  for (let attempt = 0; attempt < 2 && byId.size === 0; attempt++) {
    if (attempt > 0) await sleep(400);
    try {
      const ws = await openStream();
      await collectSnapshot(ws, byId, now);
    } catch {
      /* try again / fall through */
    }
  }

  const byLineFinal = new Map<string, VehicleDelay[]>();
  for (const vehicle of byId.values()) {
    if (!vehicle.line || vehicle.finalStopId == null) continue;
    const key = `${vehicle.line}|${vehicle.finalStopId}`;
    const list = byLineFinal.get(key);
    if (list) list.push(vehicle);
    else byLineFinal.set(key, [vehicle]);
  }

  return {
    byId,
    byLineFinal,
    fetchedAt: now,
    source: byId.size > 0 ? "kordis_stream" : "none",
  };
}

/**
 * Explicit delay for a board row: VehicleID first, else line + terminus stop.
 * Returns null when KORDIS has no sample (never invent a delay).
 */
export function lookupDelay(
  index: DelayIndex,
  opts: {
    vehicleId: number | null;
    line: string;
    finalStopId: number | null;
    fromStopId: number | null;
  },
): number | null {
  if (opts.vehicleId && opts.vehicleId > 0) {
    const hit = index.byId.get(opts.vehicleId);
    if (hit) return hit.delayMinutes;
  }

  if (!opts.line || opts.finalStopId == null) return null;
  const key = `${normalizeLine(opts.line)}|${opts.finalStopId}`;
  const candidates = index.byLineFinal.get(key);
  if (!candidates?.length) return null;

  if (opts.fromStopId != null) {
    const atFrom = candidates.find((v) => v.lastStopId === opts.fromStopId);
    if (atFrom) return atFrom.delayMinutes;
  }

  // Prefer the freshest sample when several vehicles share line+terminus.
  let best = candidates[0];
  for (const v of candidates.slice(1)) {
    if (v.updatedAt > best.updatedAt) best = v;
  }
  return best.delayMinutes;
}

function normalizeLine(line: string): string {
  return line.trim().toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openStream(): Promise<WebSocket> {
  // Prefer constructor (Workers auto-accept). Fall back to fetch upgrade.
  try {
    const ws = new WebSocket(STREAM_URL);
    await waitOpen(ws);
    return ws;
  } catch {
    const res = await fetch(STREAM_URL, {
      headers: { Upgrade: "websocket" },
    });
    const ws = res.webSocket;
    if (!ws) throw new Error("KORDIS stream: no WebSocket");
    ws.accept();
    return ws;
  }
}

function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("KORDIS stream: open failed"));
    };
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

function collectSnapshot(
  ws: WebSocket,
  byId: Map<number, VehicleDelay>,
  now: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let sawData = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve();
    };

    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, IDLE_MS);
    };

    const hardTimer = setTimeout(finish, SNAPSHOT_MS);

    ws.addEventListener("message", (event) => {
      const raw =
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      if (raw.includes('"filter"')) return;

      let attributes: StreamAttributes | undefined;
      try {
        attributes = (JSON.parse(raw) as { attributes?: StreamAttributes })
          .attributes;
      } catch {
        return;
      }
      if (!attributes || attributes.ID == null) return;

      const updatedAt = Number(attributes.TimeUpdated) || 0;
      // TimeUpdated is epoch ms; drop stale / clock-skewed samples.
      if (updatedAt > 0 && now - updatedAt > MAX_AGE_MS) return;
      if (updatedAt > now + 60_000) return;

      const delayRaw = Number(attributes.Delay);
      if (!Number.isFinite(delayRaw)) return;
      const delayMinutes = Math.max(
        0,
        Math.min(MAX_DELAY_MIN, Math.round(delayRaw)),
      );

      const vehicle: VehicleDelay = {
        id: attributes.ID,
        line: normalizeLine(String(attributes.LineName ?? "")),
        delayMinutes,
        lastStopId:
          attributes.LastStopID != null && attributes.LastStopID > 0
            ? attributes.LastStopID
            : null,
        finalStopId:
          attributes.FinalStopID != null && attributes.FinalStopID > 0
            ? attributes.FinalStopID
            : null,
        updatedAt: updatedAt || now,
      };
      byId.set(vehicle.id, vehicle);
      sawData = true;
      bumpIdle();
    });

    ws.addEventListener("close", () => finish());
    ws.addEventListener("error", () => finish());

    try {
      ws.send(
        JSON.stringify({
          filter: {
            where: "1=1",
            outFields:
              "ID,LineName,Delay,LastStopID,FinalStopID,TimeUpdated,VType,LType",
          },
        }),
      );
    } catch {
      finish();
      return;
    }

    // If the stream never sends vehicles, don't hang on idle alone.
    if (!sawData) {
      /* hardTimer covers this */
    }
  });
}
