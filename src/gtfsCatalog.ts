import type { StopRef } from "./stops";

const GTFS_URL = "https://kordis-jmk.cz/gtfs/gtfs.zip";

/** Download KORDIS GTFS and build the stop catalog (same rules as build-stops.mjs). */
export async function buildStopsFromGtfs(): Promise<StopRef[]> {
  const res = await fetch(GTFS_URL);
  if (!res.ok) {
    throw new Error(`GTFS download failed: HTTP ${res.status}`);
  }
  const zip = await res.arrayBuffer();
  const stopsTxt = await extractZipEntry(zip, "stops.txt");
  return parseStopsTxt(new TextDecoder("utf-8").decode(stopsTxt));
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
