import type { WatchSnapshot } from "./types";

export async function sendWebhook(
  webhookUrl: string,
  snapshot: WatchSnapshot,
): Promise<{ ok: boolean; status: number; body: string }> {
  const noteworthy = snapshot.noteworthy;
  const text =
    noteworthy.length > 0
      ? noteworthy
          .map((d) => {
            if (d.status === "cancelled") {
              return `ZRUŠENO ${d.line} → ${d.destination}`;
            }
            return `ZPOŽDĚNÍ +${d.delayMinutes ?? "?"} min ${d.line} → ${d.destination} (${d.estimatedTime ?? d.timeMark})`;
          })
          .join("\n")
      : `Bez zpoždění/zrušení na ${snapshot.watch.from} → ${snapshot.watch.to}`;

  const alertText = snapshot.alerts
    .slice(0, 3)
    .map((a) => `${a.header}: ${a.description}`.slice(0, 180))
    .join("\n");

  const payload = {
    text,
    message: text,
    title: "Vlaky / MHD",
    from: snapshot.watch.from,
    to: snapshot.watch.to,
    timeFrom: snapshot.watch.timeFrom,
    timeTo: snapshot.watch.timeTo,
    checkedAt: snapshot.checkedAt,
    departures: snapshot.departures,
    noteworthy,
    alerts: snapshot.alerts,
    alertText,
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "train-notifications/0.1",
    },
    body: JSON.stringify(payload),
  });

  return {
    ok: res.ok,
    status: res.status,
    body: await res.text(),
  };
}
