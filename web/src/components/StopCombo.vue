<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    items: string[];
    id?: string;
    placeholder?: string;
    required?: boolean;
    maxRender?: number;
  }>(),
  {
    id: "combo",
    placeholder: "",
    required: false,
    maxRender: 80,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const inputEl = ref<HTMLInputElement | null>(null);
const open = ref(false);
const activeIndex = ref(-1);
const listId = computed(() => `${props.id}-list`);

function normalize(s: string): string {
  return String(s)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

const filtered = computed(() => {
  const q = props.modelValue.trim();
  if (!q) return props.items.slice(0, props.maxRender);
  const nq = normalize(q);
  const out: string[] = [];
  for (const name of props.items) {
    if (normalize(name).includes(nq)) {
      out.push(name);
      if (out.length >= props.maxRender) break;
    }
  }
  return out;
});

function setActive(index: number) {
  activeIndex.value = index;
  void nextTick(() => {
    const el = document.getElementById(`${listId.value}-opt-${index}`);
    el?.scrollIntoView({ block: "nearest" });
  });
}

function close() {
  open.value = false;
  activeIndex.value = -1;
}

function select(name: string) {
  emit("update:modelValue", name);
  close();
}

function openFiltered() {
  if (!filtered.value.length) {
    close();
    return;
  }
  open.value = true;
  setActive(0);
}

function onInput(event: Event) {
  emit("update:modelValue", (event.target as HTMLInputElement).value);
  openFiltered();
}

function onFocus() {
  openFiltered();
}

function onBlur() {
  window.setTimeout(() => close(), 120);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if (open.value) {
      event.preventDefault();
      close();
    }
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!open.value) {
      openFiltered();
      return;
    }
    const next =
      activeIndex.value < filtered.value.length - 1
        ? activeIndex.value + 1
        : 0;
    setActive(next);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!open.value) {
      openFiltered();
      return;
    }
    const prev =
      activeIndex.value > 0
        ? activeIndex.value - 1
        : filtered.value.length - 1;
    setActive(prev);
    return;
  }

  if (event.key === "Enter" && open.value && activeIndex.value >= 0) {
    event.preventDefault();
    select(filtered.value[activeIndex.value]!);
  }
}

watch(
  () => props.modelValue,
  () => {
    if (document.activeElement === inputEl.value) openFiltered();
  },
);
</script>

<template>
  <div class="relative">
    <input
      :id="id"
      ref="inputEl"
      class="field"
      :value="modelValue"
      type="text"
      role="combobox"
      autocomplete="off"
      aria-autocomplete="list"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="listId"
      :aria-activedescendant="
        open && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined
      "
      :placeholder="placeholder"
      :required="required"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <ul
      v-show="open && filtered.length"
      :id="listId"
      class="absolute top-[calc(100%+0.25rem)] right-0 left-0 z-20 m-0 max-h-[min(16rem,50vh)] list-none overflow-auto rounded-[0.55rem] border border-line bg-white p-[0.25rem_0] shadow-[0_8px_24px_rgb(28_25_20_/_12%)] [-webkit-overflow-scrolling:touch]"
      role="listbox"
    >
      <li
        v-for="(name, i) in filtered"
        :id="`${listId}-opt-${i}`"
        :key="name"
        class="flex min-h-11 cursor-pointer items-center px-[0.85rem] py-[0.7rem] font-medium"
        :class="i === activeIndex ? 'bg-option-hover text-ink' : ''"
        role="option"
        :aria-selected="i === activeIndex ? 'true' : 'false'"
        @mousedown.prevent="select(name)"
        @mouseenter="setActive(i)"
      >
        {{ name }}
      </li>
    </ul>
  </div>
</template>
