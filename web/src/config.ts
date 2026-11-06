export type UiConfig = {
  productionWorkerUrl: string;
};

/** Produkční Worker slouží UI i API ze stejného originu. */
export const config: UiConfig = {
  productionWorkerUrl: "",
};

export function workerBase(): string {
  const host = location.hostname;
  const isLocal =
    host === "127.0.0.1" ||
    host === "localhost" ||
    location.protocol === "file:";
  if (isLocal) {
    // Vite dev (5173) → Worker; wrangler assets / production → same origin.
    if (location.port === "5173") return "http://127.0.0.1:8787";
    return location.origin;
  }
  const configured = config.productionWorkerUrl.trim();
  if (configured) return configured.replace(/\/$/, "");
  return location.origin;
}
