import {
  createEvalCache,
  evaluateWatch,
  fingerprint,
  noteworthyDepartures,
  type EvalCache,
} from "./idsjmk";
import { sendWebhook } from "./notify";
import type { Env, StoredWatch, WatchSnapshot } from "./types";
import { isWatchDue, parseWatchFromRequest, watchId } from "./watch";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 400);
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runAllWatches(env));
  },
};

async function handleFetch(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api") {
    return json({
      service: "train-notifications",
      usage: {
        status: "GET /watch/{od}/{do}?od=06:00&do=09:00",
        register:
          "PUT /watch/{od}/{do}?od=06:00&do=09:00&webhook=https://trigger.macrodroid.com/...",
        unregister:
          "DELETE /watch/{od}/{do}?od=06:00&do=09:00&webhook=https://trigger.macrodroid.com/...",
        list: "GET /watches?webhook=https://trigger.macrodroid.com/...",
        deleteById: "DELETE /watches/{id}?webhook=...",
        example: "/watch/Tišnov/Brno?od=06:30&do=08:30&webhook=URL&minDelay=5",
      },
    });
  }

  if (parts[0] === "watch" && parts.length >= 3) {
    const watch = parseWatchFromRequest(parts[1], parts[2], url);

    if (request.method === "GET") {
      const snapshot = await buildSnapshot(watch);
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
      const existingRaw = await env.WATCHES.get(id);
      const existing = existingRaw
        ? (JSON.parse(existingRaw) as StoredWatch)
        : null;
      const stored: StoredWatch = {
        ...watch,
        id,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        lastFingerprint: existing?.lastFingerprint,
        observations: existing?.observations,
      };
      await env.WATCHES.put(stored.id, JSON.stringify(stored));
      await indexWatch(env, stored.id);
      const snapshot = await buildSnapshot(watch);
      return json({ registered: true, id: stored.id, snapshot }, 201);
    }

    if (request.method === "DELETE") {
      const id = watchId(watch);
      await env.WATCHES.delete(id);
      await unindexWatch(env, id);
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
      const raw = await env.WATCHES.get(id);
      if (!raw) return json({ error: "Watch nenalezen" }, 404);
      const stored = JSON.parse(raw) as StoredWatch;
      if (normalizeWebhook(stored.webhook) !== normalizeWebhook(webhookGate)) {
        return json({ error: "Watch nenalezen" }, 404);
      }
      if (request.method === "GET") return json(stored);
      await env.WATCHES.delete(id);
      await unindexWatch(env, id);
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
    const ids = await listWatchIds(env);
    const watches: StoredWatch[] = [];
    for (const id of ids) {
      const raw = await env.WATCHES.get(id);
      if (!raw) continue;
      const stored = JSON.parse(raw) as StoredWatch;
      if (normalizeWebhook(stored.webhook) !== normalizeWebhook(webhookFilter)) {
        continue;
      }
      watches.push(stored);
    }
    watches.sort((a, b) => a.from.localeCompare(b.from, "cs"));
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
  observations: Record<string, number> = {},
  cache?: EvalCache,
): Promise<WatchSnapshot & { source: string; observations: Record<string, number> }> {
  const { departures, alerts, source, observations: nextObs } =
    await evaluateWatch(watch, new Date(), observations, cache);
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

async function runAllWatches(env: Env) {
  const ids = await listWatchIds(env);
  const cache = createEvalCache();
  const now = new Date();
  const results = [];
  let checked = 0;
  let skippedInactive = 0;
  let skippedUnchanged = 0;
  let written = 0;

  for (const id of ids) {
    const raw = await env.WATCHES.get(id);
    if (!raw) continue;
    const stored = JSON.parse(raw) as StoredWatch;
    if (!stored.webhook) continue;

    if (!isWatchDue(stored, now)) {
      skippedInactive += 1;
      results.push({ id, notified: false, reason: "outside_window" });
      continue;
    }

    checked += 1;
    const previousObs = stored.observations ?? {};
    const snapshot = await buildSnapshot(stored, previousObs, cache);
    const fp = fingerprint(
      snapshot.departures,
      snapshot.alerts,
      stored.minDelay,
    );

    const shouldNotify =
      snapshot.noteworthy.length > 0 || snapshot.alerts.length > 0;
    const fpChanged = fp !== stored.lastFingerprint;
    const obsChanged = !observationsEqual(previousObs, snapshot.observations);

    if (shouldNotify && fpChanged) {
      const pushed = await sendWebhook(stored.webhook, snapshot);
      stored.observations = snapshot.observations;
      stored.lastFingerprint = fp;
      await env.WATCHES.put(id, JSON.stringify(stored));
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
    // Avoids burning Free-plan KV write quota on quiet minutes.
    if (fpChanged || obsChanged) {
      stored.observations = snapshot.observations;
      stored.lastFingerprint = fp;
      await env.WATCHES.put(id, JSON.stringify(stored));
      written += 1;
      results.push({
        id,
        notified: false,
        reason: !shouldNotify ? "nothing_noteworthy" : "unchanged",
        saved: true,
      });
    } else {
      skippedUnchanged += 1;
      results.push({
        id,
        notified: false,
        reason: !shouldNotify ? "nothing_noteworthy" : "unchanged",
        saved: false,
      });
    }
  }

  return {
    checked,
    skippedInactive,
    skippedUnchanged,
    written,
    total: ids.length,
    results,
  };
}

function observationsEqual(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

async function listWatchIds(env: Env): Promise<string[]> {
  const raw = await env.WATCHES.get("index:watches");
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

async function indexWatch(env: Env, id: string): Promise<void> {
  const ids = await listWatchIds(env);
  if (ids.includes(id)) return;
  await env.WATCHES.put("index:watches", JSON.stringify([...ids, id]));
}

async function unindexWatch(env: Env, id: string): Promise<void> {
  const ids = await listWatchIds(env);
  const next = ids.filter((item) => item !== id);
  if (next.length === ids.length) return;
  await env.WATCHES.put("index:watches", JSON.stringify(next));
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
