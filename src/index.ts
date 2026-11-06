import {
  createEvalCache,
  evaluateWatch,
  fingerprint,
  noteworthyDepartures,
  type EvalCache,
} from "./idsjmk";
import { sendWebhook } from "./notify";
import {
  ensureCatalogForDeploy,
  loadStopsCatalog,
  refreshStopsCatalog,
} from "./stops";
import {
  deleteWatch,
  getWatch,
  listAllWatches,
  putWatch,
  storageBackend,
} from "./storage";
import type {
  Env,
  StoredWatch,
  TripObservation,
  WatchSnapshot,
} from "./types";
import { loadViaBeyond } from "./via";
import { isWatchDue, parseWatchFromRequest, watchId } from "./watch";

export { AppStore } from "./store";

/** Nightly GTFS → storage catalog refresh (UTC). Must match wrangler.toml. */
const STOPS_REFRESH_CRON = "0 3 * * *";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      return await handleFetch(request, env, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 400);
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (controller.cron === STOPS_REFRESH_CRON) {
      ctx.waitUntil(refreshStopsCatalog(env));
      return;
    }
    ctx.waitUntil(
      (async () => {
        await ensureCatalogForDeploy(env);
        await runAllWatches(env);
      })(),
    );
  },
};

async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const needsCatalog =
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/run" ||
    parts[0] === "watch" ||
    parts[0] === "watches";

  if (needsCatalog) {
    await ensureCatalogForDeploy(env);
  } else {
    // Static UI: rebuild in background after deploy so the next cron/API is ready.
    ctx.waitUntil(ensureCatalogForDeploy(env));
  }

  if (request.method === "GET" && url.pathname === "/api") {
    return json({
      service: "train-notifications",
      storage: storageBackend(env),
      usage: {
        status: "GET /watch/{od}/{do}?od=06:00&do=09:00",
        register:
          "PUT /watch/{od}/{do}?od=06:00&do=09:00&webhook=https://trigger.macrodroid.com/...",
        unregister:
          "DELETE /watch/{od}/{do}?od=06:00&do=09:00&webhook=https://trigger.macrodroid.com/...",
        list: "GET /watches?webhook=https://trigger.macrodroid.com/...",
        deleteById: "DELETE /watches/{id}?webhook=...",
        stops: "GET /api/stops",
        refreshStops: "POST /api/refresh-stops",
        example: "/watch/Tišnov/Brno?od=06:30&do=08:30&webhook=URL&minDelay=5",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/stops") {
    const { stops, meta } = await loadStopsCatalog(env);
    return json({
      names: stops.map((s) => s.name),
      count: meta.count,
      updatedAt: meta.updatedAt || null,
      source: meta.source,
      storage: storageBackend(env),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/refresh-stops") {
    const meta = await refreshStopsCatalog(env);
    return json({ refreshed: true, storage: storageBackend(env), ...meta });
  }

  if (parts[0] === "watch" && parts.length >= 3) {
    const watch = parseWatchFromRequest(parts[1], parts[2], url);

    if (request.method === "GET") {
      const storedObs = watch.webhook
        ? await loadStoredObservations(env, watch)
        : {};
      const snapshot = await buildSnapshot(watch, env, storedObs);
      if (watch.webhook && url.searchParams.get("push") === "1") {
        const result = await sendWebhook(watch.webhook, snapshot);
        return json({ ...snapshot, pushed: result });
      }
      return json(snapshot);
    }

    if (request.method === "PUT" || request.method === "POST") {
      if (!watch.webhook) {
        return json(
          { error: "Pro registraci sledování přidej query parametr webhook=" },
          400,
        );
      }
      const id = watchId(watch);
      const existing = await getWatch(env, id);
      const stored: StoredWatch = {
        ...watch,
        id,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        lastFingerprint: existing?.lastFingerprint,
        observations: existing?.observations,
      };
      await putWatch(env, stored);
      const snapshot = await buildSnapshot(watch, env);
      return json({ registered: true, id: stored.id, snapshot }, 201);
    }

    if (request.method === "DELETE") {
      const id = watchId(watch);
      await deleteWatch(env, id);
      return json({ deleted: true, id });
    }
  }

  if (parts[0] === "watches" && parts.length === 2) {
    const id = decodeURIComponent(parts[1]);
    const webhookGate = (url.searchParams.get("webhook") ?? "").trim();
    if (!webhookGate) {
      return json(
        { error: "Pro přístup k sledování je potřeba query parametr webhook=" },
        400,
      );
    }
    if (request.method === "GET" || request.method === "DELETE") {
      const stored = await getWatch(env, id);
      if (!stored) return json({ error: "Watch nenalezen" }, 404);
      if (normalizeWebhook(stored.webhook) !== normalizeWebhook(webhookGate)) {
        return json({ error: "Watch nenalezen" }, 404);
      }
      if (request.method === "GET") return json(stored);
      await deleteWatch(env, id);
      return json({ deleted: true, id });
    }
  }

  if (request.method === "GET" && url.pathname === "/watches") {
    const webhookFilter = (url.searchParams.get("webhook") ?? "").trim();
    if (!webhookFilter) {
      return json(
        {
          error:
            "Seznam je soukromý — přidej ?webhook= s MacroDroid URL, ke kterému chceš sledování.",
        },
        400,
      );
    }
    const all = await listAllWatches(env);
    const watches = all
      .filter(
        (stored) =>
          normalizeWebhook(stored.webhook) ===
          normalizeWebhook(webhookFilter),
      )
      .sort((a, b) => a.from.localeCompare(b.from, "cs"));
    return json({ watches, webhook: webhookFilter });
  }

  if (request.method === "POST" && url.pathname === "/run") {
    const result = await runAllWatches(env);
    return json(result);
  }

  return env.ASSETS.fetch(request);
}

async function buildSnapshot(
  watch: ReturnType<typeof parseWatchFromRequest>,
  env: Env,
  observations: StoredWatch["observations"] = {},
  cache?: EvalCache,
): Promise<
  WatchSnapshot & {
    source: string;
    observations: Record<string, TripObservation>;
  }
> {
  const activeCache = cache ?? createEvalCache();
  if (!activeCache.stops) {
    activeCache.stops = (await loadStopsCatalog(env)).stops;
  }
  if (!activeCache.viaBeyond) {
    activeCache.viaBeyond = (await loadViaBeyond(env)).via;
  }
  const { departures, alerts, source, observations: nextObs } =
    await evaluateWatch(
      watch,
      new Date(),
      observations,
      activeCache,
      activeCache.stops,
    );
  return {
    watch,
    checkedAt: new Date().toISOString(),
    departures,
    alerts,
    noteworthy: noteworthyDepartures(departures, watch.minDelay),
    source,
    observations: nextObs,
  };
}

async function loadStoredObservations(
  env: Env,
  watch: ReturnType<typeof parseWatchFromRequest>,
): Promise<StoredWatch["observations"]> {
  if (!watch.webhook) return {};
  const stored = await getWatch(env, watchId(watch));
  if (!stored) return {};
  if (normalizeWebhook(stored.webhook) !== normalizeWebhook(watch.webhook)) {
    return {};
  }
  return stored.observations ?? {};
}

async function runAllWatches(env: Env) {
  const all = await listAllWatches(env);
  const { stops } = await loadStopsCatalog(env);
  const { via } = await loadViaBeyond(env);
  const cache = createEvalCache(stops, via);
  const now = new Date();
  const results = [];
  let checked = 0;
  let skippedInactive = 0;
  let skippedUnchanged = 0;
  let written = 0;

  for (const stored of all) {
    const id = stored.id;
    if (!stored.webhook) continue;

    if (!isWatchDue(stored, now)) {
      skippedInactive += 1;
      results.push({ id, notified: false, reason: "outside_window" });
      continue;
    }

    checked += 1;
    const previousObs = stored.observations ?? {};
    const snapshot = await buildSnapshot(stored, env, previousObs, cache);
    const fp = fingerprint(
      snapshot.departures,
      snapshot.alerts,
      stored.minDelay,
    );

    const fpChanged = fp !== stored.lastFingerprint;
    const obsChanged = !observationsEqual(previousObs, snapshot.observations);
    // Jen nové/změněné zpoždění·zrušení nebo výluky — ne „all clear“
    // (dřív při výluce bez zpoždění odcházel text „Bez zpoždění“).
    const shouldNotify = shouldNotifyForFingerprint(
      stored.lastFingerprint,
      fp,
    );

    if (shouldNotify) {
      const pushed = await sendWebhook(stored.webhook, snapshot);
      stored.observations = snapshot.observations;
      stored.lastFingerprint = fp;
      await putWatch(env, stored);
      written += 1;
      results.push({
        id,
        notified: true,
        pushed,
        noteworthy: snapshot.noteworthy.length,
      });
      continue;
    }

    // Persist only when fingerprint or delay-tracking observations changed.
    if (fpChanged || obsChanged) {
      stored.observations = snapshot.observations;
      stored.lastFingerprint = fp;
      await putWatch(env, stored);
      written += 1;
      results.push({
        id,
        notified: false,
        reason: "nothing_noteworthy",
        saved: true,
      });
    } else {
      skippedUnchanged += 1;
      results.push({
        id,
        notified: false,
        reason: "unchanged",
        saved: false,
      });
    }
  }

  return {
    checked,
    skippedInactive,
    skippedUnchanged,
    written,
    total: all.length,
    storage: storageBackend(env),
    results,
  };
}

/**
 * Notify only when a non-empty dep/alert fingerprint part appears or changes.
 * Clearing delays/alerts must not push (avoids “Bez zpoždění” spam).
 */
function shouldNotifyForFingerprint(
  previous: string | undefined,
  next: string,
): boolean {
  const prev = splitFingerprint(previous ?? "");
  const cur = splitFingerprint(next);
  const depEvent = cur.dep !== "" && cur.dep !== prev.dep;
  const alertEvent = cur.alert !== "" && cur.alert !== prev.alert;
  return depEvent || alertEvent;
}

function splitFingerprint(fp: string): { dep: string; alert: string } {
  const i = fp.indexOf("#");
  if (i < 0) return { dep: fp, alert: "" };
  return { dep: fp.slice(0, i), alert: fp.slice(i + 1) };
}

function observationsEqual(
  a: StoredWatch["observations"] = {},
  b: StoredWatch["observations"] = {},
): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!(key in b)) return false;
    const left = normalizeObs(a[key]);
    const right = normalizeObs(b[key]);
    if (left.first !== right.first || left.last !== right.last) return false;
  }
  return true;
}

function normalizeObs(value: number | TripObservation): TripObservation {
  if (typeof value === "number") return { first: value, last: value };
  return value;
}

function normalizeWebhook(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}
