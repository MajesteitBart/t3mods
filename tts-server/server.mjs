// Local Supertonic 3 text-to-speech server for the T3 Code listen mod.
//
//   GET  /health                               -> { ok, loaded, voice, voices, langs }
//   POST /warm                                 -> 202; loads the model and runs one tiny inference
//   POST /speak  { text, lang?, voice?, speed? } -> audio/wav
//
// Listens on 127.0.0.1 only. Loads the model on the first request and frees it
// after `idleMinutes` without requests. Settings: config.json next to this file.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTextToSpeech, loadVoiceStyle } from "./supertonic-helper.js";

const HOME = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HOME, "assets");
const LANGS = ["en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "hi", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi"];
const MAX_TEXT = 2000;

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
const config = {
  port: 47110,
  voice: "M1",
  speed: 1.05,
  steps: 8,
  idleMinutes: 15,
  // ONNX Runtime defaults to one thread per physical core. On this hybrid
  // Intel CPU, 2-5 threads synthesize twice as fast as that default.
  threads: 4,
  // Pages allowed to call this server: the T3 desktop window and T3 served on this machine.
  allowedOrigins: ["^t3code(-dev)?://", "^https?://(127\\.0\\.0\\.1|localhost)(:\\d+)?$"],
  ...readJson(path.join(HOME, "config.json")),
};
const allowed = config.allowedOrigins.map((pattern) => new RegExp(pattern, "i"));
const voices = fs.readdirSync(path.join(ASSETS, "voice_styles")).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();

const logIndex = process.argv.indexOf("--log");
const logFile = logIndex === -1 ? null : path.resolve(HOME, process.argv[logIndex + 1]);
const log = (message) => {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  if (logFile) fs.appendFileSync(logFile, `${line}\n`);
};
process.on("uncaughtException", (error) => {
  log(`crashed: ${error.stack ?? error}`);
  process.exit(1);
});

// --- model lifecycle

let tts = null;
let loading = null;
const styles = new Map();
let idleTimer = null;

async function model() {
  if (tts) return tts;
  loading ??= (async () => {
    const started = Date.now();
    tts = await loadTextToSpeech(path.join(ASSETS, "onnx"), false, { intraOpNumThreads: config.threads });
    log(`model loaded in ${Date.now() - started} ms`);
    return tts;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

function style(name) {
  if (!styles.has(name)) styles.set(name, loadVoiceStyle([path.join(ASSETS, "voice_styles", `${name}.json`)]));
  return styles.get(name);
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (!tts || busy) return touch();
    const current = tts;
    tts = null;
    styles.clear();
    for (const session of [current.dpOrt, current.textEncOrt, current.vectorEstOrt, current.vocoderOrt]) {
      await session.release?.();
    }
    log(`model unloaded after ${config.idleMinutes} idle minutes`);
  }, config.idleMinutes * 60_000);
}

// --- synthesis, one request at a time

let queue = Promise.resolve();
let busy = false;

const DUTCH = /\b(de|het|een|en|ik|je|niet|dat|van|voor|met|op|is|zijn|wordt|ook|maar|naar)\b/gi;
const ENGLISH = /\b(the|a|and|i|you|not|that|of|for|with|on|is|are|it|this|but|to)\b/gi;
const guessLang = (text) => ((text.match(DUTCH)?.length ?? 0) > (text.match(ENGLISH)?.length ?? 0) ? "nl" : "en");

function wav(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function synthesize({ text, lang, voice, speed }, cancelled) {
  const run = queue.then(async () => {
    if (cancelled()) return null;
    busy = true;
    try {
      const engine = await model();
      const started = Date.now();
      const result = await engine.call(text, lang, style(voice), config.steps, speed);
      const samples = result.wav.slice(0, Math.floor(result.duration[0] * engine.sampleRate));
      log(`${lang} ${voice} ${text.length} chars -> ${result.duration[0].toFixed(1)} s audio in ${Date.now() - started} ms`);
      return wav(samples, engine.sampleRate);
    } finally {
      busy = false;
      touch();
    }
  });
  queue = run.catch(() => {});
  return run;
}

// --- HTTP

function send(res, status, body, headers = {}) {
  const isJson = !Buffer.isBuffer(body);
  res.writeHead(status, { "content-type": isJson ? "application/json" : "audio/wav", "cache-control": "no-store", ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !allowed.some((re) => re.test(origin))) return send(res, 403, { error: `origin not allowed: ${origin}` });
  if (origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    return send(res, 204, {}, {
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "content-type",
      "access-control-allow-private-network": "true",
      "access-control-max-age": "600",
    });
  }

  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, loaded: Boolean(tts), voice: config.voice, voices, langs: LANGS });
  }
  if (req.method === "POST" && url.pathname === "/warm") {
    // The first inference after loading is slow, so run a throwaway one.
    if (!tts && !loading) synthesize({ text: "Hi.", lang: "en", voice: config.voice, speed: config.speed }, () => false).catch(() => {});
    else touch();
    return send(res, 202, { ok: true, loaded: Boolean(tts) });
  }
  if (req.method !== "POST" || url.pathname !== "/speak") return send(res, 404, { error: "not found" });
  if (!String(req.headers["content-type"]).startsWith("application/json")) return send(res, 415, { error: "send JSON" });

  let body;
  try {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_TEXT * 4) throw new Error("request too large");
    }
    body = JSON.parse(raw);
  } catch (error) {
    return send(res, 400, { error: error.message });
  }

  const text = String(body.text ?? "").trim().slice(0, MAX_TEXT);
  const lang = LANGS.includes(body.lang) ? body.lang : guessLang(text);
  const voice = voices.includes(body.voice) ? body.voice : config.voice;
  const speed = Number.isFinite(body.speed) ? Math.min(2, Math.max(0.5, body.speed)) : config.speed;
  if (!text) return send(res, 400, { error: "text is empty" });

  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  try {
    const audio = await synthesize({ text, lang, voice, speed }, () => closed);
    if (audio && !closed) send(res, 200, audio, { "x-tts-lang": lang, "x-tts-voice": voice });
  } catch (error) {
    log(`synthesis failed: ${error.stack ?? error}`);
    if (!closed) send(res, 500, { error: error.message });
  }
});

server.listen(config.port, "127.0.0.1", () => log(`listening on http://127.0.0.1:${config.port} (voice ${config.voice})`));
