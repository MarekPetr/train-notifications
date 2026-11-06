<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  api,
  ApiError,
  type StoredWatch,
  watchPath,
  watchQuery,
} from "./api";
import { workerBase } from "./config";
import StopCombo from "./components/StopCombo.vue";

const STORAGE_KEY = "train-notifications-ui";

const from = ref("");
const to = ref("");
const timeFrom = ref("");
const timeTo = ref("");
const webhook = ref("");
const minDelay = ref("");
const editingId = ref("");

const stopItems = ref<string[]>([]);
const stopNames = computed(() => new Set(stopItems.value));
const stopsStatus = ref("Načítám seznam zastávek…");

const watches = ref<StoredWatch[]>([]);
const watchListStatus = ref(
  "Vyplň webhook URL — seznam se načte automaticky.",
);
const out = ref("Připraveno.");

const editing = computed(() => Boolean(editingId.value));

let listTimer = 0;

function fields() {
  return {
    timeFrom: timeFrom.value.trim(),
    timeTo: timeTo.value.trim(),
    webhook: webhook.value.trim(),
    minDelay: minDelay.value.trim(),
  };
}

function show(data: unknown) {
  out.value =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

function persistForm() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ webhook: webhook.value.trim() }),
  );
}

async function call(method: string, pathWithQuery: string) {
  show(`${method} ${pathWithQuery}\n…`);
  try {
    const body = await api(method, pathWithQuery);
    show(body);
    return body;
  } catch (error) {
    const err = error as ApiError;
    show({
      error: true,
      status: err.status,
      body: err.body ?? String(err.message || error),
    });
    throw error;
  }
}

function warnUnknownStops(): boolean {
  if (!stopNames.value.size) return true;
  const unknown: string[] = [];
  const f = from.value.trim();
  const t = to.value.trim();
  if (f && !stopNames.value.has(f)) unknown.push(`Od: „${f}“`);
  if (t && !stopNames.value.has(t)) unknown.push(`Do: „${t}“`);
  if (!unknown.length) return true;
  return confirm(
    `Tyto názvy nejsou v katalogu zastávek:\n${unknown.join("\n")}\n\nPřesto pokračovat?`,
  );
}

async function loadStops() {
  try {
    let res = await fetch(`${workerBase()}/api/stops`);
    if (!res.ok) res = await fetch("/stops.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const names = Array.isArray(data) ? data : data.names;
    if (!Array.isArray(names)) throw new Error("unexpected stops payload");
    const aliases = ["Brno", "Tišnov", "Královo Pole", "Hrnčířská"];
    const all = [...new Set([...aliases, ...names])].sort((a, b) =>
      a.localeCompare(b, "cs"),
    );
    stopItems.value = all;
    const src =
      data && !Array.isArray(data) && data.source
        ? ` · zdroj ${data.source}`
        : "";
    const updated =
      data && !Array.isArray(data) && data.updatedAt
        ? ` · ${new Date(data.updatedAt).toLocaleString("cs-CZ")}`
        : "";
    stopsStatus.value = `Seznam zastávek: ${all.length} položek${src}${updated} (piš a vybírej z nápovědy).`;
  } catch (error) {
    stopsStatus.value =
      "Nepodařilo se načíst zastávky — zadej stanice ručně.";
    console.error(error);
  }
}

function renderWatchListStatus() {
  if (!webhook.value.trim()) {
    watchListStatus.value =
      "Vyplň webhook URL — seznam se načte automaticky.";
    return;
  }
  if (!watches.value.length) {
    watchListStatus.value = "Pro tento webhook zatím žádné sledování.";
    return;
  }
  watchListStatus.value = `${watches.value.length} sledování pro tento webhook.`;
}

async function refreshWatchList() {
  const wh = webhook.value.trim();
  if (!wh) {
    watches.value = [];
    renderWatchListStatus();
    return;
  }
  watchListStatus.value = "Načítám seznam…";
  try {
    const data = (await api(
      "GET",
      `/watches?${new URLSearchParams({ webhook: wh }).toString()}`,
    )) as { watches?: StoredWatch[] };
    watches.value = Array.isArray(data.watches) ? data.watches : [];
    renderWatchListStatus();
  } catch (error) {
    watches.value = [];
    watchListStatus.value = `Seznam se nepodařilo načíst: ${(error as Error).message || error}`;
  }
}

function scheduleListRefresh() {
  window.clearTimeout(listTimer);
  listTimer = window.setTimeout(() => {
    void refreshWatchList();
  }, 350);
}

function fillForm(watch: StoredWatch) {
  from.value = watch.from;
  to.value = watch.to;
  timeFrom.value = watch.timeFrom;
  timeTo.value = watch.timeTo;
  minDelay.value = watch.minDelay == null ? "" : String(watch.minDelay);
  if (watch.webhook) webhook.value = watch.webhook;
  editingId.value = watch.id || "";
  persistForm();
}

function resetFormFields() {
  from.value = "";
  to.value = "";
  timeFrom.value = "";
  timeTo.value = "";
  minDelay.value = "";
}

function clearEditing() {
  editingId.value = "";
  resetFormFields();
  persistForm();
}

async function deleteWatch(watch: StoredWatch) {
  if (
    !confirm(
      `Smazat sledování\n${watch.from} → ${watch.to}\n${watch.timeFrom}–${watch.timeTo}?`,
    )
  ) {
    return;
  }
  try {
    const wh = watch.webhook || webhook.value.trim();
    const body = await call(
      "DELETE",
      `/watches/${encodeURIComponent(watch.id)}?${new URLSearchParams({ webhook: wh }).toString()}`,
    );
    if (editingId.value === watch.id) clearEditing();
    show(body);
    await refreshWatchList();
  } catch {
    /* already shown */
  }
}

async function onStatus() {
  if (!warnUnknownStops()) return;
  void call(
    "GET",
    `${watchPath(from.value, to.value)}?${watchQuery(fields())}`,
  );
}

async function onRegister() {
  if (!webhook.value.trim()) {
    show("Vyplň MacroDroid webhook URL.");
    return;
  }
  if (!warnUnknownStops()) return;
  const previousId = editingId.value;
  try {
    const body = (await call(
      "POST",
      `${watchPath(from.value, to.value)}?${watchQuery(fields())}`,
    )) as { id?: string };
    const newId = body?.id;
    if (previousId && newId && previousId !== newId) {
      try {
        await api(
          "DELETE",
          `/watches/${encodeURIComponent(previousId)}?${new URLSearchParams({ webhook: webhook.value.trim() }).toString()}`,
        );
      } catch {
        /* starý záznam možná už neexistuje */
      }
    }
    editingId.value = newId || "";
    await refreshWatchList();
  } catch {
    /* already shown */
  }
}

function onCancel() {
  clearEditing();
  show("Editace zrušena.");
}

async function onTest() {
  if (!webhook.value.trim()) {
    show("Vyplň MacroDroid webhook URL.");
    return;
  }
  if (!warnUnknownStops()) return;
  void call(
    "GET",
    `${watchPath(from.value, to.value)}?${watchQuery(fields(), { push: "1" })}`,
  );
}

async function onDelete() {
  if (editingId.value) {
    const watch =
      watches.value.find((w) => w.id === editingId.value) ||
      ({
        id: editingId.value,
        from: from.value,
        to: to.value,
        timeFrom: timeFrom.value,
        timeTo: timeTo.value,
        minDelay: null,
      } satisfies StoredWatch);
    await deleteWatch(watch);
    return;
  }
  if (!warnUnknownStops()) return;
  try {
    await call(
      "DELETE",
      `${watchPath(from.value, to.value)}?${watchQuery(fields())}`,
    );
    clearEditing();
    await refreshWatchList();
  } catch {
    /* already shown */
  }
}

function onWatchStatus(watch: StoredWatch) {
  void call(
    "GET",
    `${watchPath(watch.from, watch.to)}?${watchQuery(fields(), {}, watch)}`,
  );
}

function onWatchTest(watch: StoredWatch) {
  void call(
    "GET",
    `${watchPath(watch.from, watch.to)}?${watchQuery(fields(), { push: "1" }, watch)}`,
  );
}

function watchMeta(watch: StoredWatch): string {
  return watch.minDelay == null
    ? `${watch.timeFrom}–${watch.timeTo} · jen zrušení`
    : `${watch.timeFrom}–${watch.timeTo} · min. zpoždění ${watch.minDelay} min`;
}

watch(webhook, () => {
  persistForm();
  scheduleListRefresh();
});

onMounted(() => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const data = JSON.parse(saved) as { webhook?: string };
      if (typeof data.webhook === "string") webhook.value = data.webhook;
    } catch {
      /* ignore */
    }
  }
  void loadStops();
  void refreshWatchList();
});
</script>

<template>
  <main
    class="mx-auto mt-8 mb-12 w-[min(40rem,calc(100%-2rem))] rounded-2xl border border-line bg-card p-6 shadow-[0_10px_30px_rgb(28_25_20_/_6%)] max-md:mt-4 max-md:p-[1.1rem]"
  >
    <h1 class="m-0 mb-[0.35rem] text-[1.6rem] tracking-[-0.02em]">
      Vlakové oznámení
    </h1>
    <p class="leading-snug text-muted">
      Nastavení sledování zpoždění IDS JMK a push do MacroDroidu.
    </p>

    <form class="mt-5 grid gap-[0.9rem]" @submit.prevent>
      <div class="grid grid-cols-2 gap-[0.9rem] max-md:grid-cols-1">
        <label class="grid gap-[0.35rem] text-[0.92rem] font-semibold">
          Od
          <StopCombo
            id="from"
            v-model="from"
            :items="stopItems"
            required
            placeholder="Začni psát název zastávky"
          />
        </label>
        <label class="grid gap-[0.35rem] text-[0.92rem] font-semibold">
          Do
          <StopCombo
            id="to"
            v-model="to"
            :items="stopItems"
            required
            placeholder="Začni psát název zastávky"
          />
        </label>
      </div>
      <p class="m-0 leading-snug text-muted">{{ stopsStatus }}</p>

      <div class="grid grid-cols-2 gap-[0.9rem] max-md:grid-cols-1">
        <label class="grid gap-[0.35rem] text-[0.92rem] font-semibold">
          Čas od
          <input v-model="timeFrom" class="field" type="time" required />
        </label>
        <label class="grid gap-[0.35rem] text-[0.92rem] font-semibold">
          Čas do
          <input v-model="timeTo" class="field" type="time" required />
        </label>
      </div>

      <label class="grid gap-[0.35rem] text-[0.92rem] font-semibold">
        MacroDroid webhook URL
        <input
          v-model="webhook"
          class="field"
          type="url"
          required
          placeholder="https://trigger.macrodroid.com/.../trains"
        />
      </label>

      <label class="grid gap-[0.35rem] text-[0.92rem] font-semibold">
        Min. zpoždění (min)
        <input
          v-model="minDelay"
          class="field"
          type="number"
          min="0"
          placeholder="prázdné = jen zrušení"
        />
      </label>

      <div class="mt-1 flex flex-wrap gap-[0.55rem]">
        <button type="button" class="btn" @click="onStatus">Stav</button>
        <button type="button" class="btn btn-primary" @click="onRegister">
          Uložit
        </button>
        <button v-if="editing" type="button" class="btn" @click="onCancel">
          Zrušit
        </button>
        <button type="button" class="btn" @click="onTest">Test push</button>
        <button type="button" class="btn btn-danger" @click="onDelete">
          Smazat
        </button>
        <button type="button" class="btn" @click="refreshWatchList">
          Obnovit seznam
        </button>
      </div>
    </form>

    <section
      class="mt-6 border-t border-line pt-5"
      aria-labelledby="watchListHeading"
    >
      <div>
        <h2
          id="watchListHeading"
          class="m-0 mb-1 text-[1.1rem] tracking-[-0.01em]"
        >
          Sledování pro tento webhook
        </h2>
        <p class="mb-[0.85rem] leading-snug text-muted">
          {{ watchListStatus }}
        </p>
      </div>
      <ul class="m-0 grid list-none gap-[0.65rem] p-0">
        <li
          v-for="watch in watches"
          :key="watch.id"
          class="grid gap-[0.55rem] rounded-[0.7rem] border border-line bg-white px-[0.85rem] py-3"
          :class="
            watch.id === editingId
              ? 'border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]'
              : ''
          "
        >
          <div class="grid gap-0.5">
            <div class="font-bold tracking-[-0.01em]">
              {{ watch.from }} → {{ watch.to }}
            </div>
            <div class="text-[0.9rem] text-muted">{{ watchMeta(watch) }}</div>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button type="button" class="btn btn-sm" @click="fillForm(watch)">
              Upravit
            </button>
            <button
              type="button"
              class="btn btn-sm"
              @click="onWatchStatus(watch)"
            >
              Stav
            </button>
            <button
              type="button"
              class="btn btn-sm"
              @click="onWatchTest(watch)"
            >
              Test
            </button>
            <button
              type="button"
              class="btn btn-sm btn-danger"
              @click="deleteWatch(watch)"
            >
              Smazat
            </button>
          </div>
        </li>
      </ul>
    </section>

    <p class="mt-4 leading-snug text-muted">
      V MacroDroidu ulož tělo do proměnné
      <code class="text-[0.92em] text-ink">message</code>
      a parametry webhooku do slovníku
      <code class="text-[0.92em] text-ink">params</code>. V oznámení nastav text
      oznámení
      <code class="text-[0.92em] text-ink">{lv=params[message]}</code>.
    </p>

    <pre
      class="mt-5 mb-0 overflow-auto rounded-xl bg-ink p-[0.9rem_1rem] text-[0.82rem] leading-snug break-words whitespace-pre-wrap text-[#f4efe6]"
      aria-live="polite"
    >{{ out }}</pre>
  </main>
</template>
