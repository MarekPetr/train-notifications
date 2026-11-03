const form = document.getElementById("form");
const out = document.getElementById("out");
const stopsList = document.getElementById("stops");
const stopsStatus = document.getElementById("stopsStatus");
const watchList = document.getElementById("watchList");
const watchListStatus = document.getElementById("watchListStatus");
/** @type {Set<string>} */
let stopNames = new Set();
/** @type {Array<Record<string, unknown>>} */
let cachedWatches = [];
let listTimer = 0;

const isLocalHost =
  location.hostname === "127.0.0.1" ||
  location.hostname === "localhost" ||
  location.protocol === "file:";

function workerBase() {
  if (isLocalHost) return "http://127.0.0.1:8787";
  const configured =
    window.TRAIN_NOTIFICATIONS_CONFIG?.productionWorkerUrl || "";
  if (configured) return configured.replace(/\/$/, "");
  return location.origin;
}

function value(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : "";
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val ?? "";
}

async function loadStops() {
  try {
    let res = await fetch(`${workerBase()}/api/stops`);
    if (!res.ok) {
      res = await fetch("stops.json");
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const names = Array.isArray(data) ? data : data.names;
    if (!Array.isArray(names)) throw new Error("unexpected stops payload");
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
    const src =
      data && !Array.isArray(data) && data.source
        ? ` · zdroj ${data.source}`
        : "";
    const updated =
      data && !Array.isArray(data) && data.updatedAt
        ? ` · ${new Date(data.updatedAt).toLocaleString("cs-CZ")}`
        : "";
    stopsStatus.textContent = `Seznam zastávek: ${all.length} položek${src}${updated} (piš a vybírej z nápovědy).`;
  } catch (error) {
    stopsStatus.textContent =
      "Nepodařilo se načíst zastávky — zadej stanice ručně.";
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

function watchPath(from = value("from"), to = value("to")) {
  const a = encodeURIComponent(String(from).replace(/\s+/g, "_"));
  const b = encodeURIComponent(String(to).replace(/\s+/g, "_"));
  return `/watch/${a}/${b}`;
}

function query(extra = {}, watch = null) {
  const params = new URLSearchParams({
    od: watch?.timeFrom ?? value("timeFrom"),
    do: watch?.timeTo ?? value("timeTo"),
    webhook: watch?.webhook ?? value("webhook"),
    ...extra,
  });
  const rawMin =
    watch && "minDelay" in watch ? watch.minDelay : value("minDelay");
  if (rawMin != null && String(rawMin).trim() !== "") {
    params.set("minDelay", String(rawMin));
  }
  return params.toString();
}

function show(data) {
  out.textContent =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

function persistForm() {
  const data = {
    from: value("from"),
    to: value("to"),
    timeFrom: value("timeFrom"),
    timeTo: value("timeTo"),
    webhook: value("webhook"),
    minDelay: value("minDelay"),
  };
  localStorage.setItem("train-notifications-ui", JSON.stringify(data));
}

async function api(method, pathWithQuery) {
  const base = workerBase();
  const res = await fetch(`${base}${pathWithQuery}`, { method });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(
      typeof body === "object" && body?.error
        ? String(body.error)
        : `HTTP ${res.status}`,
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function call(method, pathWithQuery) {
  show(`${method} ${pathWithQuery}\n…`);
  try {
    const body = await api(method, pathWithQuery);
    show(body);
    return body;
  } catch (error) {
    show({
      error: true,
      status: error.status,
      body: error.body ?? String(error.message || error),
    });
    throw error;
  }
}

function fillForm(watch) {
  setValue("from", watch.from);
  setValue("to", watch.to);
  setValue("timeFrom", watch.timeFrom);
  setValue("timeTo", watch.timeTo);
  setValue(
    "minDelay",
    watch.minDelay == null ? "" : String(watch.minDelay),
  );
  if (watch.webhook) setValue("webhook", watch.webhook);
  setValue("editingId", watch.id || "");
  persistForm();
  renderWatchList();
}

function clearEditing() {
  setValue("editingId", "");
  renderWatchList();
}

function renderWatchList() {
  const editingId = value("editingId");
  watchList.replaceChildren();

  if (!value("webhook")) {
    watchListStatus.textContent =
      "Vyplň webhook URL — seznam se načte automaticky.";
    return;
  }

  if (!cachedWatches.length) {
    watchListStatus.textContent = "Pro tento webhook zatím žádné sledování.";
    return;
  }

  watchListStatus.textContent = `${cachedWatches.length} sledování pro tento webhook.`;

  for (const watch of cachedWatches) {
    const li = document.createElement("li");
    li.className = "watch-item";
    if (watch.id === editingId) li.classList.add("is-editing");

    const main = document.createElement("div");
    main.className = "watch-item-main";

    const route = document.createElement("div");
    route.className = "watch-item-route";
    route.textContent = `${watch.from} → ${watch.to}`;

    const meta = document.createElement("div");
    meta.className = "watch-item-meta";
    meta.textContent =
      watch.minDelay == null
        ? `${watch.timeFrom}–${watch.timeTo} · jen zrušení`
        : `${watch.timeFrom}–${watch.timeTo} · min. zpoždění ${watch.minDelay} min`;

    main.append(route, meta);

    const actions = document.createElement("div");
    actions.className = "watch-item-actions";

    const btnEdit = document.createElement("button");
    btnEdit.type = "button";
    btnEdit.textContent = "Upravit";
    btnEdit.addEventListener("click", () => fillForm(watch));

    const btnStatus = document.createElement("button");
    btnStatus.type = "button";
    btnStatus.textContent = "Stav";
    btnStatus.addEventListener("click", () => {
      call("GET", `${watchPath(watch.from, watch.to)}?${query({}, watch)}`).catch(
        () => {},
      );
    });

    const btnTest = document.createElement("button");
    btnTest.type = "button";
    btnTest.textContent = "Test";
    btnTest.addEventListener("click", () => {
      call(
        "GET",
        `${watchPath(watch.from, watch.to)}?${query({ push: "1" }, watch)}`,
      ).catch(() => {});
    });

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "danger";
    btnDel.textContent = "Smazat";
    btnDel.addEventListener("click", () => deleteWatch(watch));

    actions.append(btnEdit, btnStatus, btnTest, btnDel);
    li.append(main, actions);
    watchList.appendChild(li);
  }
}

async function refreshWatchList() {
  const webhook = value("webhook");
  if (!webhook) {
    cachedWatches = [];
    renderWatchList();
    return;
  }
  watchListStatus.textContent = "Načítám seznam…";
  try {
    const data = await api(
      "GET",
      `/watches?${new URLSearchParams({ webhook }).toString()}`,
    );
    cachedWatches = Array.isArray(data.watches) ? data.watches : [];
    renderWatchList();
  } catch (error) {
    cachedWatches = [];
    watchListStatus.textContent = `Seznam se nepodařilo načíst: ${error.message || error}`;
  }
}

function scheduleListRefresh() {
  window.clearTimeout(listTimer);
  listTimer = window.setTimeout(() => {
    refreshWatchList().catch(() => {});
  }, 350);
}

async function deleteWatch(watch) {
  if (!confirm(`Smazat sledování\n${watch.from} → ${watch.to}\n${watch.timeFrom}–${watch.timeTo}?`)) {
    return;
  }
  try {
    const webhook = watch.webhook || value("webhook");
    const body = await call(
      "DELETE",
      `/watches/${encodeURIComponent(watch.id)}?${new URLSearchParams({ webhook }).toString()}`,
    );
    if (value("editingId") === watch.id) clearEditing();
    show(body);
    await refreshWatchList();
  } catch {
    /* already shown */
  }
}

document.getElementById("btnStatus").addEventListener("click", () => {
  if (!warnUnknownStops()) return;
  call("GET", `${watchPath()}?${query()}`).catch(() => {});
});

document.getElementById("btnRegister").addEventListener("click", async () => {
  if (!value("webhook")) {
    show("Vyplň MacroDroid webhook URL.");
    return;
  }
  if (!warnUnknownStops()) return;
  const previousId = value("editingId");
  try {
    const body = await call("POST", `${watchPath()}?${query()}`);
    const newId = body?.id;
    if (previousId && newId && previousId !== newId) {
      try {
        const webhook = value("webhook");
        await api(
          "DELETE",
          `/watches/${encodeURIComponent(previousId)}?${new URLSearchParams({ webhook }).toString()}`,
        );
      } catch {
        /* starý záznam možná už neexistuje */
      }
    }
    setValue("editingId", newId || "");
    await refreshWatchList();
  } catch {
    /* already shown */
  }
});

document.getElementById("btnTest").addEventListener("click", () => {
  if (!value("webhook")) {
    show("Vyplň MacroDroid webhook URL.");
    return;
  }
  if (!warnUnknownStops()) return;
  call("GET", `${watchPath()}?${query({ push: "1" })}`).catch(() => {});
});

document.getElementById("btnDelete").addEventListener("click", async () => {
  const editingId = value("editingId");
  if (editingId) {
    const watch = cachedWatches.find((w) => w.id === editingId) || {
      id: editingId,
      from: value("from"),
      to: value("to"),
      timeFrom: value("timeFrom"),
      timeTo: value("timeTo"),
    };
    await deleteWatch(watch);
    return;
  }
  if (!warnUnknownStops()) return;
  try {
    await call("DELETE", `${watchPath()}?${query()}`);
    clearEditing();
    await refreshWatchList();
  } catch {
    /* already shown */
  }
});

document.getElementById("btnRefreshList").addEventListener("click", () => {
  refreshWatchList().catch(() => {});
});

form.addEventListener("submit", (event) => event.preventDefault());

const saved = localStorage.getItem("train-notifications-ui");
if (saved) {
  try {
    const data = JSON.parse(saved);
    for (const [key, val] of Object.entries(data)) {
      if (key === "workerUrl") continue;
      if (typeof val === "string") setValue(key, val);
    }
  } catch {
    /* ignore */
  }
}

form.addEventListener("change", () => {
  persistForm();
  if (document.activeElement?.id === "webhook") scheduleListRefresh();
});

document.getElementById("webhook").addEventListener("input", () => {
  persistForm();
  scheduleListRefresh();
});

loadStops();
refreshWatchList().catch(() => {});
