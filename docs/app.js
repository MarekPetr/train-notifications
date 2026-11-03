const form = document.getElementById("form");
const out = document.getElementById("out");
const stopsList = document.getElementById("stops");
const stopsStatus = document.getElementById("stopsStatus");
/** @type {Set<string>} */
let stopNames = new Set();

const isLocalHost =
  location.hostname === "127.0.0.1" ||
  location.hostname === "localhost" ||
  location.protocol === "file:";

function workerBase() {
  if (isLocalHost) return "http://127.0.0.1:8787";
  const url = window.TRAIN_NOTIFICATIONS_CONFIG?.productionWorkerUrl || "";
  return url.replace(/\/$/, "");
}

function value(id) {
  return document.getElementById(id).value.trim();
}

async function loadStops() {
  try {
    const res = await fetch("stops.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const names = await res.json();
    const aliases = ["Brno", "Tišnov", "Královo Pole", "Hrnčířská"];
    const all = [...new Set([...aliases, ...names])].sort((a, b) =>
      a.localeCompare(b, "cs"),
    );
    stopNames = new Set(all);
    const frag = document.createDocumentFragment();
    for (const name of all) {
      const opt = document.createElement("option");
      opt.value = name;
      frag.appendChild(opt);
    }
    stopsList.replaceChildren(frag);
    stopsStatus.textContent = `Seznam zastávek: ${all.length} položek (piš a vybírej z nápovědy).`;
  } catch (error) {
    stopsStatus.textContent =
      "Nepodařilo se načíst stops.json — zadej stanice ručně.";
    console.error(error);
  }
}

function warnUnknownStops() {
  const from = value("from");
  const to = value("to");
  if (!stopNames.size) return true;
  const unknown = [];
  if (from && !stopNames.has(from)) unknown.push(`Od: „${from}“`);
  if (to && !stopNames.has(to)) unknown.push(`Do: „${to}“`);
  if (!unknown.length) return true;
  return confirm(
    `Tyto názvy nejsou v katalogu zastávek:\n${unknown.join("\n")}\n\nPřesto pokračovat?`,
  );
}

function watchPath() {
  const from = encodeURIComponent(value("from").replace(/\s+/g, "_"));
  const to = encodeURIComponent(value("to").replace(/\s+/g, "_"));
  return `/watch/${from}/${to}`;
}

function query(extra = {}) {
  const params = new URLSearchParams({
    od: value("timeFrom"),
    do: value("timeTo"),
    minDelay: value("minDelay") || "5",
    webhook: value("webhook"),
    ...extra,
  });
  return params.toString();
}

function show(data) {
  out.textContent =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

async function call(method, pathWithQuery) {
  const base = workerBase();
  if (!base) {
    show(
      "Chybí productionWorkerUrl v config.js — doplň URL Cloudflare Workeru.",
    );
    return;
  }
  const url = `${base}${pathWithQuery}`;
  show(`${method} ${pathWithQuery}\n…`);
  const res = await fetch(url, { method });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    show({ error: true, status: res.status, body });
    return;
  }
  show(body);
}

document.getElementById("btnStatus").addEventListener("click", () => {
  if (!warnUnknownStops()) return;
  call("GET", `${watchPath()}?${query()}`).catch((e) => show(String(e)));
});

document.getElementById("btnRegister").addEventListener("click", () => {
  if (!value("webhook")) {
    show("Vyplň MacroDroid webhook URL.");
    return;
  }
  if (!warnUnknownStops()) return;
  call("POST", `${watchPath()}?${query()}`).catch((e) => show(String(e)));
});

document.getElementById("btnTest").addEventListener("click", () => {
  if (!value("webhook")) {
    show("Vyplň MacroDroid webhook URL.");
    return;
  }
  if (!warnUnknownStops()) return;
  call("GET", `${watchPath()}?${query({ push: "1" })}`).catch((e) =>
    show(String(e)),
  );
});

document.getElementById("btnDelete").addEventListener("click", () => {
  if (!warnUnknownStops()) return;
  call("DELETE", `${watchPath()}?${query()}`).catch((e) => show(String(e)));
});

document.getElementById("btnList").addEventListener("click", () => {
  call("GET", "/watches").catch((e) => show(String(e)));
});

form.addEventListener("submit", (event) => event.preventDefault());

const saved = localStorage.getItem("train-notifications-ui");
if (saved) {
  try {
    const data = JSON.parse(saved);
    for (const [key, val] of Object.entries(data)) {
      if (key === "workerUrl") continue;
      const el = document.getElementById(key);
      if (el && typeof val === "string") el.value = val;
    }
  } catch {
    /* ignore */
  }
}

form.addEventListener("change", () => {
  const data = {
    from: value("from"),
    to: value("to"),
    timeFrom: value("timeFrom"),
    timeTo: value("timeTo"),
    webhook: value("webhook"),
    minDelay: value("minDelay"),
  };
  localStorage.setItem("train-notifications-ui", JSON.stringify(data));
});

loadStops();
