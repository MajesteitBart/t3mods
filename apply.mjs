#!/usr/bin/env node
// Inline the mods in ./mods into T3 Code's web UI (server.asar). Run it after
// every T3 Code update, with T3 closed.
//
//   node apply.mjs            patch, or refresh the patch when mods changed
//   node apply.mjs --check    report status; exit 1 if not patched/up to date
//   node apply.mjs --restore  put the original index.html back
//   node apply.mjs --print-bundle   print the injected script and exit
//   --asar <path>             patch another server.asar (default: installed app)
//   --quiet                   print nothing on success
//
// The patch appends a new index.html to the archive and points the header at
// it. The original header entry is stored inside the new page, so --restore
// needs no backup and keeps any other in-place patches to the archive.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.on("uncaughtException", (error) => {
  console.error(`t3-mods: ${error.message}`);
  process.exit(1);
});

const MODS_HOME = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = ["apps", "server", "dist", "client", "index.html"];
const MARK_START = "<!-- t3-mods:start ";
const MARK_END = "<!-- t3-mods:end -->";
const BLOCK_SIZE = 4 * 1024 * 1024;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const defaultAsar = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "t3code", "resources", "server.asar");
const asarPath = path.resolve(option("--asar") ?? defaultAsar);
const quiet = flag("--quiet");
const log = (...parts) => quiet || console.log(...parts);

// --- asar format: [uint32 4][uint32 headerSize][pickle: uint32 len, uint32 strlen, json, pad][file data]

function readArchive(file) {
  const fd = fs.openSync(file, "r");
  try {
    const sizeBuf = Buffer.alloc(8);
    fs.readSync(fd, sizeBuf, 0, 8, 0);
    const headerSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, 8);
    const json = headerBuf.toString("utf8", 8, 8 + headerBuf.readUInt32LE(4));
    return { file, header: JSON.parse(json), dataStart: 8 + headerSize, fileSize: fs.fstatSync(fd).size };
  } finally {
    fs.closeSync(fd);
  }
}

function entryAt(header, parts) {
  let node = header;
  for (const part of parts) {
    node = node.files?.[part];
    if (!node) throw new Error(`${parts.join("/")} is missing from the archive`);
  }
  return node;
}

function readEntry(archive, entry) {
  const buf = Buffer.alloc(entry.size);
  const fd = fs.openSync(archive.file, "r");
  try {
    fs.readSync(fd, buf, 0, entry.size, archive.dataStart + Number(entry.offset));
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function integrity(buf) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += BLOCK_SIZE) blocks.push(sha256(buf.subarray(i, i + BLOCK_SIZE)));
  return { algorithm: "SHA256", hash: sha256(buf), blockSize: BLOCK_SIZE, blocks };
}

// Write header + the first dataLength bytes of the source data + appended bytes.
function writeArchive(source, header, dataLength, appended, outFile) {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const pad = (4 - (json.length % 4)) % 4;
  const headerPickle = Buffer.alloc(8 + json.length + pad);
  headerPickle.writeUInt32LE(4 + json.length + pad, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);

  const out = fs.openSync(outFile, "w");
  const src = fs.openSync(source.file, "r");
  try {
    fs.writeSync(out, sizePickle);
    fs.writeSync(out, headerPickle);
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    for (let done = 0; done < dataLength; ) {
      const n = fs.readSync(src, chunk, 0, Math.min(chunk.length, dataLength - done), source.dataStart + done);
      if (n === 0) throw new Error("Unexpected end of archive");
      fs.writeSync(out, chunk, 0, n);
      done += n;
    }
    fs.writeSync(out, appended);
    fs.fsyncSync(out);
  } finally {
    fs.closeSync(src);
    fs.closeSync(out);
  }
}

// --- patch state

// Returns { html, patched, meta }; meta holds the original index.html entry.
function inspect(archive) {
  const entry = entryAt(archive.header, INDEX_PATH);
  const html = readEntry(archive, entry).toString("utf8");
  const start = html.indexOf(MARK_START);
  if (start === -1) return { html, patched: false };
  const metaEnd = html.indexOf(" -->", start);
  const meta = JSON.parse(Buffer.from(html.slice(start + MARK_START.length, metaEnd), "base64").toString("utf8"));
  return { html, patched: true, meta };
}

// Header and data length of the archive as it was before patching.
function original(archive, state) {
  const header = structuredClone(archive.header);
  if (!state.patched) return { header, dataLength: archive.fileSize - archive.dataStart };
  const parts = INDEX_PATH.slice();
  const name = parts.pop();
  entryAt(header, parts).files[name] = state.meta.entry;
  return { header, dataLength: state.meta.dataLength };
}

function bundle() {
  const dir = path.join(MODS_HOME, "mods");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && !f.startsWith("_")).sort();
  const wrap = (name, code) =>
    `// --- ${name}\ntry {\n(function () {\n${code}\n})();\n} catch (error) {\n  console.error("[t3-mods] ${name} failed", error);\n}\n`;
  const parts = [wrap("runtime.js", fs.readFileSync(path.join(MODS_HOME, "runtime.js"), "utf8"))];
  for (const file of files) parts.push(wrap(file, fs.readFileSync(path.join(dir, file), "utf8")));
  parts.push(`console.info("[t3-mods] loaded: ${files.join(", ")}");\n`);
  return { code: parts.join("\n").replace(/<\/script/gi, "<\\/script"), files };
}

function t3Running() {
  if (process.platform !== "win32") return false;
  const installDir = path.dirname(path.dirname(asarPath)).toLowerCase();
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.ExecutablePath }"],
    { encoding: "utf8" },
  );
  return out.split(/\r?\n/).some((p) => p.trim() && path.dirname(p.trim()).toLowerCase() === installDir);
}

function replaceArchive(build) {
  if (t3Running()) {
    throw new Error("T3 Code is running from this install. Close it (all windows, including the tray) and run again.");
  }
  const tmp = `${asarPath}.t3mods-tmp`;
  build(tmp);
  fs.renameSync(tmp, asarPath);
}

// --- commands

const archive = readArchive(asarPath);
const state = inspect(archive);
const { code, files } = bundle();
const bundleHash = sha256(Buffer.from(code)).slice(0, 16);

if (flag("--print-bundle")) {
  process.stdout.write(code);
  process.exit(0);
}

if (flag("--check")) {
  const current = state.patched && state.meta.bundle === bundleHash;
  log(`${asarPath}: ${state.patched ? (current ? "patched, up to date" : "patched with older mods") : "not patched"}`);
  process.exit(current ? 0 : 1);
}

if (flag("--restore")) {
  if (!state.patched) {
    log("Not patched; nothing to restore.");
    process.exit(0);
  }
  const base = original(archive, state);
  replaceArchive((tmp) => writeArchive(archive, base.header, base.dataLength, Buffer.alloc(0), tmp));
  log("Restored the original index.html.");
  process.exit(0);
}

if (state.patched && state.meta.bundle === bundleHash) {
  log(`Already patched with the current mods (${files.join(", ")}).`);
  process.exit(0);
}

const base = original(archive, state);
const baseIndex = entryAt(base.header, INDEX_PATH);
const baseHtml = state.patched ? readEntry(archive, baseIndex).toString("utf8") : state.html;
if (!baseHtml.includes("</body>")) throw new Error("index.html has no </body>; refusing to patch an unexpected layout.");

const meta = { bundle: bundleHash, entry: baseIndex, dataLength: base.dataLength, files };
const block =
  `${MARK_START}${Buffer.from(JSON.stringify(meta)).toString("base64")} -->\n` +
  `<script>\n${code}</script>\n${MARK_END}\n`;
const patchedHtml = Buffer.from(baseHtml.replace("</body>", `${block}</body>`), "utf8");

const header = structuredClone(base.header);
const parts = INDEX_PATH.slice();
const name = parts.pop();
entryAt(header, parts).files[name] = {
  size: patchedHtml.length,
  offset: String(base.dataLength),
  integrity: integrity(patchedHtml),
};

replaceArchive((tmp) => writeArchive(archive, header, base.dataLength, patchedHtml, tmp));
log(`Patched ${asarPath} with: ${files.join(", ")}`);
