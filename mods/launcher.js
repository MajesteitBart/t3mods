// Home and new windows.
//
// Home is a full-window view with live threads side by side. Each pane is the
// real thread (composer included) in an iframe, so you can follow and answer
// several threads at once. Panes minimize to a dock at the bottom, maximize
// to fill Home, pop out to their own window, or open in the main window.
//
// Open Home from the house button in the sidebar footer or Ctrl+Alt+H
// (Cmd+Alt+H on a Mac). The window button next to a thread's title opens it in
// a new window or adds it to Home; "Add thread" in Home does the latter too.
// The pane list lives in this browser's localStorage (t3mods:home).
//
// In a browser, a new window is a real popup window. The desktop app does not
// let its pages open windows, so there the thread opens in a floating window
// inside T3 that you can drag by its title bar and resize from its corner.
//
// Every pane and window runs its own copy of the app. Home only loads panes
// while it is open: closing Home unloads them, and minimized panes load on
// restore.
const isHomeShortcut = (event) => {
  const mod = navigator.platform.startsWith("Mac") ? event.metaKey : event.ctrlKey;
  return mod && event.altKey && !event.shiftKey && event.code === "KeyH";
};

if (T3Mods.surface === "pane") {
  // Keys typed in a pane never reach the top window; pass the shortcut up.
  window.addEventListener(
    "keydown",
    (event) => {
      if (!isHomeShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      window.parent.T3Mods?.home?.toggle();
    },
    true,
  );
} else if (T3Mods.surface === "main") {
  const HOME = '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
  const GRID = '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>';
  const WINDOWS = '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>';
  const POP_OUT = '<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/>';
  const OPEN_IN_MAIN = '<path d="m10 17 5-5-5-5"/><path d="M15 12H3"/><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>';
  const MINUS = '<path d="M5 12h14"/>';
  const MAXIMIZE = '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>';
  const RESTORE = '<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>';
  const CLOSE = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>';
  const PLUS = '<path d="M5 12h14"/><path d="M12 5v14"/>';

  const store = T3Mods.store("home", { panes: [] }); // pane: { key, environmentId, threadId, title, minimized }
  let overlay = null; // { root, grid, dock, empty, sections: Map<key, section> }
  let maximized = null; // pane key, while Home is open

  T3Mods.css(
    "launcher",
    `
.t3mods-home {
  position: fixed; inset: 0; z-index: 2147482000; display: flex; flex-direction: column;
  background: var(--background); color: var(--foreground);
}
.t3mods-home [hidden] { display: none !important; }
.t3mods-home-bar {
  display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;
  height: var(--workspace-topbar-height, 52px);
  padding: 0 calc(var(--workspace-native-controls-inset, 0px) + 0.75rem) 0 1rem;
  border-bottom: 1px solid var(--border); -webkit-app-region: drag;
}
.t3mods-home-bar button { -webkit-app-region: no-drag; }
.t3mods-home-title { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.875rem; font-weight: 500; }
.t3mods-home-spacer { flex: 1; }
.t3mods-text-button {
  display: inline-flex; align-items: center; gap: 0.375rem; height: 1.75rem; padding: 0 0.625rem;
  border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px); background: transparent;
  color: var(--foreground); font: inherit; font-size: 0.8125rem; cursor: pointer;
}
.t3mods-text-button:hover { background: var(--accent); }
.t3mods-home-grid {
  flex: 1; min-height: 0; display: grid; gap: 0.5rem; padding: 0.5rem;
  grid-template-columns: repeat(var(--cols, 1), minmax(0, 1fr)); grid-auto-rows: minmax(0, 1fr);
}
.t3mods-pane, .t3mods-float {
  display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden;
  border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px); background: var(--background);
}
.t3mods-pane-bar {
  display: flex; align-items: center; gap: 0.375rem; flex-shrink: 0; height: 2rem; padding: 0 0.25rem 0 0.625rem;
  border-bottom: 1px solid var(--border); font-size: 0.8125rem; user-select: none;
}
.t3mods-pane-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.t3mods-pane-bar .t3mods-labels { margin-left: 0; max-width: 40%; }
.t3mods-pane-controls { display: inline-flex; align-items: center; flex-shrink: 0; }
.t3mods-pane-controls + .t3mods-pane-controls { margin-left: 0.375rem; padding-left: 0.375rem; border-left: 1px solid var(--border); }
.t3mods-pane-frame { flex: 1; min-height: 0; width: 100%; border: 0; background: var(--background); }
.t3mods-home-dock {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.375rem; flex-shrink: 0;
  padding: 0.375rem 0.5rem; border-top: 1px solid var(--border);
}
.t3mods-dock-item {
  display: inline-flex; align-items: center; gap: 0.25rem; max-width: 16rem; height: 1.75rem; padding: 0 0.25rem 0 0.625rem;
  border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px); background: var(--card, var(--background));
  font-size: 0.8125rem;
}
.t3mods-dock-item > button:first-child {
  display: inline-flex; align-items: center; gap: 0.375rem; flex: 1; min-width: 0;
  border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; text-align: left;
}
.t3mods-dock-item > button:first-child > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3mods-status { flex-shrink: 0; width: 0.5rem; height: 0.5rem; border-radius: 999px; }
.t3mods-status[data-status="working"] { background: oklch(0.68 0.13 230); }
.t3mods-status[data-status="input"] { background: oklch(0.75 0.15 75); }
.t3mods-home-empty { flex: 1; display: flex; align-items: center; justify-content: center; padding: 2rem; text-align: center; color: var(--muted-foreground); font-size: 0.875rem; }
.t3mods-picker-list { max-height: 50vh; overflow: auto; margin-top: 0.375rem; }
.t3mods-picker-list .t3mods-menu-item span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3mods-picker-list .t3mods-picker-project { flex-shrink: 0; max-width: 40%; margin-left: auto; color: var(--muted-foreground); font-size: 0.75rem; }
.t3mods-float {
  position: fixed; z-index: 2147481000; width: 560px; height: 680px; min-width: 320px; min-height: 240px;
  max-width: calc(100vw - 16px); max-height: calc(100vh - 16px);
  resize: both; box-shadow: 0 18px 50px -12px rgb(0 0 0 / 0.45);
}
.t3mods-float .t3mods-pane-bar { cursor: grab; background: var(--card, var(--background)); }
.t3mods-dragging .t3mods-float .t3mods-pane-bar { cursor: grabbing; }
.t3mods-dragging iframe { pointer-events: none; }
.t3mods-sidebar-home svg { flex-shrink: 0; }
`,
  );

  const panes = () => store.get().panes;
  const findPane = (key) => panes().find((pane) => pane.key === key);
  const updatePane = (key, patch) =>
    store.update((state) => ({ ...state, panes: state.panes.map((p) => (p.key === key ? { ...p, ...patch } : p)) }));

  const addPane = ({ environmentId, threadId, title }) => {
    const key = T3Mods.threadKey(environmentId, threadId);
    if (findPane(key)) return updatePane(key, { minimized: false });
    store.update((state) => ({ ...state, panes: [...state.panes, { key, environmentId, threadId, title, minimized: false }] }));
  };
  const removePane = (key) => store.update((state) => ({ ...state, panes: state.panes.filter((p) => p.key !== key) }));

  const iconButton = (label, icon, onClick) => {
    const button = T3Mods.h("button", { type: "button", class: "t3mods-icon-button", title: label, "aria-label": label, onclick: onClick });
    button.append(T3Mods.icon(icon));
    return button;
  };

  const threadLike = (pane) => {
    const known = T3Mods.knownThread(pane.key);
    return known ?? { environmentId: pane.environmentId, id: pane.threadId, title: pane.title };
  };

  // working: a run is in progress. input: the thread waits on an answer or an
  // approval. Read from the sidebar's summary, so a thread whose row is not
  // rendered keeps its last known state.
  const statusOf = (key) => {
    const thread = T3Mods.knownThread(key);
    if (!thread) return null;
    if (thread.hasPendingUserInput || thread.hasPendingApprovals) return "input";
    return ["preparing", "queued", "starting", "running"].includes(thread.runtime?.status) ? "working" : null;
  };
  const STATUS_LABEL = { working: "Working", input: "Waiting for you" };

  const embedFrame = (pane) =>
    T3Mods.h("iframe", {
      "data-t3mods-embed": true,
      class: "t3mods-pane-frame",
      title: pane.title,
      allow: "clipboard-read; clipboard-write; microphone",
      src: T3Mods.threadPath(pane.environmentId, pane.threadId),
    });

  const openInMain = (pane) => {
    closeHome();
    T3Mods.navigate(T3Mods.threadPath(pane.environmentId, pane.threadId));
  };

  // --- New windows

  const isDesktop = () => window.desktopBridge !== undefined;
  const popupWindows = new Map(); // key -> Window
  const floats = new Map(); // key -> section
  let floatZ = 2147481000;

  const raise = (el) => {
    el.style.zIndex = String(++floatZ);
  };

  // Drag a floating window by its title bar, keeping the bar on screen.
  const makeDraggable = (el, handle) => {
    handle.addEventListener("pointerdown", (event) => {
      raise(el);
      if (event.button !== 0 || event.target.closest("button")) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      const start = { x: event.clientX, y: event.clientY, left: el.offsetLeft, top: el.offsetTop };
      document.documentElement.classList.add("t3mods-dragging");
      const move = (e) => {
        const left = Math.min(Math.max(start.left + e.clientX - start.x, 8 - el.offsetWidth + 80), window.innerWidth - 80);
        const top = Math.min(Math.max(start.top + e.clientY - start.y, 0), window.innerHeight - 32);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        document.documentElement.classList.remove("t3mods-dragging");
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end, { once: true });
      handle.addEventListener("pointercancel", end, { once: true });
    });
  };

  const closeFloat = (key) => {
    floats.get(key)?.remove();
    floats.delete(key);
  };

  const openFloating = (pane) => {
    // Home covers floating windows; a window opened from it must be visible.
    closeHome();
    const existing = floats.get(pane.key);
    if (existing) return raise(existing);
    const offset = (floats.size % 6) * 28;
    const el = T3Mods.h("section", {
      class: "t3mods-float",
      "data-t3-mod": "launcher-float",
      "data-key": pane.key,
      role: "dialog",
      "aria-label": pane.title,
      style: {
        left: `${Math.max(8, window.innerWidth - 560 - 32 - offset)}px`,
        top: `${64 + offset}px`,
        height: `${Math.min(680, window.innerHeight - 96)}px`,
      },
    });
    const bar = T3Mods.h("div", { class: "t3mods-pane-bar" });
    el.append(bar, embedFrame(pane));
    // Runs on every scan; rebuilding unchanged controls would itself trigger
    // the next scan.
    el.t3modsRender = () => {
      const thread = threadLike(pane);
      if (el.t3modsSig === thread.title) return;
      el.t3modsSig = thread.title;
      el.setAttribute("aria-label", thread.title);
      bar.replaceChildren(
        T3Mods.h("span", { class: "t3mods-pane-title", title: thread.title }, thread.title),
        T3Mods.h(
          "span",
          { class: "t3mods-pane-controls" },
          iconButton("Open in the main window", OPEN_IN_MAIN, () => {
            closeFloat(pane.key);
            T3Mods.navigate(T3Mods.threadPath(pane.environmentId, pane.threadId));
          }),
          iconButton("Move to Home", GRID, () => {
            closeFloat(pane.key);
            addPane(pane);
          }),
        ),
        T3Mods.h("span", { class: "t3mods-pane-controls" }, iconButton("Close", CLOSE, () => closeFloat(pane.key))),
      );
    };
    el.t3modsRender();
    makeDraggable(el, bar);
    // A click inside the thread focuses its iframe; bring that window forward.
    el.querySelector("iframe").addEventListener("focus", () => raise(el));
    floats.set(pane.key, el);
    raise(el);
    document.body.append(el);
  };

  // A real window in browsers; a floating window in the desktop app, or when
  // the browser blocks the popup.
  const popOut = (pane) => {
    if (!isDesktop()) {
      const path = T3Mods.threadPath(pane.environmentId, pane.threadId);
      const open = popupWindows.get(pane.key);
      if (open && !open.closed) {
        // The window may have moved on to another thread since.
        try {
          if (open.location.pathname !== path) {
            if (open.T3Mods) open.T3Mods.navigate(path);
            else open.location.assign(path);
          }
        } catch {}
        return open.focus();
      }
      const width = Math.min(820, screen.availWidth - 40);
      const height = Math.min(960, screen.availHeight - 40);
      const popup = window.open(path, `t3mods:${pane.key}`, `popup,width=${width},height=${height}`);
      if (popup) {
        popupWindows.set(pane.key, popup);
        return;
      }
    }
    openFloating(pane);
  };
  const popOutLabel = () => (isDesktop() ? "Open in floating window" : "Open in new window");

  // --- Home overlay

  const renderBar = (section, pane) => {
    const thread = threadLike(pane);
    const labels = T3Mods.labels?.labelsFor(thread) ?? [];
    const active = T3Mods.keepActive?.isMarked(pane.key) ?? false;
    const isMax = maximized === pane.key;
    const sig = `${thread.title}|${labels.map((l) => `${l.id}:${l.color}`).join(",")}|${active}|${isMax}|${isDesktop()}`;
    if (section.t3modsSig === sig) return;
    section.t3modsSig = sig;
    const bar = section.querySelector(".t3mods-pane-bar");
    // Navigation actions first, then the window controls in the order every
    // desktop OS uses: minimize, maximize, close.
    bar.replaceChildren(
      ...(active ? [T3Mods.keepActive.chip(pane.key, true)] : []),
      T3Mods.h("span", { class: "t3mods-pane-title", title: thread.title }, thread.title),
      ...(labels.length > 0 ? [T3Mods.h("span", { class: "t3mods-labels" }, T3Mods.labels.chips(labels, 2))] : []),
      T3Mods.h(
        "span",
        { class: "t3mods-pane-controls" },
        iconButton("Open in the main window", OPEN_IN_MAIN, () => openInMain(pane)),
        iconButton(isDesktop() ? "Move to a floating window" : "Move to a new window", POP_OUT, () => {
          removePane(pane.key);
          popOut(pane);
        }),
      ),
      T3Mods.h(
        "span",
        { class: "t3mods-pane-controls" },
        iconButton("Minimize", MINUS, () => updatePane(pane.key, { minimized: true })),
        iconButton(isMax ? "Restore" : "Maximize", isMax ? RESTORE : MAXIMIZE, () => toggleMaximize(pane.key)),
        iconButton("Remove from Home", CLOSE, () => removePane(pane.key)),
      ),
    );
    section.querySelector("iframe").title = thread.title;
  };

  const toggleMaximize = (key) => {
    maximized = maximized === key ? null : key;
    render();
  };

  const createSection = (pane) => {
    const bar = T3Mods.h("div", {
      class: "t3mods-pane-bar",
      title: "Double-click to maximize or restore",
      ondblclick: (event) => {
        if (!event.target.closest("button")) toggleMaximize(pane.key);
      },
    });
    return T3Mods.h("section", { class: "t3mods-pane", "data-key": pane.key }, bar, embedFrame(pane));
  };

  const renderDock = () => {
    if (!overlay) return;
    const minimized = panes().filter((pane) => pane.minimized);
    const sig = minimized.map((pane) => `${pane.key}:${threadLike(pane).title}:${statusOf(pane.key)}`).join("|");
    if (overlay.dock.t3modsSig === sig) return;
    overlay.dock.t3modsSig = sig;
    overlay.dock.replaceChildren(
      ...minimized.map((pane) => {
        const title = threadLike(pane).title;
        const status = statusOf(pane.key);
        const restore = T3Mods.h(
          "button",
          {
            type: "button",
            title: status ? `${STATUS_LABEL[status]}. Restore ${title}` : `Restore ${title}`,
            onclick: () => updatePane(pane.key, { minimized: false }),
          },
          status ? T3Mods.h("span", { class: "t3mods-status", "data-status": status, "aria-label": STATUS_LABEL[status] }) : null,
          T3Mods.h("span", {}, title),
        );
        return T3Mods.h("span", { class: "t3mods-dock-item" }, restore, iconButton("Remove from Home", CLOSE, () => removePane(pane.key)));
      }),
    );
    overlay.dock.hidden = minimized.length === 0;
  };

  // Sync the overlay with the pane list. Sections are never moved in the DOM,
  // because moving an iframe reloads it; style.order sets their position.
  function render() {
    if (!overlay) return;
    const list = panes();
    const keys = new Set(list.map((pane) => pane.key));
    for (const [key, section] of overlay.sections) {
      if (keys.has(key)) continue;
      section.remove();
      overlay.sections.delete(key);
    }
    if (maximized && (!keys.has(maximized) || findPane(maximized)?.minimized)) maximized = null;

    const shownSections = [];
    list.forEach((pane, index) => {
      let section = overlay.sections.get(pane.key);
      if (!section && !pane.minimized) {
        section = createSection(pane);
        overlay.sections.set(pane.key, section);
        overlay.grid.append(section);
      }
      if (!section) return;
      const shown = !pane.minimized && (maximized === null || maximized === pane.key);
      section.hidden = !shown;
      section.style.order = String(index);
      section.style.gridColumn = "";
      if (shown) shownSections.push(section);
      renderBar(section, pane);
    });

    const visible = shownSections.length;
    const cols = visible <= 1 ? 1 : visible <= 4 ? 2 : 3;
    overlay.grid.style.setProperty("--cols", String(cols));
    // A row with a gap looks unfinished; the last pane takes the rest of it.
    const remainder = visible % cols;
    if (remainder !== 0) shownSections.at(-1).style.gridColumn = `span ${cols - remainder + 1}`;
    overlay.grid.hidden = visible === 0;
    renderDock();
    overlay.empty.hidden = visible > 0;
    overlay.empty.textContent =
      list.length === 0
        ? "Nothing on Home yet. Add a thread here, or use the window button next to a thread's title."
        : "Every pane is minimized. Restore one from the dock below.";
  }

  const openPicker = (anchor) => {
    T3Mods.popover(anchor, (panel, close) => {
      const input = T3Mods.h("input", { class: "t3mods-input", placeholder: "Search threads", "aria-label": "Search threads" });
      const results = T3Mods.h("div", { class: "t3mods-picker-list", role: "listbox" });
      const update = () => {
        const query = input.value.trim().toLowerCase();
        const onHome = new Set(panes().map((pane) => pane.key));
        const rows = T3Mods.sidebarRows().filter(
          ({ key, thread }) => !onHome.has(key) && (!query || thread.title.toLowerCase().includes(query)),
        );
        results.replaceChildren(
          ...rows.slice(0, 60).map(({ thread, props }) =>
            T3Mods.h(
              "button",
              {
                type: "button",
                class: "t3mods-menu-item",
                role: "option",
                onclick: () => {
                  addPane({ environmentId: thread.environmentId, threadId: thread.id, title: thread.title });
                  close();
                },
              },
              T3Mods.h("span", {}, thread.title),
              props.projectDisplayName ? T3Mods.h("span", { class: "t3mods-picker-project" }, props.projectDisplayName) : null,
            ),
          ),
        );
        if (rows.length === 0) {
          results.append(T3Mods.h("div", { class: "t3mods-muted" }, query ? "No thread matches." : "Every sidebar thread is on Home."));
        }
      };
      input.addEventListener("input", update);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") results.querySelector("button")?.click();
      });
      panel.append(T3Mods.h("h3", {}, "Add to Home"), input, results);
      update();
      queueMicrotask(() => input.focus());
    });
  };

  function openHome() {
    if (overlay) return;
    const root = T3Mods.h("div", { class: "t3mods-home", role: "region", "aria-label": "Home", "data-t3-mod": "launcher" });
    const add = T3Mods.h("button", { type: "button", class: "t3mods-text-button", onclick: () => openPicker(add) }, T3Mods.icon(PLUS), "Add thread");
    const bar = T3Mods.h(
      "div",
      { class: "t3mods-home-bar" },
      T3Mods.h("span", { class: "t3mods-home-title" }, T3Mods.icon(HOME, "size-4"), "Home"),
      add,
      T3Mods.h("span", { class: "t3mods-home-spacer" }),
      T3Mods.h("button", { type: "button", class: "t3mods-text-button", title: "Close Home (Ctrl+Alt+H)", onclick: closeHome }, T3Mods.icon(CLOSE), "Close"),
    );
    const grid = T3Mods.h("div", { class: "t3mods-home-grid" });
    const empty = T3Mods.h("div", { class: "t3mods-home-empty" });
    const dock = T3Mods.h("div", { class: "t3mods-home-dock", "aria-label": "Minimized threads" });
    root.append(bar, grid, empty, dock);
    overlay = { root, grid, dock, empty, sections: new Map() };
    document.body.append(root);
    render();
  }

  function closeHome() {
    if (!overlay) return;
    overlay.root.remove();
    overlay = null;
    maximized = null;
    T3Mods.rescan();
  }

  const toggleHome = () => (overlay ? closeHome() : openHome());

  store.subscribe(() => {
    render();
    T3Mods.rescan();
  });

  // Pane and window titles, labels, marks and dock states follow the sidebar.
  T3Mods.onScan("launcher-panes", () => {
    for (const el of floats.values()) el.t3modsRender?.();
    if (!overlay) return;
    for (const pane of panes()) {
      const section = overlay.sections.get(pane.key);
      if (section) renderBar(section, pane);
    }
    renderDock();
  });

  // Panes forward the shortcut here (see the pane branch above).
  T3Mods.home = { toggle: toggleHome, popOut };

  // Ctrl+Alt+H, or Cmd+Alt+H on a Mac. Escape closes Home while focus is
  // outside the panes (Escape inside a pane belongs to that pane).
  window.addEventListener(
    "keydown",
    (event) => {
      if (isHomeShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        toggleHome();
      } else if (event.key === "Escape" && overlay && !document.querySelector("[data-t3mods-popover]")) {
        event.stopPropagation();
        closeHome();
      }
    },
    true,
  );

  // Home is a place in the app, not an action on one thread, so it sits with
  // T3's other places (Settings, Pull Requests, Usage) in the sidebar footer.
  T3Mods.onScan("launcher-sidebar", () => {
    const settings = document.querySelector('[data-slot="sidebar"] button[aria-label="Settings"]');
    const item = settings?.closest("li");
    const list = item?.parentElement;
    if (!list || list.querySelector(':scope > [data-t3-mod="launcher-sidebar"]')) return;
    const button = T3Mods.h("button", {
      type: "button",
      class: `${settings.className} t3mods-sidebar-home`,
      "aria-label": "Home",
      title: "Home (Ctrl+Alt+H)",
      onclick: openHome,
    });
    button.append(T3Mods.icon(HOME, settings.querySelector("svg")?.getAttribute("class") ?? "size-4"));
    list.append(T3Mods.h("li", { class: item.className, "data-t3-mod": "launcher-sidebar" }, button));
  });

  // One menu next to the thread title for every "show this thread elsewhere"
  // action, instead of a row of look-alike icons.
  T3Mods.onScan("launcher-header", () => {
    const current = T3Mods.currentThread();
    const slot = current && T3Mods.headerSlot();
    if (!slot) return;
    let button = slot.querySelector(':scope > [data-t3-mod="launcher-menu"]');
    if (!button) {
      button = T3Mods.headerButton({
        name: "launcher-menu",
        label: "New window or Home",
        icon: WINDOWS,
        order: 30,
        onClick: (_event, el) => {
          const now = T3Mods.currentThread();
          if (!now) return;
          const pane = { environmentId: now.environmentId, threadId: now.threadId, title: now.title, key: now.key };
          const onHome = findPane(now.key) !== undefined;
          el.setAttribute("aria-expanded", "true");
          T3Mods.menu(
            el,
            [
              { icon: POP_OUT, label: popOutLabel(), onSelect: () => popOut(pane) },
              {
                icon: GRID,
                label: onHome ? "Remove from Home" : "Add to Home",
                onSelect: () => (onHome ? removePane(now.key) : addPane(pane)),
              },
              "-",
              { icon: HOME, label: "Show Home", hint: "Ctrl+Alt+H", onSelect: openHome },
            ],
            { align: "end", onClose: () => el.setAttribute("aria-expanded", "false") },
          );
        },
      });
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      slot.append(button);
    }
    button.hidden = !current.isServerThread;
  });
}
