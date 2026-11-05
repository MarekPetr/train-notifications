import type { AppStore } from "./store";

export interface Env {
  APP_STORE: DurableObjectNamespace<AppStore>;
  /** Kept for STORAGE_BACKEND=kv and one-shot DO migration. */
  WATCHES: KVNamespace;
  ASSETS: Fetcher;
  TZ: string;
  /** Set on each `npm run deploy` — triggers one-shot GTFS catalog rebuild. */
  DEPLOY_ID: string;
  /** `do` (default) = Durable Object; `kv` = legacy Workers KV. */
  STORAGE_BACKEND?: string;
}

export interface StopRef {
  name: string;
  stopId: number;
  lat: number;
  lon: number;
}

export interface StopsCatalogMeta {
  updatedAt: string;
  count: number;
  source: "kv" | "bundle" | "gtfs";
  viaPairCount?: number;
}

/** fromStopId|toStopId → terminus stopIds that continue past `to`. */
export type ViaBeyondIndex = Record<string, number[]>;

export interface ViaCatalogMeta {
  updatedAt: string;
  pairCount: number;
  source: "kv" | "empty";
}

export interface WatchConfig {
  from: string;
  to: string;
  timeFrom: string;
  timeTo: string;
  webhook?: string;
  /** Práh zpoždění v minutách; `null` = sledovat jen zrušení (ne zpoždění). */
  minDelay: number | null;
}

export interface DepartureEvent {
  line: string;
  destination: string;
  platform: string | null;
  scheduledTime: string | null;
  estimatedTime: string | null;
  timeMark: string;
  delayMinutes: number | null;
  isRealtime: boolean;
  isCancelled: boolean;
  status: "on_time" | "delayed" | "cancelled" | "unknown";
}

export interface AlertEvent {
  id: string;
  header: string;
  description: string;
  routes: string[];
  effect: string | null;
}

export interface WatchSnapshot {
  watch: WatchConfig;
  checkedAt: string;
  departures: DepartureEvent[];
  alerts: AlertEvent[];
  noteworthy: DepartureEvent[];
}

/** Delay-tracking sample for one trip (minutes from midnight, Prague). */
export interface TripObservation {
  /** First estimated departure seen for this trip. */
  first: number;
  /** Most recent estimated departure (for continuity matching). */
  last: number;
}

export interface StoredWatch extends WatchConfig {
  id: string;
  createdAt: string;
  lastFingerprint?: string;
  /**
   * Live estimate tracking keyed by trip identity.
   * Legacy values may be a bare number (= first=last).
   */
  observations?: Record<string, number | TripObservation>;
}
