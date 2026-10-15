# t3mods

Small additions to the [T3 Code](https://github.com/pingdotgg/t3code) web UI,
injected into the installed app, plus a watcher that puts them back after every
T3 update. This is an unofficial, personal project, not part of T3 Code.

| Mod | What it adds |
| --- | --- |
| `thread-labels.js` | Colored labels on threads. Scheduled-task, webhook and subagent threads are labelled automatically |
| `keep-active.js` | Mark a thread active while subagents T3 can't see are still running |
| `launcher.js` | Home: several live threads side by side. Open a thread in a new window |
| `github-repo.js` | GitHub link next to the project name in the chat header |
| `listen.js` | Listen button under replies, with a local text-to-speech server |

The mods hook into T3's DOM and React props, which are not a public API. A T3
update can rename a hook and make a mod silently disappear. Look for
`[t3-mods]` lines in the browser console when that happens.

## How it works

T3 Code serves its web UI from `resources/server.asar` in the install folder.
`apply.mjs` adds a script block with `runtime.js` and every file in `mods/`
to the `index.html` inside that archive. The desktop window and every browser
connected to that T3 server get the mods, because they all load that page. The
mobile app has its own UI and gets none of them.

The script runs before T3's own code starts. That lets `runtime.js` wrap the
WebSocket the app uses, so mods can send read-only requests (such as listing
scheduled tasks) over the app's own authenticated connection.

## Install (Windows)

You need Node.js 22.13 or newer and T3 Code installed in its default location
(`%LOCALAPPDATA%\Programs\t3code`).

```
git clone https://github.com/MajesteitBart/t3mods %USERPROFILE%\.t3\mods
cd %USERPROFILE%\.t3\mods
powershell -ExecutionPolicy Bypass -File watch.ps1 -Install
```

The watcher finds that the installed build has no mods yet, waits until no T3
run is active, restarts T3 and applies them. To use the listen button with the
local voice, also set up the text-to-speech server (see below).

To remove everything: `powershell -File watch.ps1 -Uninstall`, then close T3
and run `node apply.mjs --restore`. That takes the mods out of the archive; the
editor-discovery workaround below stays until the next T3 update replaces the
archive.

## Updates

Each T3 update replaces `server.asar` and with it the mods. The scheduled task
"T3 Mods Watcher" runs `watch.ps1` at logon:

- Every 30 seconds it checks whether `server.asar` changed. After a change it
  runs `node apply.mjs --check`.
- When the new build has no mods and T3 is closed, it patches right away.
- When T3 is running, it runs `restart-and-apply.ps1`. That waits until no T3
  run has been active for 30 seconds (up to an hour), closes T3, runs
  `launch.ps1` (patches, then starts T3) and logs to `restart-and-apply.log`.
  After an update this means T3 restarts a second time, shortly after the
  updater's own restart.
- A build that carries an older version of the mods is left alone, so editing
  a mod never restarts T3 by surprise. Run `restart-and-apply.ps1` yourself
  for that.
- A failed attempt is retried after 10 minutes. Everything is logged to
  `watch.log`.

To get the result posted into a T3 thread, put
`{ "reportThreadId": "<thread id>" }` in `config.json` next to `watch.ps1`. The
message starts a turn in that thread, so leave it out unless you want an agent
to check every update.

`launch.ps1` also applies a workaround for builds that give up on editor
discovery after five seconds. Builds without that code are left alone.

## Commands

```
powershell -File watch.ps1 -Install     register and start the watcher task
powershell -File watch.ps1 -Uninstall   remove it
powershell -File restart-and-apply.ps1  apply now: wait for idle, restart T3 with the mods
powershell -File launch.ps1             with T3 closed: patch and start T3
```

With T3 closed (all windows and the tray icon):

```
node apply.mjs             patch, or refresh the patch after you change a mod
node apply.mjs --check     show whether the installed app carries the current mods
node apply.mjs --restore   remove the mods (other patches to the archive stay)
```

## Labels

Threads get colored chips after their title in the sidebar and the chat header,
and a colored bar on the left of the sidebar row in the first label's color.
Sidebar cards show the first label and a count of the rest; slim rows show dots.

- Scheduled (or Webhook) is added to threads that a scheduled task runs in or
  launched. Subagent is added to subagent threads.
- Your own labels: click the labels next to a thread's title, or the tag button
  when it has none. Click a label to toggle it, click its dot to pick another
  color, or type a name and press Enter to create one.

## Marking a thread active

T3 shows "Waiting" while background work it knows about is running. For work it
can't see, such as subagents a provider keeps running after the turn ends,
click the activity button next to the thread's title. The thread moves back to
the active list (un-settled or woken, when its sidebar row is visible) and gets
a "Subagents" chip. Click the chip when the work is done; settling the thread
clears the mark too.

## Home and new windows

Home shows several threads side by side, each fully usable, composer included.
Open it with the house button in the sidebar footer or Ctrl+Alt+H. The window
button next to a thread's title adds it to Home or opens it in a new window;
"Add thread" in Home adds threads too.

Each pane can be minimized to the dock at the bottom, maximized (double-click
its title bar), opened in the main window, moved to its own window, or removed.
Minimized panes show a dot while their thread is working or waiting for you.

In a browser, "Open in new window" opens a real popup window. The desktop app
does not let its pages open windows, so there the thread opens in a floating
window inside T3: drag it by its title bar and resize it from the bottom-right
corner. A browser that blocks the popup gets a floating window too. Popups
leave notifications and sounds to the main window, so keep that one open.

Every pane and window runs its own copy of the app, so a handful is fine and a
dozen is heavy. Home only loads panes while it is open.

Labels, active marks and the Home layout are stored in the browser's
localStorage, so each device keeps its own.

## Listen button and the Supertonic server

`mods/listen.js` reads replies aloud with [Supertonic 3](https://huggingface.co/Supertone/supertonic-3),
which runs locally on the CPU from `tts-server/`. Without the server, for
example in a browser on another device, the button uses the system voices.

Set it up once. The model download (about 380 MB) uses the Hugging Face CLI,
`hf`, from `pip install -U huggingface_hub`:

```
cd tts-server
npm install
hf download Supertone/supertonic-3 --revision 3cadd1ee6394adea1bd021217a0e650ede09a323 --include "onnx/*" "voice_styles/*" --local-dir assets
powershell -File service.ps1 install
```

The model license is OpenRAIL-M (`assets/LICENSE`). `supertonic-helper.js` is
adapted from Supertone's MIT-licensed code (`LICENSE-supertonic-code`). The
server listens on `127.0.0.1:47110`, loads the model when a Listen button is
hovered and frees it after 15 idle minutes.

- `config.json` sets the voice (`F1`-`F5`, `M1`-`M5`), speed, denoising steps
  and threads. Run `service.ps1 restart` after editing.
- `service.ps1 install|uninstall|status|start|stop|restart` manages the server
  and its "T3 Supertonic TTS" scheduled task.
- Replies are sent in sentence chunks; the next chunk renders while one plays.
  The language is guessed per message (Dutch or English).

## Writing a mod

Drop a `.js` file in `mods/`. Files starting with `_` are skipped. Mods load in
alphabetical order, each in its own function scope, after `runtime.js`.
`runtime.js` provides `window.T3Mods`:

- `onScan(name, fn)` runs `fn` after DOM changes and resizes, at most once per
  frame; `rescan()` asks for a scan without a DOM change. Keep scans cheap:
  they run while replies stream. Compare a signature before touching the DOM.
- `ensure(name, selector, create)` calls `create(container)` for every matching
  element that doesn't yet contain `[data-t3-mod=name]`, and again whenever
  React re-renders it away.
- `reactProp(el, prop)` and `reactProps(el, test)` read props from the nearest
  React component above `el`.
- `sidebarRows()` lists the rendered sidebar rows with their thread summary and
  row props (including handlers such as `onUnsettle`). `knownThread(key)`
  returns the last summary seen for a thread key.
- `currentThread()` describes the thread in the chat view; `headerSlot()` and
  `headerButton(...)` add controls next to its title.
- `store(key, fallback)` is a JSON value in localStorage that stays in sync
  across tabs and Home panes.
- `rpcAll(tag, payload)` sends a read-only request to every connected
  environment over the app's own WebSocket and resolves with
  `[{ environmentId, value }]`.
- `menu(anchor, items)`, `popover(anchor, build)`, `navigate(path)`,
  `threadPath(environmentId, threadId)`, `css(name, text)`,
  `h(tag, attrs, ...children)` and `icon(svgInner)` cover the rest.
- `surface` is `"main"`, `"pane"` (Home or a floating window) or `"window"`
  (a browser popup); `embedded` is true for the last two.

To try a DOM-only change before patching, run `node apply.mjs --print-bundle`
and paste the output into the browser console of a T3 tab. `rpcAll`, Home and
new windows need the patched page, because they depend on code that runs
before T3 starts.
