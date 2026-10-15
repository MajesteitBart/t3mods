// Colored labels on threads: chips after the title in sidebar rows and the chat
// header, and a colored bar on the row's left edge in the first label's color.
//
// Scheduled, Webhook and Subagent are applied automatically. Your own labels
// are edited by clicking the chips in the chat header (or the tag button when
// a thread has none) and kept in this browser's localStorage (t3mods:labels),
// so each device keeps its own.
const TAG = '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>';
const CHECK = '<path d="M20 6 9 17l-5-5"/>';
const TRASH = '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>';

// Hue and chroma in oklch. Chroma 0 is gray.
const COLORS = {
  gray: [0, 0],
  red: [25, 0.17],
  orange: [55, 0.16],
  amber: [80, 0.15],
  green: [150, 0.14],
  teal: [185, 0.12],
  blue: [255, 0.15],
  violet: [295, 0.15],
  pink: [350, 0.15],
};
const COLOR_NAMES = Object.keys(COLORS);

const AUTO = {
  scheduled: { id: "auto:scheduled", name: "Scheduled", color: "amber" },
  webhook: { id: "auto:webhook", name: "Webhook", color: "orange" },
  subagent: { id: "auto:subagent", name: "Subagent", color: "violet" },
};

const store = T3Mods.store("labels", { labels: [], assignments: {} });
// Bumped on every label or scheduled-task change; part of each row's signature.
let version = 0;
store.subscribe(() => version++);

T3Mods.css(
  "thread-labels",
  `
.t3mods-label {
  --h: 255; --c: 0.15;
  display: inline-block; flex-shrink: 0; max-width: 7rem; height: 1rem; padding: 0 0.375rem;
  border-radius: 999px; font-size: 0.625rem; font-weight: 500; line-height: 1rem; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  color: oklch(0.48 var(--c) var(--h)); background: oklch(0.62 var(--c) var(--h) / 0.14);
}
.dark .t3mods-label { color: oklch(0.83 calc(var(--c) * 0.75) var(--h)); background: oklch(0.7 var(--c) var(--h) / 0.17); }
.t3mods-label-dot { --h: 255; --c: 0.15; display: inline-block; flex-shrink: 0; width: 0.5rem; height: 0.5rem; border-radius: 999px; background: oklch(0.66 var(--c) var(--h)); }
/* In sidebar rows the title is flex-1 with a zero basis, so chips would take
   all the room; cap them at half the line and let them truncate. */
.t3mods-labels { display: inline-flex; align-items: center; gap: 0.25rem; flex: 0 1 auto; min-width: 0; max-width: 50%; overflow: hidden; margin-left: 0.375rem; }
.t3mods-labels > .t3mods-label { flex-shrink: 1; min-width: 1.5rem; }
.t3mods-labels > .t3mods-label-more { flex-shrink: 0; min-width: 0; }
.t3mods-label-more { color: var(--muted-foreground) !important; background: color-mix(in srgb, var(--muted-foreground) 14%, transparent) !important; }
.t3mods-header-chip-button > .t3mods-label { flex-shrink: 0; }
[data-t3mods-labelled] { box-shadow: inset 2px 0 0 oklch(0.66 var(--t3mods-c) var(--t3mods-h)); }
.t3mods-label-row { display: flex; align-items: center; gap: 0.25rem; }
.t3mods-label-row .t3mods-menu-item { flex: 1; min-width: 0; }
.t3mods-label-row .t3mods-label-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3mods-auto-labels { flex-wrap: wrap; padding: 0.125rem 0.375rem 0.375rem; }
.t3mods-check { display: inline-flex; width: 0.875rem; flex-shrink: 0; justify-content: center; }
.t3mods-new-label { padding: 0.375rem 0.375rem 0; margin-top: 0.25rem; border-top: 1px solid var(--border); }
.t3mods-swatches { display: flex; flex-wrap: wrap; gap: 0.25rem; padding: 0.375rem; }
.t3mods-swatch { width: 1rem; height: 1rem; border-radius: 999px; border: 2px solid transparent; cursor: pointer; padding: 0; }
.t3mods-swatch[aria-checked="true"] { border-color: var(--foreground); }
`,
);

const paint = (el, colorName) => {
  const [h, c] = COLORS[colorName] ?? COLORS.gray;
  el.style.setProperty("--h", String(h));
  el.style.setProperty("--c", String(c));
  return el;
};

const chip = (label) => paint(T3Mods.h("span", { class: "t3mods-label", title: label.title ?? label.name }, label.name), label.color);
const dot = (label) => paint(T3Mods.h("span", { class: "t3mods-label-dot", title: label.title ?? label.name }), label.color);

// The first max labels as chips, the rest as one "+N" chip that names them.
const chips = (labels, max) => {
  const shown = labels.slice(0, max).map(chip);
  const rest = labels.slice(max);
  if (rest.length > 0) {
    shown.push(
      T3Mods.h("span", { class: "t3mods-label t3mods-label-more", title: rest.map((l) => l.name).join(", ") }, `+${rest.length}`),
    );
  }
  return shown;
};

// --- Scheduled tasks, fetched over the app's socket every five minutes.

// Keys include the environment, so a task never labels another environment's
// thread (copied databases share thread and project ids).
let scheduledByThread = new Map(); // thread key -> task
let scheduledByTitle = new Map(); // `${environmentId}\n${projectId}\n${title}` -> task that launches a fresh thread per run

const refreshScheduled = async () => {
  const replies = await T3Mods.rpcAll("scheduledTasks.list", {});
  if (replies.length === 0) return false;
  const byThread = new Map();
  const byTitle = new Map();
  for (const { environmentId, value } of replies) {
    if (!environmentId) continue;
    for (const task of value?.tasks ?? []) {
      if (task.threadId) byThread.set(T3Mods.threadKey(environmentId, task.threadId), task);
      else byTitle.set(`${environmentId}\n${task.projectId}\n${task.title}`, task);
    }
  }
  scheduledByThread = byThread;
  scheduledByTitle = byTitle;
  version++;
  T3Mods.rescan();
  return true;
};

const scheduleRefresh = (delay) =>
  setTimeout(async () => {
    let ok = false;
    try {
      ok = await refreshScheduled();
    } catch (error) {
      console.warn("[t3-mods] thread-labels: scheduled tasks", error);
    }
    // Sockets open after the app boots; retry soon until one answers.
    scheduleRefresh(ok ? 5 * 60_000 : 10_000);
  }, delay);
scheduleRefresh(3000);

// --- Label resolution

// thread: { environmentId, id, projectId?, title?, lineage? }
const labelsFor = (thread) => {
  const out = [];
  const task =
    scheduledByThread.get(T3Mods.threadKey(thread.environmentId, thread.id)) ??
    scheduledByTitle.get(`${thread.environmentId}\n${thread.projectId}\n${thread.title}`);
  if (task) {
    const auto = task.schedule?.type === "webhook" ? AUTO.webhook : AUTO.scheduled;
    out.push({ ...auto, title: `${auto.name}: ${task.title}` });
  }
  if (thread.lineage?.relationshipToParent === "subagent") out.push(AUTO.subagent);
  const { labels, assignments } = store.get();
  for (const id of assignments[T3Mods.threadKey(thread.environmentId, thread.id)] ?? []) {
    const label = labels.find((l) => l.id === id);
    if (label) out.push(label);
  }
  return out;
};

// Other mods (launcher panes) show the same chips.
T3Mods.labels = { labelsFor, chip, chips, dot };

// --- Sidebar rows

T3Mods.onScan("thread-labels-sidebar", () => {
  for (const { item, row, thread, props } of T3Mods.sidebarRows()) {
    if (!row) continue;
    const labels = labelsFor(thread);
    const sig = `${version}|${thread.id}|${thread.title}|${props.variant}|${labels.map((l) => l.id).join(",")}`;
    const existing = row.querySelector(':scope [data-t3-mod="thread-labels"]');
    if (item.t3modsLabelSig === sig && (labels.length === 0 || existing?.isConnected)) continue;
    item.t3modsLabelSig = sig;
    existing?.remove();

    if (labels.length === 0) {
      row.removeAttribute("data-t3mods-labelled");
      continue;
    }
    const [h, c] = COLORS[labels[0].color] ?? COLORS.gray;
    row.style.setProperty("--t3mods-h", String(h));
    row.style.setProperty("--t3mods-c", String(c));
    row.setAttribute("data-t3mods-labelled", "");

    // The title span carries the thread title as its only text in both row
    // variants; chips go right after it.
    const title = [...row.querySelectorAll("span[aria-hidden]")].find((span) => span.textContent === thread.title);
    if (!title) continue;
    const container = T3Mods.h("span", { class: "t3mods-labels", "data-t3-mod": "thread-labels" });
    // Slim rows are one line; dots keep the title readable there. Cards show
    // the first label and a count, so the title keeps most of the line.
    container.append(...(props.variant === "slim" ? labels.slice(0, 3).map(dot) : chips(labels, 1)));
    title.after(container);
  }
});


// --- Chat header: the chips are the button that opens the editor

const swatchRow = (selected, describe, onPick) =>
  T3Mods.h(
    "div",
    { class: "t3mods-swatches", role: "radiogroup" },
    COLOR_NAMES.map((name) =>
      T3Mods.h("button", {
        type: "button",
        class: "t3mods-swatch",
        role: "radio",
        title: name,
        "aria-label": describe(name),
        "aria-checked": String(name === selected),
        style: { background: `oklch(0.66 ${COLORS[name][1]} ${COLORS[name][0]})` },
        onclick: () => onPick(name),
      }),
    ),
  );

const openEditor = (anchor, current) => {
  T3Mods.popover(anchor, (panel) => {
    let recoloring = null; // id of the label whose colors are showing
    let newColor = null;
    const render = () => {
      panel.replaceChildren();
      const thread = T3Mods.knownThread(current.key) ?? { environmentId: current.environmentId, id: current.threadId, title: current.title };
      const auto = labelsFor(thread).filter((label) => label.id.startsWith("auto:"));
      const { labels, assignments } = store.get();
      const assigned = new Set(assignments[current.key] ?? []);
      newColor ??= COLOR_NAMES[(labels.length + 5) % COLOR_NAMES.length];

      panel.append(T3Mods.h("h3", {}, "Labels"));
      if (auto.length > 0) {
        panel.append(
          T3Mods.h("div", { class: "t3mods-label-row t3mods-auto-labels", title: "Added automatically" }, auto.map(chip)),
        );
      }
      if (labels.length === 0) {
        panel.append(T3Mods.h("div", { class: "t3mods-muted" }, "No labels yet. Type a name below to create one."));
      }
      for (const label of labels) {
        const toggle = T3Mods.h(
          "button",
          {
            type: "button",
            class: "t3mods-menu-item",
            role: "menuitemcheckbox",
            "aria-checked": String(assigned.has(label.id)),
            onclick: () => {
              store.update((state) => {
                const next = new Set(state.assignments[current.key] ?? []);
                if (next.has(label.id)) next.delete(label.id);
                else next.add(label.id);
                const assignmentsNext = { ...state.assignments, [current.key]: [...next] };
                if (next.size === 0) delete assignmentsNext[current.key];
                return { ...state, assignments: assignmentsNext };
              });
              render();
            },
          },
          T3Mods.h("span", { class: "t3mods-check" }, assigned.has(label.id) ? T3Mods.icon(CHECK) : null),
          T3Mods.h("span", { class: "t3mods-label-name" }, label.name),
        );
        const color = T3Mods.h(
          "button",
          {
            type: "button",
            class: "t3mods-icon-button",
            title: `Color of ${label.name}`,
            "aria-label": `Color of ${label.name}`,
            "aria-expanded": String(recoloring === label.id),
            onclick: () => {
              recoloring = recoloring === label.id ? null : label.id;
              render();
            },
          },
          dot(label),
        );
        const remove = T3Mods.h("button", {
          type: "button",
          class: "t3mods-icon-button",
          title: `Delete ${label.name} from every thread`,
          "aria-label": `Delete ${label.name} from every thread`,
          onclick: () => {
            if (!confirm(`Delete the label "${label.name}" from every thread?`)) return;
            store.update((state) => {
              const assignmentsNext = {};
              for (const [key, ids] of Object.entries(state.assignments)) {
                const kept = ids.filter((id) => id !== label.id);
                if (kept.length > 0) assignmentsNext[key] = kept;
              }
              return { labels: state.labels.filter((l) => l.id !== label.id), assignments: assignmentsNext };
            });
            render();
          },
        });
        remove.append(T3Mods.icon(TRASH, "size-3"));
        panel.append(T3Mods.h("div", { class: "t3mods-label-row" }, toggle, color, remove));
        if (recoloring === label.id) {
          panel.append(
            swatchRow(
              label.color,
              (name) => `Make ${label.name} ${name}`,
              (name) => {
                store.update((state) => ({
                  ...state,
                  labels: state.labels.map((l) => (l.id === label.id ? { ...l, color: name } : l)),
                }));
                recoloring = null;
                render();
              },
            ),
          );
        }
      }

      const input = T3Mods.h("input", {
        class: "t3mods-input",
        placeholder: "New label, then Enter",
        "aria-label": "New label name",
        onkeydown: (event) => {
          if (event.key !== "Enter") return;
          const name = input.value.trim();
          if (!name) return;
          const existing = store.get().labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
          const id = existing?.id ?? `label-${Date.now().toString(36)}`;
          store.update((state) => ({
            labels: existing ? state.labels : [...state.labels, { id, name, color: newColor }],
            assignments: {
              ...state.assignments,
              [current.key]: [...new Set([...(state.assignments[current.key] ?? []), id])],
            },
          }));
          newColor = null;
          render();
          panel.querySelector("input")?.focus();
        },
      });
      panel.append(
        T3Mods.h("div", { class: "t3mods-new-label" }, input),
        swatchRow(
          newColor,
          (name) => `New label color ${name}`,
          (name) => {
            newColor = name;
            const typed = input.value;
            render();
            const next = panel.querySelector("input");
            next.value = typed;
            next.focus();
          },
        ),
      );
    };
    render();
    queueMicrotask(() => panel.querySelector("input")?.focus());
  });
};

T3Mods.onScan("thread-labels-header", () => {
  const current = T3Mods.currentThread();
  const slot = current && T3Mods.headerSlot();
  if (!slot) return;
  const thread = T3Mods.knownThread(current.key) ?? { environmentId: current.environmentId, id: current.threadId, title: current.title };
  const labels = labelsFor(thread);
  // Narrow windows (floating windows, popups, Home panes) have room for one.
  const max = window.innerWidth < 900 ? 1 : 4;
  const sig = `${current.key}|${current.isServerThread}|${max}|${labels.map((l) => `${l.id}:${l.name}:${l.color}`).join(",")}`;

  const existing = slot.querySelector(':scope > [data-t3-mod="thread-labels-header"]');
  if (existing?.t3modsSig === sig) return;
  existing?.remove();
  if (!current.isServerThread) return;

  // With labels, the chips themselves open the editor: a bigger target than a
  // separate icon, right where the labels are. Without, a tag icon does.
  const onClick = (_event, el) => {
    const now = T3Mods.currentThread();
    if (now) openEditor(el, now);
  };
  let control;
  if (labels.length > 0) {
    const names = labels.map((l) => l.name).join(", ");
    control = T3Mods.h(
      "button",
      {
        type: "button",
        class: "t3mods-header-chip-button",
        title: `Labels: ${names}. Click to edit.`,
        "aria-label": `Edit labels (${names})`,
        style: { order: "10" },
        onclick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick(event, control);
        },
      },
      chips(labels, max),
    );
  } else {
    control = T3Mods.headerButton({ name: "thread-labels-header", label: "Add a label", icon: TAG, order: 10, onClick });
  }
  control.dataset.t3Mod = "thread-labels-header";
  control.t3modsSig = sig;
  slot.append(control);
});
