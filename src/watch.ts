import type { WatchConfig } from "./types";

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function decodeStation(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, "%20"))
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .trim();
}

export function parseTime(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const normalized = value.trim();
  if (!TIME_RE.test(normalized)) {
    throw new Error(`Neplatný čas '${value}', očekávám HH:MM`);
  }
  const [h, m] = normalized.split(":");
  return `${h.padStart(2, "0")}:${m}`;
}

export function parseWatchFromRequest(
  fromRaw: string,
  toRaw: string,
  url: URL,
  defaultMinDelay: number,
): WatchConfig {
  const from = decodeStation(fromRaw);
  const to = decodeStation(toRaw);
  if (!from || !to) {
    throw new Error("Cesta musí obsahovat /watch/{od}/{do}");
  }

  const timeFrom = parseTime(
    url.searchParams.get("od") ?? url.searchParams.get("timeFrom"),
    "00:00",
  );
  const timeTo = parseTime(
    url.searchParams.get("do") ?? url.searchParams.get("timeTo"),
    "23:59",
  );

  const webhook =
    url.searchParams.get("webhook") ??
    url.searchParams.get("callback") ??
    undefined;

  const minDelayRaw =
    url.searchParams.get("minDelay") ?? url.searchParams.get("zpozdeni");
  const minDelay = minDelayRaw ? Number(minDelayRaw) : defaultMinDelay;
  if (!Number.isFinite(minDelay) || minDelay < 0) {
    throw new Error("minDelay musí být nezáporné číslo");
  }

  return { from, to, timeFrom, timeTo, webhook, minDelay };
}

export function watchId(watch: WatchConfig): string {
  const key = [
    watch.from.toLowerCase(),
    watch.to.toLowerCase(),
    watch.timeFrom,
    watch.timeTo,
    watch.webhook ?? "",
  ].join("|");
  return `watch:${hash(key)}`;
}

function hash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isWithinWindow(
  hhmm: string,
  timeFrom: string,
  timeTo: string,
): boolean {
  const value = timeToMinutes(hhmm);
  const from = timeToMinutes(timeFrom);
  const to = timeToMinutes(timeTo);
  if (from <= to) return value >= from && value <= to;
  // přes půlnoc
  return value >= from || value <= to;
}
