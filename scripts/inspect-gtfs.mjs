import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const gtfsDir = path.join(os.tmpdir(), "kordis-gtfs", "out");

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

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

const stops = parseCsv(fs.readFileSync(path.join(gtfsDir, "stops.txt"), "utf8"));
const routes = parseCsv(fs.readFileSync(path.join(gtfsDir, "routes.txt"), "utf8"));
const trips = parseCsv(fs.readFileSync(path.join(gtfsDir, "trips.txt"), "utf8"));

const tisnov = stops.filter((s) => /Tišnov,\s*železniční stanice/i.test(s.stop_name));
const brno = stops.filter(
  (s) => /Brno hl\.n\./i.test(s.stop_name) || s.stop_name === "Hlavní nádraží",
);

console.log(
  "tisnov",
  [...new Set(tisnov.map((s) => s.stop_id))],
  tisnov[0]?.stop_name,
);
console.log(
  "brno",
  brno.slice(0, 12).map((s) => `${s.stop_id} ${s.stop_name}`),
);

const wantedRoutes = routes.filter((r) => ["S3", "R9"].includes(r.route_short_name));
console.log("routes", wantedRoutes);

const routeIds = new Set(wantedRoutes.map((r) => r.route_id));
const wantedTrips = trips.filter((t) => routeIds.has(t.route_id));
console.log("trips", wantedTrips.length, wantedTrips.slice(0, 5));

const tisnovIds = new Set(tisnov.map((s) => s.stop_id));
const brnoIds = new Set(brno.map((s) => s.stop_id));

// Stream stop_times once for relevant trips
const tripSet = new Set(wantedTrips.map((t) => t.trip_id));
const byTrip = new Map();
const st = fs.readFileSync(path.join(gtfsDir, "stop_times.txt"), "utf8").split(/\r?\n/);
const stHeaders = splitCsvLine(st[0]);
const idx = Object.fromEntries(stHeaders.map((h, i) => [h, i]));

for (let i = 1; i < st.length; i++) {
  if (!st[i]) continue;
  const cols = splitCsvLine(st[i]);
  const tripId = cols[idx.trip_id];
  if (!tripSet.has(tripId)) continue;
  const stopId = cols[idx.stop_id];
  const dep = cols[idx.departure_time];
  const seq = Number(cols[idx.stop_sequence]);
  if (!byTrip.has(tripId)) byTrip.set(tripId, []);
  byTrip.get(tripId).push({ stopId, dep, seq });
}

const connections = [];
for (const [tripId, stopsOnTrip] of byTrip) {
  stopsOnTrip.sort((a, b) => a.seq - b.seq);
  const from = stopsOnTrip.find((s) => tisnovIds.has(s.stopId));
  const to = stopsOnTrip.find((s) => brnoIds.has(s.stopId));
  if (!from || !to || to.seq <= from.seq) continue;
  const trip = wantedTrips.find((t) => t.trip_id === tripId);
  const route = wantedRoutes.find((r) => r.route_id === trip.route_id);
  connections.push({
    tripId,
    route: route?.route_short_name,
    headsign: trip?.trip_headsign,
    fromStopId: from.stopId,
    toStopId: to.stopId,
    departure: from.dep,
    arrival: to.dep,
  });
}

connections.sort((a, b) => a.departure.localeCompare(b.departure));
console.log("connections", connections.length);
console.log(connections.filter((c) => c.departure >= "06:00:00" && c.departure <= "09:00:00").slice(0, 15));
fs.writeFileSync(
  path.join(process.cwd(), "tisnov-brno-sample.json"),
  JSON.stringify(connections.slice(0, 40), null, 2),
);
