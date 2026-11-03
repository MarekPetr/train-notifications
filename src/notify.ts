import type { WatchSnapshot } from "./types";

export async function sendWebhook(
  webhookUrl: string,
  snapshot: WatchSnapshot,
): Promise<{ ok: boolean; status: number; body: string }> {
  const noteworthy = snapshot.noteworthy;
  const { from, to } = snapshot.watch;
  const text =
    noteworthy.length > 0
      ? noteworthy
          .map((d) => {
            const when =
              d.scheduledTime ?? d.estimatedTime ?? cleanTimeMark(d.timeMark);
            // Board IDS JMK dává označení linky (S3, 12, …), ne ČD číslo vlaku.
            if (d.status === "cancelled") {
              return `ZRUŠENO ${d.line} ${when} z ${from} do ${to}`;
            }
            return `ZPOŽDĚNÍ +${d.delayMinutes ?? "?"} min ${d.line} ${when} z ${from} do ${to}`;
          })
          .join("\n")
      : `Bez zpoždění z ${from} do ${to}`;

  const alertText = snapshot.alerts
    .slice(0, 3)
    .map((a) => `${a.header}: ${a.description}`.slice(0, 180))
    .join("\n");

  // MacroDroid spolehlivě mapuje query parametry na magické texty ({message}, …).
  // JSON body často ne — proto posíláme GET s query stringem.
  const url = new URL(webhookUrl);
  url.searchParams.set("message", clip(text, 1500));
  url.searchParams.set("title", "Vlaky / MHD");
  url.searchParams.set("from", snapshot.watch.from);
  url.searchParams.set("to", snapshot.watch.to);
  url.searchParams.set("timeFrom", snapshot.watch.timeFrom);
  url.searchParams.set("timeTo", snapshot.watch.timeTo);
  url.searchParams.set("checkedAt", snapshot.checkedAt);
  if (alertText) {
    url.searchParams.set("alertText", clip(alertText, 500));
  }

  try {
    const res = await fetchWithTimeout(url.toString(), 8_000);
    return {
      ok: res.ok,
      status: res.status,
      body: await res.text(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      body: message,
    };
  }
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "train-notifications/0.1",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function cleanTimeMark(raw: string): string {
  const cleaned = raw.replace(/[♿🛈ℹ*±]/g, " ").replace(/\s+/g, " ").trim();
  const clock = cleaned.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (clock) return `${clock[1].padStart(2, "0")}:${clock[2]}`;
  const relative = cleaned.match(/\b(\d+)\s*min\b/i);
  if (relative) return `za ${relative[1]} min`;
  return cleaned || "?";
}
