// Adds a Listen button next to "Copy message" under each assistant message.
// Speaks with the local Supertonic 3 server (../tts-server) and falls back to
// the browser's Windows voices when that server isn't reachable, for example
// in a browser on another device.
const TTS_URL = localStorage.getItem("t3mods:tts-url") ?? "http://127.0.0.1:47110";
const SPEAKER = '<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.4 18.4a9 9 0 0 0 0-12.8"/>';
const STOP = '<rect x="6" y="6" width="12" height="12" rx="2"/>';
const DUTCH_WORDS = /\b(de|het|een|en|ik|je|niet|dat|van|voor|met|op|is|zijn|wordt|ook|maar|naar)\b/gi;
const ENGLISH_WORDS = /\b(the|a|and|i|you|not|that|of|for|with|on|is|are|it|this|but|to)\b/gi;
const CODE_MARK = "⁣code⁣";
const SKIPPED = { en: "(code block skipped)", nl: "(codeblok overgeslagen)" };

let active = null; // { button, cancelled, abort, audio }

const guessLang = (text) =>
  (text.match(DUTCH_WORDS)?.length ?? 0) > (text.match(ENGLISH_WORDS)?.length ?? 0) ? "nl" : "en";

const speechText = (message) => {
  const parts = [...message.querySelectorAll(".chat-markdown")].map((markdown) => {
    const copy = markdown.cloneNode(true);
    for (const pre of copy.querySelectorAll("pre")) pre.replaceWith(` ${CODE_MARK} `);
    return copy.innerText;
  });
  const raw = parts.join("\n\n").replace(/[`*_#>|]/g, "").replace(/[ \t]+/g, " ").trim();
  const lang = guessLang(raw.replaceAll(CODE_MARK, ""));
  return { text: raw.replaceAll(CODE_MARK, SKIPPED[lang]), lang };
};

// Split a long first sentence at the last comma/colon/semicolon (or space)
// before max, so the first chunk synthesizes fast.
const splitHead = (sentence, max) => {
  if (sentence.length <= max) return [sentence];
  const head = sentence.slice(0, max);
  let cut = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "));
  if (cut < 30) cut = head.lastIndexOf(" ");
  if (cut < 30) return [sentence];
  return [sentence.slice(0, cut + 1), sentence.slice(cut + 1)];
};

// Sentence-sized chunks. Synthesis time grows with audio length, so the first
// chunk is short and audio starts quickly; later chunks render while one plays.
const chunks = (text, firstMax = 80, max = 260) => {
  // Split after . ! ? only when whitespace follows, so "AGENTS.md" stays whole.
  const [first, ...rest] = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim()).map((s) => `${s} `);
  const sentences = [...splitHead(first, firstMax), ...rest];
  const out = [];
  let current = "";
  for (const sentence of sentences) {
    const limit = out.length === 0 ? firstMax : max;
    if ((current + sentence).length > limit && current.trim()) {
      out.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) out.push(current.trim());
  return out;
};

const setIcon = (button, speaking) => {
  const iconClass = button.dataset.iconClass ?? "size-3.5";
  button.replaceChildren(T3Mods.icon(speaking ? STOP : SPEAKER, iconClass));
  button.setAttribute("aria-label", speaking ? "Stop reading" : "Listen");
  button.title = speaking ? "Stop reading" : "Listen";
  button.setAttribute("aria-pressed", String(speaking));
};

const stop = () => {
  if (!active) return;
  active.cancelled = true;
  active.abort.abort();
  active.audio?.pause();
  speechSynthesis.cancel();
  setIcon(active.button, false);
  active = null;
};

const finish = (session) => {
  if (active === session) stop();
};

// --- Supertonic: fetch chunk n+1 while chunk n plays.

const synthesize = async (session, text, lang) => {
  const res = await fetch(`${TTS_URL}/speak`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, lang }),
    signal: session.abort.signal,
  });
  if (!res.ok) throw new Error(`TTS server returned ${res.status}`);
  return URL.createObjectURL(await res.blob());
};

const play = (session, url) =>
  new Promise((resolve, reject) => {
    const audio = new Audio(url);
    session.audio = audio;
    audio.onended = resolve;
    audio.onerror = () => reject(new Error("audio playback failed"));
    audio.play().catch(reject);
  }).finally(() => URL.revokeObjectURL(url));

const speakWithSupertonic = async (session, text, lang) => {
  const parts = chunks(text);
  let next = synthesize(session, parts[0], lang);
  for (let i = 0; i < parts.length; i++) {
    const url = await next;
    if (session.cancelled) return URL.revokeObjectURL(url);
    next = i + 1 < parts.length ? synthesize(session, parts[i + 1], lang) : null;
    next?.catch(() => {}); // surfaced when awaited
    await play(session, url);
    if (session.cancelled) return;
  }
};

// --- Fallback: Windows voices through the browser.

const speakWithBrowser = (session, text, lang) =>
  new Promise((resolve) => {
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang));
    const voice = voices.find((v) => /natural|online/i.test(v.name)) ?? voices[0] ?? null;
    const queue = chunks(text, 220, 220);
    const next = () => {
      const part = queue.shift();
      if (session.cancelled || part === undefined) return resolve();
      const utterance = new SpeechSynthesisUtterance(part);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.onend = next;
      utterance.onerror = resolve;
      speechSynthesis.speak(utterance);
    };
    next();
  });

const speak = async (button, message) => {
  const wasThisButton = active?.button === button;
  stop();
  if (wasThisButton) return;

  const { text, lang } = speechText(message);
  if (!text) return;
  const session = { button, cancelled: false, abort: new AbortController(), audio: null };
  active = session;
  setIcon(button, true);

  try {
    await speakWithSupertonic(session, text, lang);
  } catch (error) {
    if (session.cancelled) return;
    // A refused connection means the server isn't running: use the browser voice.
    if (error instanceof TypeError) {
      console.info("[t3-mods] listen: Supertonic server unreachable, using browser voice");
      await speakWithBrowser(session, text, lang);
    } else {
      console.error("[t3-mods] listen failed", error);
    }
  }
  finish(session);
};

// Load the voice list early; Chromium fills it asynchronously.
speechSynthesis.getVoices();

// Hovering a Listen button asks the server to load the model, so the click
// doesn't pay for it. At most once a minute.
let lastWarm = 0;
const warm = () => {
  if (Date.now() - lastWarm < 60_000) return;
  lastWarm = Date.now();
  fetch(`${TTS_URL}/warm`, { method: "POST" }).catch(() => {});
};

T3Mods.ensure(
  "listen",
  '[data-message-role="assistant"] div:has(> button[aria-label="Copy message"])',
  (actions) => {
    const copy = actions.querySelector(':scope > button[aria-label="Copy message"]');
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.t3Mod = "listen";
    button.dataset.iconClass = copy.querySelector("svg")?.getAttribute("class") ?? "size-3.5";
    button.className = copy.className;
    setIcon(button, false);
    button.addEventListener("click", () => speak(button, actions.closest("[data-message-role]")));
    button.addEventListener("pointerenter", warm);
    button.addEventListener("focus", warm);
    const fork = actions.querySelector(':scope > button[aria-label="Fork from this response"]');
    (fork ?? copy).after(button);
  },
);
