import stops from "./data/stops.json";

export interface StopRef {
  name: string;
  stopId: number;
  lat: number;
  lon: number;
}

export function resolveStop(query: string): StopRef | null {
  const q = normalize(query);
  if (!q) return null;

  let best: { stop: StopRef; score: number } | null = null;
  for (const stop of stops as StopRef[]) {
    const name = normalize(stop.name);
    let score = 0;
    if (name === q) score = 1000;
    else if (name.startsWith(q + " ")) score = 800;
    else if (name.startsWith(q)) score = 700;
    else if (name.includes(q)) score = 500;
    else continue;

    if (q.split(" ").length <= 2 && /(zeleznicni|zel st|nadrazi|hl n)/.test(name)) {
      score += 120;
    }
    score -= Math.min(name.length, 60);

    if (!best || score > best.score) best = { stop, score };
  }
  return best?.stop ?? null;
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
