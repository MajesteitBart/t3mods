// Shared helpers for T3 Code mods. apply.mjs inlines this file before the mods.
// The script block runs while the HTML parses, before T3's module bundle
// starts. That ordering is what lets this file wrap WebSocket and prepare
// launcher panes before the app reads either.
(() => {
  if (window.T3Mods) return;

  const scanners = [];
  let queued = false;
  // sidebarRows() result for the current scan; every mod in a scan shares it.
  let rowsCache = null;
  // Last thread summary seen in the sidebar, by thread key.
  const knownThreads = new Map();

  const runScanners = () => {
    queued = false;
    rowsCache = null;
    for (const scanner of scanners) {
      try {
        scanner.fn();
      } catch (error) {
        console.error(`[t3-mods] ${scanner.name} failed`, error);
      }
    }
    rowsCache = null;
  };

  const queueScan = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(runScanners);
  };

  // --- Launcher panes

  // Where this document runs. launcher.js shows threads in iframes marked
  // data-t3mods-embed ("pane": Home and floating windows) and, in browsers,
  // in popup windows named "t3mods:<thread key>" ("window"). Both hide the
  // sidebar (see the CSS below) and leave notifications and window-level UI
  // to the main window.
  const surface = (() => {
    try {
      if (window.frameElement?.hasAttribute("data-t3mods-embed")) return "pane";
    } catch {}
    return String(window.name ?? "").startsWith("t3mods:") ? "window" : "main";
  })();
  const embedded = surface !== "main";

  if (embedded) {
    document.documentElement.classList.add("t3mods-embedded");
  }

  if (surface === "pane") {
    // The desktop window authenticates through its preload bridge, which
    // Electron installs in the top frame only. Panes borrow it to reach the
    // same environments, but calls through it act as the top window. So a pane
    // gets no desktop events (menu actions, app activation, web links: every
    // on* subscription is a no-op) and cannot claim the readiness, activation
    // or badge state the top window owns.
    try {
      const bridge = window.parent.desktopBridge;
      if (bridge && window.desktopBridge === undefined) {
        const unsubscribed = () => () => {};
        const restrict = (source) => {
          const copy = {};
          for (const [name, value] of Object.entries(source)) {
            if (typeof value === "function") copy[name] = /^on[A-Z]/.test(name) ? unsubscribed : value;
            else if (value && typeof value === "object") copy[name] = restrict(value);
            else copy[name] = value;
          }
          return copy;
        };
        const borrowed = restrict(bridge);
        const ignored = async () => {};
        borrowed.setNotificationBadge = ignored;
        if (borrowed.webLinks) borrowed.webLinks.setReady = ignored;
        if (borrowed.appActivation) {
          borrowed.appActivation.setReady = ignored;
          borrowed.appActivation.complete = ignored;
        }
        // The desktop keeps one forwarded-shortcut list; a pane would replace
        // the top window's and clear it on close.
        if (borrowed.preview) borrowed.preview.setForwardedShortcuts = ignored;
        // SnapShot captures belong to the top window. Without these, T3's
        // capability check turns its SnapShot coordinator off in the pane.
        delete borrowed.listPendingSnapShots;
        delete borrowed.readSnapShot;
        delete borrowed.acknowledgeSnapShot;
        window.desktopBridge = borrowed;
      }
    } catch {}
  }

  if (embedded) {
    // The main window already notifies and chimes; every pane would repeat it.
    // T3 only plays its sounds through a running AudioContext.
    window.AudioContext = class {
      state = "suspended";
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    };
    window.Notification = class {
      static permission = "denied";
      static requestPermission() {
        return Promise.resolve("denied");
      }
      close() {}
      addEventListener() {}
      removeEventListener() {}
    };
  }

  // --- RPC over the app's own sockets

  // T3's client speaks Effect RPC in JSON frames over /ws, authenticated when
  // the socket opens. Mods send read-only requests on those sockets, with ids
  // far above the app's own counter, and take their replies out of the frames
  // before the app's listeners see them.
  const NativeWebSocket = window.WebSocket;
  const rpcSockets = new Set();
  const pending = new Map(); // request id -> { resolve, reject, timer }
  // Message events that carried mod replies: null when nothing is left for the
  // app, otherwise the frame data without them.
  const filtered = new WeakMap();
  const listenerWrappers = new WeakMap();
  let nextRequestId = 9_100_000_000_000_000_000n;

  // Settle the mod requests in a frame. Returns undefined when the frame holds
  // none, else what remains for the app (null for nothing).
  const takeReplies = (data) => {
    if (pending.size === 0 || typeof data !== "string") return undefined;
    let mentioned = false;
    for (const id of pending.keys()) {
      if (data.includes(`"requestId":"${id}"`)) {
        mentioned = true;
        break;
      }
    }
    if (!mentioned) return undefined;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return undefined;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const rest = [];
    for (const message of messages) {
      const entry = message?._tag === "Exit" ? pending.get(message.requestId) : undefined;
      if (!entry) {
        rest.push(message);
        continue;
      }
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.exit?._tag === "Success") entry.resolve(message.exit.value);
      else entry.reject(new Error(`RPC failed: ${JSON.stringify(message.exit?.cause ?? message).slice(0, 300)}`));
    }
    if (rest.length === messages.length) return undefined;
    if (rest.length === 0) return null;
    return JSON.stringify(Array.isArray(parsed) ? rest : rest[0]);
  };

  const onSocketMessage = (event) => {
    const rest = takeReplies(event.data);
    if (rest !== undefined) filtered.set(event, rest);
  };

  // What an app listener should receive for event: the event itself, a copy
  // without the mod replies, or nothing.
  const forApp = (event) => {
    if (!filtered.has(event)) return event;
    const data = filtered.get(event);
    return data === null ? null : new MessageEvent("message", { data, origin: event.origin });
  };

  const wrapListener = (listener) => {
    let wrapped = listenerWrappers.get(listener);
    if (!wrapped) {
      wrapped = function (event) {
        const delivered = forApp(event);
        if (delivered === null) return undefined;
        return typeof listener === "function" ? listener.call(this, delivered) : listener.handleEvent(delivered);
      };
      listenerWrappers.set(listener, wrapped);
    }
    return wrapped;
  };

  class ModWebSocket extends NativeWebSocket {
    #onmessage = null;
    #onmessageListener = null;

    constructor(url, protocols) {
      super(url, protocols);
      let path = "";
      try {
        path = new URL(this.url).pathname;
      } catch {}
      if (path.endsWith("/ws")) {
        rpcSockets.add(this);
        EventTarget.prototype.addEventListener.call(this, "message", onSocketMessage);
        EventTarget.prototype.addEventListener.call(this, "close", () => rpcSockets.delete(this));
      }
    }

    addEventListener(type, listener, options) {
      return super.addEventListener(type, type === "message" && listener ? wrapListener(listener) : listener, options);
    }

    removeEventListener(type, listener, options) {
      const target = type === "message" && listener ? (listenerWrappers.get(listener) ?? listener) : listener;
      return super.removeEventListener(type, target, options);
    }

    get onmessage() {
      return this.#onmessage;
    }

    // Independent of addEventListener registrations, as on a native socket.
    set onmessage(handler) {
      if (this.#onmessageListener) super.removeEventListener("message", this.#onmessageListener);
      this.#onmessage = typeof handler === "function" ? handler : null;
      this.#onmessageListener = null;
      if (!this.#onmessage) return;
      const current = this.#onmessage;
      this.#onmessageListener = function (event) {
        const delivered = forApp(event);
        if (delivered !== null) current.call(this, delivered);
      };
      super.addEventListener("message", this.#onmessageListener);
    }
  }
  window.WebSocket = ModWebSocket;

  const rpcRequest = (socket, tag, payload, timeoutMs) =>
    new Promise((resolve, reject) => {
      const id = String(nextRequestId++);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${tag} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });

  // The environment behind a socket. Asked once per socket; a failed answer is
  // forgotten so the next request asks again.
  const socketEnvironments = new WeakMap();
  const socketEnvironment = (socket) => {
    if (!socketEnvironments.has(socket)) {
      const lookup = rpcRequest(socket, "server.getConfig", {}, 15000).then(
        (config) => config?.environment?.environmentId ?? null,
        () => null,
      );
      socketEnvironments.set(socket, lookup);
      lookup.then((environmentId) => {
        if (environmentId === null && socketEnvironments.get(socket) === lookup) socketEnvironments.delete(socket);
      });
    }
    return socketEnvironments.get(socket);
  };

  // --- Shared state

  const stores = new Map();

  const makeStore = (key, fallback) => {
    const storageKey = `t3mods:${key}`;
    const read = () => {
      try {
        const raw = localStorage.getItem(storageKey);
        return raw === null ? structuredClone(fallback) : JSON.parse(raw);
      } catch {
        return structuredClone(fallback);
      }
    };
    let value = read();
    const listeners = new Set();
    const notify = () => {
      for (const listener of listeners) {
        try {
          listener(value);
        } catch (error) {
          console.error(`[t3-mods] store ${key} listener failed`, error);
        }
      }
      queueScan();
    };
    // Launcher panes and other tabs share this origin's localStorage; the
    // storage event keeps every document's copy current.
    window.addEventListener("storage", (event) => {
      if (event.key !== storageKey) return;
      value = read();
      notify();
    });
    const store = {
      get: () => value,
      set(next) {
        value = next;
        localStorage.setItem(storageKey, JSON.stringify(next));
        notify();
      },
      // Reads storage first: another pane or tab may have written since this
      // document's last storage event.
      update(fn) {
        store.set(fn(read()));
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    return store;
  };

  let router = null;

  const T3Mods = {
    // "main", "pane" (Home or a floating window) or "window" (a browser
    // popup). embedded is true for the last two.
    surface,
    embedded,

    // Run fn after every DOM change, at most once per frame.
    onScan(name, fn) {
      scanners.push({ name, fn });
      queueScan();
    },

    // Schedule a scan without a DOM change, for example after a state change.
    rescan: queueScan,

    // Call create(container) for every container matching selector that doesn't
    // yet hold an element with data-t3-mod="name". React can drop injected
    // nodes on re-render; this puts them back.
    ensure(name, selector, create) {
      T3Mods.onScan(name, () => {
        for (const container of document.querySelectorAll(selector)) {
          if (!container.querySelector(`:scope > [data-t3-mod="${name}"]`)) create(container);
        }
      });
    },

    // Props of the closest React component at or above el that matches test.
    reactProps(el, test, maxHops = 30) {
      const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      let fiber = key ? el[key] : null;
      for (let hop = 0; fiber && hop < maxHops; hop++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (props && typeof props === "object" && test(props)) return props;
      }
      return undefined;
    },

    // Read a prop from the closest React component at or above el.
    reactProp(el, prop, maxHops = 30) {
      return T3Mods.reactProps(el, (props) => props[prop] !== undefined, maxHops)?.[prop];
    },

    // Build a 24x24 stroke icon in the style of T3's own (lucide) icons.
    icon(svgInner, className = "size-3.5") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (const [k, v] of Object.entries({
        viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2",
        "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
      })) svg.setAttribute(k, v);
      svg.setAttribute("class", className);
      svg.innerHTML = svgInner;
      return svg;
    },

    // h("button", { class: "x", onclick }, "text", childNode)
    h(tag, attrs = {}, ...children) {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k === "dataset") Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? "" : String(v));
      }
      el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
      return el;
    },

    // Add a stylesheet once.
    css(name, text) {
      if (document.querySelector(`style[data-t3-mod-style="${name}"]`)) return;
      const style = document.createElement("style");
      style.dataset.t3ModStyle = name;
      style.textContent = text;
      (document.head ?? document.documentElement).append(style);
    },

    // A JSON value in localStorage, shared by every mod that asks for the key.
    store(key, fallback) {
      if (!stores.has(key)) stores.set(key, makeStore(key, fallback));
      return stores.get(key);
    },

    // Send tag to every connected environment. Resolves with
    // [{ environmentId, value }] for the replies that succeeded; environmentId
    // is null when the environment could not be identified. Only for read-only
    // requests: payloads are not validated client-side, and a mod has no
    // business mutating state this way.
    rpcAll(tag, payload = {}, timeoutMs = 15000) {
      const open = [...rpcSockets].filter((socket) => socket.readyState === NativeWebSocket.OPEN);
      const ask = async (socket) => {
        const [value, environmentId] = await Promise.all([
          rpcRequest(socket, tag, payload, timeoutMs),
          socketEnvironment(socket),
        ]);
        return { value, environmentId };
      };
      return Promise.allSettled(open.map(ask)).then((results) =>
        results.flatMap((result) => {
          if (result.status === "fulfilled") return [result.value];
          console.warn(`[t3-mods] ${tag}`, result.reason);
          return [];
        }),
      );
    },

    threadKey: (environmentId, threadId) => `${environmentId}/${threadId}`,
    // The route of a thread, for navigate().
    threadPath: (environmentId, threadId) =>
      `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`,
    // A URL that loads the app on a route, for iframes and full loads. T3
    // routes by hash in the desktop app (main.tsx picks hash history whenever
    // desktopBridge exists, so panes that borrow it do too) and by path in
    // browsers.
    routeUrl: (path) => (window.desktopBridge !== undefined ? `/#${path}` : path),

    // The thread open in the chat view, from the header's props.
    currentThread() {
      const crumbs = document.querySelector('header[data-chat-header="true"] nav ol');
      const props = crumbs && T3Mods.reactProps(crumbs, (p) => p.activeThreadId !== undefined);
      if (!props) return null;
      return {
        environmentId: props.activeThreadEnvironmentId,
        threadId: props.activeThreadId,
        title: props.activeThreadTitle,
        isServerThread: props.isServerThread !== false,
        key: T3Mods.threadKey(props.activeThreadEnvironmentId, props.activeThreadId),
      };
    },

    // The sidebar thread rows React has rendered, with the row component's props.
    sidebarRows() {
      if (rowsCache) return rowsCache;
      rowsCache = [];
      for (const item of document.querySelectorAll("li[data-thread-item]")) {
        const props = T3Mods.reactProps(item, (p) => p.thread?.id !== undefined, 6);
        if (!props) continue;
        const key = T3Mods.threadKey(props.thread.environmentId, props.thread.id);
        knownThreads.set(key, props.thread);
        rowsCache.push({
          item,
          row: item.querySelector(':scope [data-testid^="sidebar-row-"]'),
          props,
          thread: props.thread,
          key,
        });
      }
      return rowsCache;
    },

    // The latest summary of a thread the sidebar has shown, or undefined.
    knownThread: (key) => knownThreads.get(key),

    // Client-side navigation through T3's router; a full load as fallback.
    navigate(to) {
      if (!router) {
        const start = document.querySelector("[data-slot='sidebar-wrapper']") ?? document.body.firstElementChild;
        router = T3Mods.reactProps(start, (p) => typeof p.router?.navigate === "function", 2000)?.router ?? null;
      }
      if (router) router.navigate({ to });
      else location.assign(T3Mods.routeUrl(to));
    },

    // A small menu or panel under anchor that closes on outside click, Escape,
    // or close(). Returns { el, close }. One popover is open at a time. Focus
    // inside it goes back to anchor when it closes, except on an outside
    // click, which puts focus where the user clicked.
    popover(anchor, build, { align = "start", onClose } = {}) {
      document.querySelector("[data-t3mods-popover]")?.t3modsClose?.();
      const el = T3Mods.h("div", { class: "t3mods-popover", "data-t3mods-popover": true, role: "dialog" });
      const close = (restoreFocus = true) => {
        if (!el.isConnected) return;
        const hadFocus = el.contains(document.activeElement);
        el.remove();
        document.removeEventListener("pointerdown", onPointer, true);
        document.removeEventListener("keydown", onKey, true);
        if (restoreFocus && hadFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
        onClose?.();
      };
      const onPointer = (event) => {
        if (!el.contains(event.target) && !anchor.contains(event.target)) close(false);
      };
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      };
      el.t3modsClose = close;
      build(el, close);
      document.body.append(el);
      const rect = anchor.getBoundingClientRect();
      const width = el.offsetWidth;
      const left = align === "end" ? rect.right - width : rect.left;
      el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
      el.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - el.offsetHeight - 8)}px`;
      document.addEventListener("pointerdown", onPointer, true);
      document.addEventListener("keydown", onKey, true);
      return { el, close };
    },

    // A menu under anchor. items: [{ label, hint?, icon?, onSelect }], with
    // "-" for a separator. Arrow keys move between items.
    menu(anchor, items, options) {
      return T3Mods.popover(
        anchor,
        (panel, close) => {
          panel.classList.add("t3mods-menu");
          panel.setAttribute("role", "menu");
          for (const item of items) {
            if (item === "-") {
              panel.append(T3Mods.h("div", { class: "t3mods-menu-separator", role: "separator" }));
              continue;
            }
            panel.append(
              T3Mods.h(
                "button",
                {
                  type: "button",
                  class: "t3mods-menu-item",
                  role: "menuitem",
                  onclick: () => {
                    close();
                    item.onSelect();
                  },
                },
                item.icon ? T3Mods.icon(item.icon) : null,
                T3Mods.h("span", { class: "t3mods-menu-label" }, item.label),
                item.hint ? T3Mods.h("kbd", { class: "t3mods-menu-hint" }, item.hint) : null,
              ),
            );
          }
          panel.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const buttons = [...panel.querySelectorAll(".t3mods-menu-item")];
            const at = buttons.indexOf(document.activeElement);
            const next = event.key === "ArrowDown" ? at + 1 : at - 1;
            buttons[(next + buttons.length) % buttons.length]?.focus();
          });
          queueMicrotask(() => panel.querySelector(".t3mods-menu-item")?.focus());
        },
        options,
      );
    },

    // The span after the thread title in the chat header that mods put their
    // chips and buttons into. Buttons order themselves with style.order.
    headerSlot() {
      const crumb = document.querySelector('header[data-chat-header="true"] nav ol > li[aria-current="page"]');
      if (!crumb) return null;
      let slot = crumb.querySelector(':scope > [data-t3-mod="header-slot"]');
      if (!slot) {
        slot = T3Mods.h("span", { class: "t3mods-header-slot", "data-t3-mod": "header-slot" });
        crumb.append(slot);
      }
      return slot;
    },

    // A header icon button matching T3's breadcrumb controls.
    headerButton({ name, label, icon, order = 0, onClick }) {
      const button = T3Mods.h("button", {
        type: "button",
        class: "t3mods-header-button",
        "data-t3-mod": name,
        "aria-label": label,
        title: label,
        style: { order: String(order) },
        onclick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick(event, button);
        },
      });
      button.append(T3Mods.icon(icon));
      return button;
    },
  };

  // Matches T3's own controls: ghost buttons (no border, accent on hover,
  // a slight press), its menu surface (dropdown-glass) and its inputs.
  T3Mods.css(
    "runtime",
    `
.t3mods-embedded [data-slot="sidebar"],
.t3mods-embedded [data-slot="sidebar-gap"],
.t3mods-embedded [data-slot="sidebar-rail"],
.t3mods-embedded button[aria-label="Toggle main sidebar"] { display: none !important; }
/* With no sidebar there is no toggle to clear; give the header its normal inset. */
.t3mods-embedded [data-slot="sidebar-wrapper"] { --workspace-titlebar-content-left: var(--workspace-gutter-start, 0.75rem) !important; }
.t3mods-embedded * { -webkit-app-region: no-drag !important; }
.t3mods-header-slot { display: inline-flex; align-items: center; gap: 0.25rem; margin-left: 0.5rem; min-width: 0; flex-shrink: 0; }
.t3mods-header-button, .t3mods-icon-button {
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  width: 1.5rem; height: 1.5rem; padding: 0; border: 0; border-radius: var(--radius-md, 0.375rem);
  color: var(--muted-foreground); background: transparent; cursor: pointer; -webkit-app-region: no-drag;
  transition: scale 160ms cubic-bezier(0.23, 1, 0.32, 1);
}
.t3mods-header-button:hover, .t3mods-header-button[aria-pressed="true"], .t3mods-header-button[aria-expanded="true"],
.t3mods-icon-button:hover { color: var(--foreground); background: var(--accent); }
.t3mods-header-button:active, .t3mods-icon-button:active, .t3mods-header-chip-button:active { scale: 0.97; }
.t3mods-header-button:focus-visible, .t3mods-icon-button:focus-visible, .t3mods-header-chip-button:focus-visible {
  outline: 2px solid var(--ring); outline-offset: -2px;
}
.t3mods-header-chip-button {
  display: inline-flex; align-items: center; gap: 0.25rem; height: 1.5rem; padding: 0 0.25rem; margin: 0 -0.125rem;
  border: 0; border-radius: var(--radius-md, 0.375rem); background: transparent; cursor: pointer; -webkit-app-region: no-drag;
  transition: scale 160ms cubic-bezier(0.23, 1, 0.32, 1);
}
.t3mods-header-chip-button:hover { background: var(--accent); }
/* T3's dropdown-glass, copied so it holds whatever order the stylesheets load in. */
.t3mods-popover {
  position: fixed; z-index: 2147483000; min-width: 14rem; max-width: 20rem; max-height: 70vh; overflow: auto;
  padding: 0.25rem; border-radius: var(--radius-lg, 0.5rem); color: var(--popover-foreground);
  background: color-mix(in srgb, var(--popover) 18%, color-mix(in srgb, var(--popover) var(--glass-opacity, 80%), transparent));
  -webkit-backdrop-filter: blur(var(--glass-blur, 12px)) saturate(var(--glass-saturation, 1.14));
  backdrop-filter: blur(var(--glass-blur, 12px)) saturate(var(--glass-saturation, 1.14));
  border: 1px solid color-mix(in srgb, var(--contrast-foreground, var(--foreground)) 10%, transparent);
  box-shadow: 0 16px 40px -18px rgb(0 0 0 / 55%); font-size: 0.875rem; -webkit-app-region: no-drag;
}
.dark .t3mods-popover { box-shadow: 0 18px 44px -18px rgb(0 0 0 / 80%); }
.t3mods-popover h3 { margin: 0.375rem 0.5rem 0.25rem; font-size: 0.75rem; font-weight: 500; color: var(--muted-foreground); }
.t3mods-menu-item {
  display: flex; width: 100%; min-height: 1.75rem; align-items: center; gap: 0.5rem; padding: 0.25rem 0.5rem;
  border: 0; border-radius: var(--radius-sm, 0.25rem); background: transparent; color: var(--foreground);
  font: inherit; text-align: left; cursor: pointer;
}
.t3mods-menu-item:hover, .t3mods-menu-item:focus-visible { background: var(--accent); outline: none; }
.t3mods-menu { min-width: 13rem; }
.t3mods-menu .t3mods-menu-item svg { width: 1rem; height: 1rem; color: var(--muted-foreground); flex-shrink: 0; }
.t3mods-menu-label { flex: 1; min-width: 0; }
.t3mods-menu-hint { font: inherit; font-size: 0.75rem; color: var(--muted-foreground); }
.t3mods-menu-separator { height: 1px; margin: 0.25rem 0.5rem; background: var(--border); }
.t3mods-input {
  width: 100%; height: 1.875rem; padding: 0 0.625rem; border: 1px solid var(--input, var(--border));
  border-radius: var(--radius-lg, 0.5rem); background: var(--background); color: var(--foreground); font: inherit;
  transition: box-shadow 150ms ease;
}
.t3mods-input::placeholder { color: var(--muted-foreground); }
.t3mods-input:focus { outline: none; border-color: var(--ring); box-shadow: inset 0 0 0 3px color-mix(in srgb, var(--ring) 24%, transparent); }
.t3mods-muted { color: var(--muted-foreground); padding: 0.25rem 0.5rem; font-size: 0.75rem; }
`,
  );

  window.T3Mods = T3Mods;
  // Some mods lay out differently in narrow windows.
  window.addEventListener("resize", queueScan, { passive: true });
  const start = () => {
    new MutationObserver(queueScan).observe(document.body, { childList: true, subtree: true });
    queueScan();
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
