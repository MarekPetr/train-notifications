export interface Env {
  WATCHES: KVNamespace;
  TZ: string;
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

export interface StoredWatch extends WatchConfig {
  id: string;
  createdAt: string;
  lastFingerprint?: string;
  /** First seen estimates keyed by trip identity, minutes from midnight. */
  observations?: Record<string, number>;
}
