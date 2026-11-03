import { resolveStop, type StopRef } from "./stops";
import type { ViaBeyondIndex } from "./via";
import { isWithinWindow } from "./watch";
import type {
  AlertEvent,
  DepartureEvent,
  TripObservation,
  WatchConfig,
} from "./types";

type ObservationMap = Record<string, number | TripObservation>;

/** Max jump of estimate between checks to treat as the same trip (not the next service). */
const MAX_ESTIMATE_JUMP_MIN = 10;
/** Cap inferred delay from estimate slip (minutes). */
const MAX_INFERRED_DELAY_MIN = 180;

interface BoardDeparture {
  line: string;
  platform: string | null;
  destination: string;
  timeMark: string;
}

const IDSJMK_DEPARTURES_URL =
  "https://www.idsjmk.cz/api/departures/busstop-by-name";
const DPMBINFO_URL = "https://dpmbinfo.dpmb.cz/api/Departures";
const VYLUKY_URL =
  "https://gis.brno.cz/ags1/rest/services/Hosted/IDS_JMK_v%C3%BDluky_a_odklony_zdroj_GeoJSON/FeatureServer/0/query";

/** Shared HTTP fetches for one cron/API batch (boards + alerts). */
export interface EvalCache {
  boards: Map<string, ReturnType<typeof fetchBoard>>;
  alerts: Promise<AlertEvent[]> | null;
  stops?: StopRef[];
  viaBeyond?: ViaBeyondIndex;
}

export function createEvalCache(
  stops?: StopRef[],
  viaBeyond?: ViaBeyondIndex,
): EvalCache {
  return { boards: new Map(), alerts: null, stops, viaBeyond };
}

export async function evaluateWatch(
  watch: WatchConfig,
  now = new Date(),
  observations: ObservationMap = {},
  cache?: EvalCache,
  stops: StopRef[] = cache?.stops ?? [],
): Promise<{
  departures: DepartureEvent[];
  alerts: AlertEvent[];
  stopName: string | null;
  source: string;
  observations: Record<string, TripObservation>;
}> {
  const viaBeyond = cache?.viaBeyond ?? {};
  const board = await getBoard(watch.from, stops, cache);
  const nextObservations: Record<string, TripObservation> = {};
  const departures = board.departures
    .filter((dep) =>
      destinationServesWatch(
        dep.destination,
        watch.to,
        watch.from,
        stops,
        viaBeyond,
      ),
    )
    .map((dep) =>
      toDepartureEvent(dep, now, watch, observations, nextObservations),
    )
    .filter((dep) => {
      const hhmm = dep.estimatedTime ?? dep.scheduledTime;
      return hhmm ? isWithinWindow(hhmm, watch.timeFrom, watch.timeTo) : true;
    });

  const lines = [...new Set(departures.map((d) => d.line))];
  const alerts = (await getAlerts(cache)).filter((alert) => {
    if (lines.length === 0) return false;
    return alert.routes.some((route) =>
      lines.some((line) => normalize(line) === normalize(route)),
    );
  });

  const cancelledRoutes = new Set(
    alerts
      .filter((a) =>
        /zruš|cancel|nejede|odřaz|odřáz|nepojede/i.test(
          `${a.header} ${a.description}`,
        ),
      )
      .flatMap((a) => a.routes.map(normalize)),
  );

  for (const dep of departures) {
    if (cancelledRoutes.has(normalize(dep.line))) {
      dep.isCancelled = true;
      dep.status = "cancelled";
    }
  }

  return {
    departures,
    alerts,
    stopName: board.stopName,
    source: board.source,
    observations: nextObservations,
  };
}

async function getBoard(
  from: string,
  stops: StopRef[],
  cache?: EvalCache,
): Promise<{
  stopName: string | null;
  departures: BoardDeparture[];
  source: string;
}> {
  if (!cache) return fetchBoard(from, stops);
  const key = normalize(from);
  let pending = cache.boards.get(key);
  if (!pending) {
    pending = fetchBoard(from, stops);
    cache.boards.set(key, pending);
  }
  return pending;
}

async function getAlerts(cache?: EvalCache): Promise<AlertEvent[]> {
  if (!cache) return fetchAlerts();
  if (!cache.alerts) cache.alerts = fetchAlerts();
  return cache.alerts;
}

async function fetchBoard(
  from: string,
  stops: StopRef[],
): Promise<{
  stopName: string | null;
  departures: BoardDeparture[];
  source: string;
}> {
  const catalogStop = resolveStop(from, stops);
  if (!catalogStop) {
    return { stopName: null, departures: [], source: "unresolved" };
  }

  // Primary: mapa/ELP board keyed by GTFS stop number (reliable for trains).
  const deps = await fetchDpmbinfo(catalogStop.stopId);
  if (deps.length > 0) {
    return {
      stopName: catalogStop.name,
      departures: deps,
      source: "dpmbinfo",
    };
  }

  // Secondary: IDS JMK website API (can be empty or fuzzy on short names).
  const idsjmk = await fetchIdsjmk(catalogStop.name);
  if (idsjmk.departures.length > 0) {
    return {
      stopName: idsjmk.stopName ?? catalogStop.name,
      departures: idsjmk.departures,
      source: "idsjmk",
    };
  }

  return {
    stopName: catalogStop.name,
    departures: [],
    source: "none",
  };
}

async function fetchIdsjmk(from: string): Promise<{
  stopName: string | null;
  stopNumber: number | null;
  departures: BoardDeparture[];
}> {
  const url = `${IDSJMK_DEPARTURES_URL}?busStopName=${encodeURIComponent(from)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "train-notifications/0.1",
    },
  });
  if (!res.ok) {
    return { stopName: null, stopNumber: null, departures: [] };
  }

  const data = (await res.json()) as {
    stops?: Array<{
      stop: { id: number; number: number; fullName: string };
      signs?: Array<{
        busStopSign?: { number?: number };
        departures?: Array<{
          link: string;
          platform: string | null;
          destinationStop: string;
          time: string;
        }>;
      }>;
    }>;
  };

  const stops = data.stops ?? [];
  if (stops.length === 0) {
    return { stopName: null, stopNumber: null, departures: [] };
  }

  const preferred = pickBestIdsjmkStop(stops, from);
  const departures = (preferred.signs ?? []).flatMap((sign) =>
    (sign.departures ?? []).map((d) => ({
      line: d.link,
      platform: d.platform,
      destination: d.destinationStop,
      timeMark: d.time,
    })),
  );

  return {
    stopName: preferred.stop.fullName,
    stopNumber: preferred.stop.number,
    departures,
  };
}

function pickBestIdsjmkStop<
  T extends { stop: { fullName: string }; signs?: Array<{ departures?: unknown[] }> },
>(stops: T[], from: string): T {
  const query = normalize(from);
  const scored = stops.map((stop) => {
    const name = normalize(stop.stop.fullName);
    let score = 0;
    if (name === query) score += 100;
    if (name.startsWith(query)) score += 40;
    if (name.includes(query)) score += 20;
    if (
      query.split(" ").length <= 2 &&
      /(zeleznicni|zel st|nadrazi|hl n)/.test(name)
    ) {
      score += 25;
    }
    const depCount = (stop.signs ?? []).reduce(
      (sum, sign) => sum + (sign.departures?.length ?? 0),
      0,
    );
    score += Math.min(depCount, 15);
    score -= Math.min(name.length, 40) / 100;
    return { stop, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.stop ?? stops[0];
}

async function fetchDpmbinfo(stopId: number): Promise<BoardDeparture[]> {
  const url = `${DPMBINFO_URL}?StopID=${stopId}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "train-notifications/0.1",
    },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    PostList?: Array<{
      PostID: number;
      Name: string;
      Departures?: Array<{
        Line: string;
        FinalStop: string;
        TimeMark: string;
      }>;
    }>;
  };

  return (data.PostList ?? []).flatMap((post) =>
    (post.Departures ?? []).map((d) => ({
      line: d.Line,
      platform: String(post.PostID),
      destination: d.FinalStop,
      timeMark: d.TimeMark,
    })),
  );
}

function toDepartureEvent(
  dep: BoardDeparture,
  now: Date,
  watch: WatchConfig,
  previous: ObservationMap,
  nextObservations: Record<string, TripObservation>,
): DepartureEvent {
  const parsed = parseTimeMark(dep.timeMark, now);
  let delayMinutes = parsed.delayMinutes;

  const estimated = parsed.estimatedTime;
  if (estimated && delayMinutes == null && parsed.isRealtime) {
    const estimatedMins = hmToMinutes(estimated);
    const firstSeen = matchObservation(
      dep.line,
      dep.destination,
      estimatedMins,
      previous,
      nextObservations,
    );
    const slipped = estimatedMins - firstSeen;
    if (slipped >= 0 && slipped <= MAX_INFERRED_DELAY_MIN) {
      delayMinutes = slipped;
    }
  }

  let status: DepartureEvent["status"] = "unknown";
  if (parsed.isCancelled) status = "cancelled";
  else if (
    watch.minDelay != null &&
    delayMinutes != null &&
    delayMinutes >= watch.minDelay
  )
    status = "delayed";
  else if (
    delayMinutes === 0 ||
    (watch.minDelay != null &&
      delayMinutes != null &&
      delayMinutes < watch.minDelay)
  )
    status = "on_time";

  return {
    line: dep.line,
    destination: dep.destination,
    platform: dep.platform,
    scheduledTime: parsed.scheduledTime,
    estimatedTime: parsed.estimatedTime,
    timeMark: dep.timeMark,
    delayMinutes,
    isRealtime: parsed.isRealtime,
    isCancelled: parsed.isCancelled,
    status,
  };
}

function readObservation(value: number | TripObservation): TripObservation {
  if (typeof value === "number") return { first: value, last: value };
  return value;
}

function matchObservation(
  line: string,
  destination: string,
  estimatedMins: number,
  previous: ObservationMap,
  nextObservations: Record<string, TripObservation>,
): number {
  const prefix = `${normalize(line)}|${normalize(destination)}|`;
  let bestKey: string | null = null;
  let bestDist = Infinity;
  let best: TripObservation | null = null;

  for (const [key, raw] of Object.entries(previous)) {
    if (!key.startsWith(prefix)) continue;
    if (key in nextObservations) continue;
    const obs = readObservation(raw);
    // Continuity vs last estimate — not vs first seen.
    // Otherwise the next hourly R9 looks like the previous one +60 min late.
    const jump = estimatedMins - obs.last;
    if (jump < -3 || jump > MAX_ESTIMATE_JUMP_MIN) continue;
    const dist = Math.abs(jump);
    if (dist < bestDist) {
      bestKey = key;
      bestDist = dist;
      best = obs;
    }
  }

  if (bestKey && best) {
    nextObservations[bestKey] = { first: best.first, last: estimatedMins };
    return best.first;
  }

  const newKey = `${prefix}${estimatedMins}`;
  nextObservations[newKey] = { first: estimatedMins, last: estimatedMins };
  return estimatedMins;
}

function hmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function parseTimeMark(
  raw: string,
  now: Date,
): {
  scheduledTime: string | null;
  estimatedTime: string | null;
  delayMinutes: number | null;
  isRealtime: boolean;
  isCancelled: boolean;
} {
  const cleaned = raw.replace(/[♿🛈ℹ*±]/g, " ").replace(/\s+/g, " ").trim();
  const isRealtime = raw.includes("±");
  const isCancelled = /\bzruš|\bcancel|neodjede/i.test(raw);
  const plusDelay = raw.match(/\+(\d+)\s*(?:min)?/i);
  const clock = cleaned.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  const relative = cleaned.match(/\b(\d+)\s*min\b/i);

  if (clock) {
    const hhmm = `${clock[1].padStart(2, "0")}:${clock[2]}`;
    return {
      scheduledTime: isRealtime ? null : hhmm,
      estimatedTime: hhmm,
      delayMinutes: plusDelay ? Number(plusDelay[1]) : isRealtime ? null : 0,
      isRealtime,
      isCancelled,
    };
  }

  if (relative) {
    const mins = Number(relative[1]);
    const estimated = new Date(now.getTime() + mins * 60_000);
    return {
      scheduledTime: null,
      estimatedTime: formatHm(estimated),
      delayMinutes: plusDelay ? Number(plusDelay[1]) : null,
      isRealtime: true,
      isCancelled,
    };
  }

  if (raw.includes("**")) {
    return {
      scheduledTime: null,
      estimatedTime: formatHm(now),
      delayMinutes: plusDelay ? Number(plusDelay[1]) : null,
      isRealtime: true,
      isCancelled,
    };
  }

  return {
    scheduledTime: null,
    estimatedTime: null,
    delayMinutes: plusDelay ? Number(plusDelay[1]) : null,
    isRealtime,
    isCancelled,
  };
}

async function fetchAlerts(): Promise<AlertEvent[]> {
  const params = new URLSearchParams({
    where: "isvalid='-1'",
    outFields:
      "title,publictext,affectedlines,type_,validfrom,validto,diversionid",
    returnGeometry: "false",
    resultRecordCount: "200",
    f: "json",
  });
  const res = await fetch(`${VYLUKY_URL}?${params}`, {
    headers: { "User-Agent": "train-notifications/0.1" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    features?: Array<{
      attributes: {
        diversionid: number;
        title: string;
        publictext: string;
        affectedlines: string;
        type_: string;
      };
    }>;
  };

  return (data.features ?? []).map((f) => {
    const a = f.attributes;
    return {
      id: String(a.diversionid),
      header: a.title || a.type_ || "Výluka",
      description: a.publictext || "",
      routes: String(a.affectedlines || "")
        .split(/[,;/]+/)
        .map((x) => x.trim())
        .filter(Boolean),
      effect: a.type_ || null,
    };
  });
}

/**
 * Board FinalStop matches watch `to` either directly, or as a train terminus
 * beyond `to` according to the GTFS via-beyond index in KV.
 */
function destinationServesWatch(
  boardDestination: string,
  wantedTo: string,
  from: string,
  stops: StopRef[],
  viaBeyond: ViaBeyondIndex,
): boolean {
  if (namesLooselyMatch(boardDestination, wantedTo)) return true;
  if (
    normalize(wantedTo).includes("brno") &&
    /(brno|brna|hlavn)/.test(normalize(boardDestination))
  ) {
    return true;
  }

  const fromStop = resolveStop(from, stops);
  const toStop = resolveStop(wantedTo, stops);
  if (!fromStop || !toStop) return false;

  const beyond = viaBeyond[`${fromStop.stopId}|${toStop.stopId}`];
  if (!beyond?.length) return false;

  const boardStop = resolveStop(boardDestination, stops);
  if (boardStop && beyond.includes(boardStop.stopId)) return true;

  const stopsById = new Map<number, StopRef>();
  for (const stop of stops) {
    if (!stopsById.has(stop.stopId)) stopsById.set(stop.stopId, stop);
  }
  for (const termId of beyond) {
    const term = stopsById.get(termId);
    if (term && namesLooselyMatch(boardDestination, term.name)) return true;
  }
  return false;
}

function namesLooselyMatch(a: string, b: string): boolean {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left);
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function formatHm(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Prague",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

export function noteworthyDepartures(
  departures: DepartureEvent[],
  minDelay: number | null,
): DepartureEvent[] {
  return departures.filter((d) => {
    if (d.status === "cancelled") return true;
    if (minDelay == null) return false;
    return (
      d.status === "delayed" ||
      (d.delayMinutes != null && d.delayMinutes >= minDelay)
    );
  });
}

export function fingerprint(
  departures: DepartureEvent[],
  alerts: AlertEvent[],
  minDelay: number | null,
): string {
  const depPart = noteworthyDepartures(departures, minDelay)
    .map(
      (d) =>
        `${d.line}|${d.destination}|${d.status}|${d.delayMinutes ?? ""}|${d.estimatedTime ?? d.scheduledTime ?? d.timeMark}`,
    )
    .sort()
    .join(";");
  const alertPart = alerts
    .map((a) => `${a.id}|${a.header}`)
    .sort()
    .join(";");
  return `${depPart}#${alertPart}`;
}
