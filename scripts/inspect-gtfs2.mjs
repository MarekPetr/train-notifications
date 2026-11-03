import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const gtfsDir = path.join(os.tmpdir(), "kordis-gtfs", "out");

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

const stopLines = fs.readFileSync(path.join(gtfsDir, "stops.txt"), "utf8").split(/\r?\n/);
for (const line of stopLines) {
  if (/Brno hl/i.test(line) || (/Hlavní nádraží/i.test(line) && /U0?1?146|U1100|zel|želez/i.test(line))) {
    console.log(line);
  }
}

console.log("--- tisnov stop_times ---");
const st = fs.readFileSync(path.join(gtfsDir, "stop_times.txt"), "utf8").split(/\r?\n/);
const headers = splitCsvLine(st[0]);
const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

let tripId = null;
for (let n = 1; n < st.length; n++) {
  const cols = splitCsvLine(st[n]);
  if ((cols[idx.stop_id] || "").startsWith("U13334")) {
    tripId = cols[idx.trip_id];
    console.log({
      trip: tripId,
      stop: cols[idx.stop_id],
      dep: cols[idx.departure_time],
      seq: cols[idx.stop_sequence],
    });
    break;
  }
}

const stops = [];
for (let n = 1; n < st.length; n++) {
  const cols = splitCsvLine(st[n]);
  if (cols[idx.trip_id] === tripId) {
    stops.push({
      stop: cols[idx.stop_id],
      dep: cols[idx.departure_time],
      seq: Number(cols[idx.stop_sequence]),
    });
  }
}
stops.sort((a, b) => a.seq - b.seq);

const stopMap = new Map();
for (const line of stopLines.slice(1)) {
  if (!line) continue;
  const cols = splitCsvLine(line);
  stopMap.set(cols[0], cols[1]);
}

console.log(
  "trip path",
  tripId,
  stops.map((s) => `${s.seq} ${s.stop} ${stopMap.get(s.stop)} @ ${s.dep}`),
);
