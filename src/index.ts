import {
  evaluateWatch,
  fingerprint,
  noteworthyDepartures,
} from "./idsjmk";
import { sendWebhook } from "./notify";
import type { Env, StoredWatch, WatchSnapshot } from "./types";
import { parseWatchFromRequest, watchId } from "./watch";

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
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
    return json({
      service: "train-notifications",
      usage: {
        status:
          "GET /watch/{od}/{do}?od=06:00&do=09:00",
        register:
          "PUT /watch/{od}/{do}?od=06:00&do=09:00&webhook=https://trigger.macrodroid.com/...",
        unregister:
          "DELETE /watch/{od}/{do}?od=06:00&do=09:00&webhook=https://trigger.macrodroid.com/...",
        example:
          "/watch/Tišnov/Brno?od=06:30&do=08:30&webhook=URL&minDelay=5",
      },
    });
  }

  if (parts[0] === "watch" && parts.length >= 3) {
    const defaultMinDelay = Number(env.MIN_DELAY_MINUTES || "5");
    const watch = parseWatchFromRequest(
      parts[1],
      parts[2],
      url,
      defaultMinDelay,
    );

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
      const stored: StoredWatch = {
        ...watch,
        id: watchId(watch),
        createdAt: new Date().toISOString(),
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

  if (request.method === "GET" && url.pathname === "/watches") {
    const ids = await listWatchIds(env);
    const watches = [];
    for (const id of ids) {
      const raw = await env.WATCHES.get(id);
      if (raw) watches.push(JSON.parse(raw));
    }
    return json({ watches });
  }

  if (request.method === "POST" && url.pathname === "/run") {
    const result = await runAllWatches(env);
    return json(result);
  }

  return json({ error: "Not found" }, 404);
}

async function buildSnapshot(
  watch: ReturnType<typeof parseWatchFromRequest>,
  observations: Record<string, number> = {},
): Promise<WatchSnapshot & { source: string; observations: Record<string, number> }> {
  const { departures, alerts, source, observations: nextObs } =
    await evaluateWatch(watch, new Date(), observations);
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
  const results = [];

  for (const id of ids) {
    const raw = await env.WATCHES.get(id);
    if (!raw) continue;
    const stored = JSON.parse(raw) as StoredWatch;
    if (!stored.webhook) continue;

    const snapshot = await buildSnapshot(stored, stored.observations ?? {});
    stored.observations = snapshot.observations;
    const fp = fingerprint(
      snapshot.departures,
      snapshot.alerts,
      stored.minDelay,
    );

    const shouldNotify =
      snapshot.noteworthy.length > 0 || snapshot.alerts.length > 0;
    const changed = fp !== stored.lastFingerprint;

    if (shouldNotify && changed) {
      const pushed = await sendWebhook(stored.webhook, snapshot);
      stored.lastFingerprint = fp;
      await env.WATCHES.put(id, JSON.stringify(stored));
      results.push({
        id,
        notified: true,
        pushed,
        noteworthy: snapshot.noteworthy.length,
      });
    } else {
      await env.WATCHES.put(id, JSON.stringify(stored));
      results.push({
        id,
        notified: false,
        reason: !shouldNotify ? "nothing_noteworthy" : "unchanged",
      });
    }
  }

  return { checked: ids.length, results };
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
  const ids = new Set(await listWatchIds(env));
  ids.add(id);
  await env.WATCHES.put("index:watches", JSON.stringify([...ids]));
}

async function unindexWatch(env: Env, id: string): Promise<void> {
  const ids = new Set(await listWatchIds(env));
  ids.delete(id);
  await env.WATCHES.put("index:watches", JSON.stringify([...ids]));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
