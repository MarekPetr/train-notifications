import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src", "data");
const tmp = path.join(os.tmpdir(), "kordis-gtfs-build");
const zipPath = path.join(tmp, "gtfs.zip");
const extracted = path.join(tmp, "out");

fs.mkdirSync(tmp, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

console.log("Downloading GTFS...");
execFileSync("curl.exe", ["-sL", "https://kordis-jmk.cz/gtfs/gtfs.zip", "-o", zipPath], {
  stdio: "inherit",
});

fs.rmSync(extracted, { recursive: true, force: true });
fs.mkdirSync(extracted, { recursive: true });
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    `Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extracted.replace(/'/g, "''")}'`,
  ],
  { stdio: "inherit" },
);

function splitCsvLine(line) {
  const cols = [];
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

const lines = fs
  .readFileSync(path.join(extracted, "stops.txt"), "utf8")
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .filter(Boolean);
const headers = splitCsvLine(lines[0]);
const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

/** @type {Map<string, { name: string, stopId: number, lat: number, lon: number }>} */
const byName = new Map();

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

const stops = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "cs"));
fs.writeFileSync(path.join(outDir, "stops.json"), JSON.stringify(stops));
console.log(`Wrote ${stops.length} stops to src/data/stops.json`);

const webPublic = path.join(root, "web", "public");
fs.mkdirSync(webPublic, { recursive: true });
const names = stops.map((s) => s.name);
fs.writeFileSync(path.join(webPublic, "stops.json"), JSON.stringify(names));
console.log(`Wrote ${names.length} stop names to web/public/stops.json`);
console.log(
  "Note: via-beyond index is built by Worker refresh (KV catalog:via-beyond), not this script.",
);
