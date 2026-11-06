import { workerBase } from "./config";

export type StoredWatch = {
  id: string;
  from: string;
  to: string;
  timeFrom: string;
  timeTo: string;
  webhook?: string;
  minDelay: number | null;
  createdAt?: string;
};

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api(method: string, pathWithQuery: string): Promise<unknown> {
  const res = await fetch(`${workerBase()}${pathWithQuery}`, { method });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message =
      typeof body === "object" &&
      body &&
      "error" in body &&
      (body as { error: unknown }).error != null
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(message, res.status, body);
  }
  return body;
}

export function watchPath(from: string, to: string): string {
  const a = encodeURIComponent(String(from).replace(/\s+/g, "_"));
  const b = encodeURIComponent(String(to).replace(/\s+/g, "_"));
  return `/watch/${a}/${b}`;
}

export function watchQuery(
  fields: {
    timeFrom: string;
    timeTo: string;
    webhook: string;
    minDelay: string;
  },
  extra: Record<string, string> = {},
  watch?: Partial<StoredWatch> | null,
): string {
  const params = new URLSearchParams({
    od: watch?.timeFrom ?? fields.timeFrom,
    do: watch?.timeTo ?? fields.timeTo,
    webhook: watch?.webhook ?? fields.webhook,
    ...extra,
  });
  const rawMin =
    watch && "minDelay" in watch ? watch.minDelay : fields.minDelay;
  if (rawMin != null && String(rawMin).trim() !== "") {
    params.set("minDelay", String(rawMin));
  }
  return params.toString();
}
