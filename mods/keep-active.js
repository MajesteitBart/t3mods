// Mark a thread active by hand, for work T3 can't see, such as subagents a
// provider runs in the background after the turn ends. T3 already shows
// "Waiting" for background work it tracks; this covers the rest.
//
// The activity button next to the thread title sets the mark; the "Subagents"
// chip that replaces it clears it again. Marking un-settles or wakes the thread
// so it sits in the active list, and its sidebar row gets the same chip.
// Settling the thread later clears the mark. Marks live in this browser's
// localStorage (t3mods:active).
const ACTIVITY = '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>';

const store = T3Mods.store("active", {}); // thread key -> { markedAt }

T3Mods.css(
  "keep-active",
  `
.t3mods-active {
  display: inline-flex; align-items: center; gap: 0.25rem; flex-shrink: 0; height: 1rem; padding: 0 0.375rem;
  border-radius: 999px; font-size: 0.625rem; font-weight: 500; line-height: 1; white-space: nowrap;
  color: oklch(0.5 0.13 230); background: oklch(0.65 0.13 230 / 0.15);
}
.dark .t3mods-active { color: oklch(0.82 0.1 230); background: oklch(0.7 0.12 230 / 0.18); }
.t3mods-active svg { width: 0.625rem; height: 0.625rem; }
.t3mods-active[data-compact] { padding: 0 0.25rem; }
li[data-thread-item] .t3mods-active { margin-right: 0.375rem; }
li[data-thread-item] span.truncate + .t3mods-active { margin: 0 0 0 0.25rem; }
`,
);

const isMarked = (key) => store.get()[key] !== undefined;

const since = (key) => {
  const at = store.get()[key]?.markedAt;
  return at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
};

const chip = (key, compact = false) => {
  const el = T3Mods.h(
    "span",
    { class: "t3mods-active", title: `Marked active since ${since(key)}`, "data-compact": compact || undefined },
    T3Mods.icon(ACTIVITY),
    compact ? null : "Subagents",
  );
  return el;
};

// Bring the thread back to the active list through the row's own handlers.
// Only possible while the sidebar has the row rendered.
const reactivate = (key) => {
  const row = T3Mods.sidebarRows().find((r) => r.key === key);
  if (!row) return;
  const ref = { environmentId: row.thread.environmentId, threadId: row.thread.id };
  const snoozed = row.thread.snoozedUntil && Date.parse(row.thread.snoozedUntil) > Date.now();
  if (snoozed && typeof row.props.onUnsnooze === "function") row.props.onUnsnooze(ref);
  else if (row.thread.settledOverride === "settled" && typeof row.props.onUnsettle === "function") row.props.onUnsettle(ref);
};

const toggle = (key) => {
  if (isMarked(key)) {
    store.update((state) => {
      const next = { ...state };
      delete next[key];
      return next;
    });
    return;
  }
  store.update((state) => ({ ...state, [key]: { markedAt: new Date().toISOString() } }));
  reactivate(key);
};

T3Mods.keepActive = { isMarked, toggle, chip };

T3Mods.onScan("keep-active-sidebar", () => {
  const marks = store.get();
  for (const { item, row, thread, props, key } of T3Mods.sidebarRows()) {
    if (!row) continue;
    const mark = marks[key];
    // Settling after the mark was set means the work is done.
    if (mark && thread.settledAt && thread.settledAt > mark.markedAt) {
      toggle(key);
      continue;
    }
    const existing = row.querySelector(':scope [data-t3-mod="keep-active"]');
    if (!mark) {
      existing?.remove();
      continue;
    }
    const compact = props.variant === "slim";
    if (existing?.isConnected && existing.hasAttribute("data-compact") === compact) continue;
    existing?.remove();
    const el = chip(key, compact);
    el.dataset.t3Mod = "keep-active";
    // Cards: next to the project name, so the title line keeps its room.
    // Slim rows: before the title.
    const project =
      !compact && props.projectDisplayName
        ? [...row.querySelectorAll("span.truncate")].find((span) => span.textContent === props.projectDisplayName)
        : null;
    if (project) {
      project.after(el);
      continue;
    }
    const title = [...row.querySelectorAll("span[aria-hidden]")].find((span) => span.textContent === thread.title);
    if (title) title.before(el);
  }
});

T3Mods.onScan("keep-active-header", () => {
  const current = T3Mods.currentThread();
  const slot = current && T3Mods.headerSlot();
  if (!slot) return;
  const marked = isMarked(current.key);
  // Narrow windows show the chip's icon only, as slim sidebar rows do.
  const compact = window.innerWidth < 900;
  const sig = `${current.key}|${current.isServerThread}|${marked}|${compact}`;
  const existing = slot.querySelector(':scope > [data-t3-mod="keep-active-header"]');
  if (existing?.t3modsSig === sig) return;
  existing?.remove();
  if (!current.isServerThread) return;

  const toggleCurrent = () => {
    const now = T3Mods.currentThread();
    if (now) toggle(now.key);
  };
  // One control that shows its state: the activity icon marks the thread, and
  // once marked the "Subagents" chip itself clears it.
  let control;
  if (marked) {
    const label = `Marked active since ${since(current.key)}. Click to clear.`;
    control = T3Mods.h(
      "button",
      {
        type: "button",
        class: "t3mods-header-chip-button",
        title: label,
        "aria-label": label,
        "aria-pressed": "true",
        style: { order: "20" },
        onclick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleCurrent();
        },
      },
      chip(current.key, compact),
    );
  } else {
    control = T3Mods.headerButton({
      name: "keep-active-header",
      label: "Mark active (subagents running)",
      icon: ACTIVITY,
      order: 20,
      onClick: toggleCurrent,
    });
  }
  control.dataset.t3Mod = "keep-active-header";
  control.t3modsSig = sig;
  slot.append(control);
});
