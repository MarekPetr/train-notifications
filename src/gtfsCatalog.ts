import type { StopRef } from "./stops";
import type { ViaBeyondIndex } from "./via";

const GTFS_URL = "https://kordis-jmk.cz/gtfs/gtfs.zip";

const TRAIN_ROUTE_RE = /^(S\d+|R\d+|os|sp|ex|ic|ec|en|rj|le)\b/i;

/** Download KORDIS GTFS and build stop + via-beyond catalogs. */
export async function buildCatalogFromGtfs(): Promise<{
  stops: StopRef[];
  viaBeyond: ViaBeyondIndex;
}> {
  const res = await fetch(GTFS_URL);
  if (!res.ok) {
    throw new Error(`GTFS download failed: HTTP ${res.status}`);
  }
  const zip = await res.arrayBuffer();
  const stopsTxt = await extractZipEntry(zip, "stops.txt");
  const routesTxt = await extractZipEntry(zip, "routes.txt");
  const tripsTxt = await extractZipEntry(zip, "trips.txt");
  const stopTimesTxt = await extractZipEntry(zip, "stop_times.txt");
  const decoder = new TextDecoder("utf-8");
  const stops = parseStopsTxt(decoder.decode(stopsTxt));
  const viaBeyond = buildViaBeyondIndex(
    decoder.decode(routesTxt),
    decoder.decode(tripsTxt),
    decoder.decode(stopTimesTxt),
  );
  return { stops, viaBeyond };
}

/** @deprecated prefer buildCatalogFromGtfs — kept for callers that only need stops. */
export async function buildStopsFromGtfs(): Promise<StopRef[]> {
  const { stops } = await buildCatalogFromGtfs();
  return stops;
}

/** Train patterns: fromStopId|toStopId → terminus ids continuing past `to`. */
export function buildViaBeyondIndex(
  routesTxt: string,
  tripsTxt: string,
  stopTimesTxt: string,
): ViaBeyondIndex {
  const routeShort = new Map<string, string>();
  {
    const lines = routesTxt.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return {};
    const headers = splitCsvLine(lines[0]);
    const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
    for (const line of lines.slice(1)) {
      const cols = splitCsvLine(line);
      routeShort.set(
        cols[idx.route_id] || "",
        (cols[idx.route_short_name] || "").trim(),
      );
    }
  }

  const tripIsTrain = new Map<string, boolean>();
  {
    const lines = tripsTxt.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return {};
    const headers = splitCsvLine(lines[0]);
    const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
    for (const line of lines.slice(1)) {
      const cols = splitCsvLine(line);
      const short = routeShort.get(cols[idx.route_id] || "") || "";
      tripIsTrain.set(cols[idx.trip_id] || "", TRAIN_ROUTE_RE.test(short));
    }
  }

  const patterns = new Set<string>();
  {
    const lines = stopTimesTxt
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter(Boolean);
    if (lines.length < 2) return {};
    const headers = splitCsvLine(lines[0]);
    const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
    let curTrip: string | null = null;
    let curTrain = false;
    let seq: number[] = [];

    const flush = () => {
      if (curTrain && seq.length >= 2) {
        const ids: number[] = [];
        for (const s of seq) {
          if (!ids.length || ids[ids.length - 1] !== s) ids.push(s);
        }
        if (ids.length >= 2) patterns.add(ids.join(">"));
      }
      seq = [];
    };

    for (const line of lines.slice(1)) {
      const cols = splitCsvLine(line);
      const tid = cols[idx.trip_id] || "";
      const sid = parseUId(cols[idx.stop_id] || "");
      if (sid == null) continue;
      if (curTrip === null) {
        curTrip = tid;
        curTrain = tripIsTrain.get(tid) === true;
      }
      if (tid !== curTrip) {
        flush();
        curTrip = tid;
        curTrain = tripIsTrain.get(tid) === true;
      }
      seq.push(sid);
    }
    flush();
  }

  const viaBeyond = new Map<string, Set<number>>();
  for (const key of patterns) {
    const ids = key.split(">").map(Number);
    const term = ids[ids.length - 1];
    for (let i = 0; i < ids.length; i++) {
      const seen = new Set<number>();
      for (let j = i + 1; j < ids.length; j++) {
        const to = ids[j];
        if (seen.has(to)) continue;
        seen.add(to);
        if (to === term) continue;
        const pair = `${ids[i]}|${to}`;
        let set = viaBeyond.get(pair);
        if (!set) {
          set = new Set();
          viaBeyond.set(pair, set);
        }
        set.add(term);
      }
    }
  }

  const out: ViaBeyondIndex = {};
  for (const [pair, set] of viaBeyond) {
    out[pair] = [...set].sort((a, b) => a - b);
  }
  return out;
}

function parseUId(raw: string): number | null {
  if (!raw.startsWith("U")) return null;
  const match = raw.match(/^U0*(\d+)/);
  return match ? Number(match[1]) : null;
}

export function parseStopsTxt(text: string): StopRef[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]);
  const idx = Object.fromEntries(headers.map((h, i) => [h, i]));
  const byName = new Map<string, StopRef>();

  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line);
    const stopIdRaw = cols[idx.stop_id] || "";
    const name = cols[idx.stop_name] || "";
    if (!name || !stopIdRaw.startsWith("U")) continue;
    const match = stopIdRaw.match(/^U0*(\d+)/);
    if (!match) continue;
    const stopId = Number(match[1]);
    const lat = Number(cols[idx.stop_lat]);
    const lon = Number(cols[idx.stop_lon]);
    const prev = byName.get(name);
    if (!prev || stopIdRaw.includes("N")) {
      byName.set(name, { name, stopId, lat, lon });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "cs"));
}

/** Extract a single stored/deflated entry from a ZIP ArrayBuffer. */
export async function extractZipEntry(
  buf: ArrayBuffer,
  fileName: string,
): Promise<Uint8Array> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let eocd = -1;
  const minEocd = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP: EOCD not found");

  const cdCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let i = 0; i < cdCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("ZIP: bad central directory");
    }
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(
      bytes.subarray(offset + 46, offset + 46 + nameLen),
    );
    const baseName = name.includes("/")
      ? name.slice(name.lastIndexOf("/") + 1)
      : name;

    if (baseName === fileName) {
      if (view.getUint32(localOffset, true) !== 0x04034b50) {
        throw new Error(`ZIP: bad local header for ${fileName}`);
      }
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const compressed = bytes.subarray(dataStart, dataStart + compSize);
      if (method === 0) return compressed.slice();
      if (method === 8) return inflateRaw(compressed);
      throw new Error(`ZIP: unsupported compression method ${method}`);
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }

  throw new Error(`ZIP: ${fileName} not found`);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function splitCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      q = !q;
      continue;
    }
    if (c === "," && !q) {
      cols.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  cols.push(cur);
  return cols;
}
