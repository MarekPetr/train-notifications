/**
 * Accessible searchable combobox for stop names (mobile-friendly).
 * @param {HTMLInputElement} input
 * @param {{ id?: string }} [options]
 */
function createStopCombo(input, options = {}) {
  const listId = options.id || `${input.id || "combo"}-list`;
  const maxRender = options.maxRender ?? 80;
  /** @type {string[]} */
  let items = [];
  /** @type {string[]} */
  let filtered = [];
  let activeIndex = -1;
  let open = false;
  let blurTimer = 0;

  const wrap = document.createElement("div");
  wrap.className = "combo";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const list = document.createElement("ul");
  list.id = listId;
  list.className = "combo-list";
  list.hidden = true;
  list.setAttribute("role", "listbox");
  wrap.appendChild(list);

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", listId);
  input.setAttribute("autocomplete", "off");
  input.removeAttribute("list");

  function normalize(s) {
    return String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  }

  function filterItems(query) {
    const q = query.trim();
    if (!q) return items.slice(0, maxRender);
    const nq = normalize(q);
    const out = [];
    for (const name of items) {
      if (normalize(name).includes(nq)) {
        out.push(name);
        if (out.length >= maxRender) break;
      }
    }
    return out;
  }

  function setActive(index) {
    const opts = list.querySelectorAll(".combo-option");
    activeIndex = index;
    opts.forEach((el, i) => {
      const on = i === index;
      el.classList.toggle("is-active", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
      if (on) {
        input.setAttribute("aria-activedescendant", el.id);
        el.scrollIntoView({ block: "nearest" });
      }
    });
    if (index < 0) input.removeAttribute("aria-activedescendant");
  }

  function close() {
    if (!open) return;
    open = false;
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    activeIndex = -1;
  }

  function select(name) {
    input.value = name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    close();
  }

  function render() {
    list.replaceChildren();
    if (!filtered.length) {
      close();
      return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach((name, i) => {
      const li = document.createElement("li");
      li.id = `${listId}-opt-${i}`;
      li.className = "combo-option";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.textContent = name;
      li.addEventListener("mousedown", (event) => {
        event.preventDefault();
        select(name);
      });
      frag.appendChild(li);
    });
    list.appendChild(frag);
    open = true;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    setActive(filtered.length ? 0 : -1);
  }

  function openFiltered() {
    filtered = filterItems(input.value);
    if (!filtered.length) {
      close();
      return;
    }
    render();
  }

  input.addEventListener("focus", () => {
    window.clearTimeout(blurTimer);
    openFiltered();
  });

  input.addEventListener("input", () => {
    openFiltered();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        close();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openFiltered();
        return;
      }
      const next =
        activeIndex < filtered.length - 1 ? activeIndex + 1 : 0;
      setActive(next);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openFiltered();
        return;
      }
      const prev =
        activeIndex > 0 ? activeIndex - 1 : filtered.length - 1;
      setActive(prev);
      return;
    }

    if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      select(filtered[activeIndex]);
    }
  });

  input.addEventListener("blur", () => {
    blurTimer = window.setTimeout(() => close(), 120);
  });

  return {
    setItems(next) {
      items = Array.isArray(next) ? next.slice() : [];
      if (document.activeElement === input) openFiltered();
    },
    getValue() {
      return input.value;
    },
    setValue(val) {
      input.value = val ?? "";
    },
  };
}

window.createStopCombo = createStopCombo;
