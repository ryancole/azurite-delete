#!/usr/bin/env node
"use strict";

// Deletes blobs from a local Azurite (LokiJS) data folder by editing
// __azurite_db_blob__.json directly. See README.md for the on-disk format and
// why this is safe. Dry run unless --apply is given.

const fs = require("fs");
const path = require("path");
const net = require("net");
const { execFileSync } = require("child_process");
const Loki = require("lokijs");

const BLOB_DB = "__azurite_db_blob__.json";
const EXTENT_DB = "__azurite_db_blob_extent__.json";
const EXTENT_DIR = "__blobstorage__";
const BLOBS = "$BLOBS_COLLECTION$";
const BLOCKS = "$BLOCKS_COLLECTION$";
const CONTAINERS = "$CONTAINERS_COLLECTION$";
const EXTENTS = "$EXTENTS_COLLECTION$";
const BACKUP_DIR = "azurite-delete-backups";

const USAGE = `Usage:
  azurite-delete --location <azurite folder> --container <name> [--prefix <p> ...] [--container ...] [options]
  azurite-delete --location <azurite folder> --target <container>[/<prefix>] [--target ...] [options]

What to delete:
  --container images                        every blob in "images"
  --container images --prefix 2024/01/      blobs in "images" whose name starts with "2024/01/"
  --container images --prefix a/ --prefix b/ --container thumbs
                                            several prefixes, then all of "thumbs"
  --target images/2024/01/                  same as --container images --prefix 2024/01/
  Prefixes are ordinal and case-sensitive. A --prefix applies to the --container before it.

Options:
  --apply              actually delete (default is a dry run that changes nothing)
  --account <name>     only match this storage account (default: any account)
  --blob-port <port>   Azurite blob port to check before applying (default 10000)
  --samples <n>        sample blob names to print per target (default 5)
  --no-backup          skip the backup copy (not recommended)
  -h, --help           show this help`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {
    location: null,
    targets: [],
    apply: false,
    account: null,
    blobPort: 10000,
    samples: 5,
    backup: true,
  };
  const value = (i, name) => {
    if (i + 1 >= argv.length) throw new UsageError(`${name} needs a value`);
    return argv[i + 1];
  };
  // The --container currently collecting --prefix values.
  let group = null;
  const endGroup = () => {
    if (!group) return;
    if (group.prefixes.length === 0) group.prefixes.push("");
    for (const prefix of group.prefixes) opts.targets.push({ container: group.container, prefix });
    group = null;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--location":
      case "-l":
        opts.location = value(i++, a);
        break;
      case "--container":
      case "-c":
        endGroup();
        group = { container: checkContainer(value(i++, a)), prefixes: [] };
        break;
      case "--prefix":
      case "-p":
        if (!group) throw new UsageError("--prefix must come after the --container it belongs to");
        group.prefixes.push(value(i++, a));
        break;
      case "--target":
      case "-t":
        opts.targets.push(parseTarget(value(i++, a)));
        break;
      case "--apply":
        opts.apply = true;
        break;
      case "--account":
        opts.account = value(i++, a);
        break;
      case "--blob-port":
        opts.blobPort = parseInt(value(i++, a), 10);
        if (!(opts.blobPort > 0 && opts.blobPort < 65536)) throw new UsageError("bad --blob-port");
        break;
      case "--samples":
        opts.samples = parseInt(value(i++, a), 10);
        if (!(opts.samples >= 0)) throw new UsageError("bad --samples");
        break;
      case "--no-backup":
        opts.backup = false;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${a}`);
    }
  }
  endGroup();
  if (opts.help) return opts;
  if (!opts.location) throw new UsageError("--location is required");
  if (opts.targets.length === 0) throw new UsageError("at least one --container (or --target) is required");
  return opts;
}

function checkContainer(name, context = "") {
  if (!/^[a-z0-9$][a-z0-9-]{1,62}$/.test(name)) {
    throw new UsageError(`"${name}" is not a valid container name${context}`);
  }
  return name;
}

// "container/prefix" -> {container, prefix}. Container names can't contain "/",
// so everything after the first "/" is the prefix, verbatim.
function parseTarget(s) {
  const slash = s.indexOf("/");
  const container = checkContainer(slash < 0 ? s : s.slice(0, slash), ` (target "${s}")`);
  const prefix = slash < 0 ? "" : s.slice(slash + 1);
  return { container, prefix };
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(2)} ${units[i]} (${n.toLocaleString("en-US")} bytes)`;
}

function readLokiFile(file) {
  const text = fs.readFileSync(file, "utf8");
  return JSON.parse(text);
}

function getCollection(db, name, file) {
  const coll = (db.collections || []).find((c) => c.name === name);
  if (!coll) throw new Error(`${path.basename(file)} has no ${name} collection`);
  if (!Array.isArray(coll.data)) throw new Error(`${name} in ${path.basename(file)} has no data array`);
  return coll;
}

// Every extent id a blob or uncommitted block points at. Mirrors Azurite's
// BlobReferredExtentsAsyncIterator, which is what its GC uses for "mark".
function referencedExtents(blobs, blocks) {
  const ids = new Set();
  for (const b of blobs) {
    for (const blk of b.committedBlocksInOrder || []) if (blk.persistency) ids.add(blk.persistency.id);
    for (const r of b.pageRangesInOrder || []) if (r.persistency) ids.add(r.persistency.id);
    if (b.persistency) ids.add(b.persistency.id);
  }
  for (const blk of blocks) if (blk.persistency) ids.add(blk.persistency.id);
  return ids;
}

// Rebuild idIndex and every binary index of a raw (serialized) Loki collection
// after its data array changed. Uses LokiJS's own Collection.ensureIndex so the
// sort order is exactly what LokiJS itself would produce.
//
// Leaving the indices as {dirty: true, values: []} is NOT enough: Azurite's
// collections have adaptiveBinaryIndices = true, and in that mode LokiJS's
// Resultset.find() uses binaryIndices[prop].values without ever checking the
// dirty flag, so every indexed lookup (container, name, ...) would return nothing.
function rebuildIndexes(rawColl) {
  const ids = rawColl.data.map((d) => d.$loki);
  for (let i = 1; i < ids.length; i++) {
    // Collection.get() binary-searches idIndex, so it must be ascending.
    if (!(ids[i] > ids[i - 1])) {
      throw new Error(`${rawColl.name}: $loki ids are not strictly ascending in data order; refusing to edit`);
    }
  }
  rawColl.idIndex = ids;

  const names = Object.keys(rawColl.binaryIndices || {});
  if (names.length > 0) {
    const tmp = new Loki.Collection(rawColl.name, { adaptiveBinaryIndices: false, disableMeta: true });
    tmp.data = rawColl.data;
    for (const prop of names) {
      tmp.ensureIndex(prop, true);
      const idx = tmp.binaryIndices[prop];
      rawColl.binaryIndices[prop] = { name: prop, dirty: false, values: idx.values };
    }
  }
  rawColl.dirty = true;
}

function describeIndexHealth(rawColl) {
  const out = [];
  if (Array.isArray(rawColl.idIndex) && rawColl.idIndex.length !== rawColl.data.length) {
    out.push(`idIndex has ${rawColl.idIndex.length} entries for ${rawColl.data.length} docs`);
  }
  for (const [prop, idx] of Object.entries(rawColl.binaryIndices || {})) {
    if (idx && Array.isArray(idx.values) && idx.values.length !== rawColl.data.length) {
      out.push(`binary index "${prop}" has ${idx.values.length} entries for ${rawColl.data.length} docs`);
    }
  }
  return out;
}

// ---- Azurite-running checks -------------------------------------------------

function listProcesses() {
  if (process.platform !== "win32") {
    const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        return m && { pid: +m[1], ppid: +m[2], name: path.basename(m[3].split(" ")[0]), cmd: m[3] };
      })
      .filter(Boolean);
  }
  const script =
    "Get-CimInstance Win32_Process | Where-Object ProcessId -ne $PID | " +
    "Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const rows = JSON.parse(out || "[]");
  return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
    pid: r.ProcessId,
    ppid: r.ParentProcessId,
    name: r.Name || "",
    cmd: r.CommandLine || "",
  }));
}

function findAzuriteProcesses() {
  const procs = listProcesses();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  // Exclude ourselves and whatever launched us (the PowerShell wrapper, a
  // terminal whose command line mentions this tool, ...).
  const ancestors = new Set();
  for (let pid = process.pid; pid && !ancestors.has(pid); pid = byPid.get(pid) && byPid.get(pid).ppid) {
    ancestors.add(pid);
  }
  return procs.filter(
    (p) =>
      !ancestors.has(p.pid) &&
      (/^azurite/i.test(p.name) || /azurite(?!-delete)/i.test(p.cmd))
  );
}

function portOpen(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (open) => {
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

async function assertAzuriteNotRunning(port) {
  const problems = [];
  for (const p of findAzuriteProcesses()) {
    problems.push(`process ${p.pid} ${p.name}: ${p.cmd}`);
  }
  for (const host of ["127.0.0.1", "::1"]) {
    if (await portOpen(host, port)) problems.push(`something is listening on ${host}:${port} (Azurite blob port)`);
  }
  if (problems.length > 0) {
    throw new Error(
      "Azurite appears to be running. Stop it first: it keeps the database in memory and " +
        "autosaves every 5 seconds, which would overwrite this edit.\n  " +
        problems.join("\n  ")
    );
  }
}

// ---- main -------------------------------------------------------------------

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writeAtomic(file, text) {
  const tmp = `${file}.azurite-delete.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, text, null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

async function run(opts) {
  const location = path.resolve(opts.location);
  const blobDbPath = path.join(location, BLOB_DB);
  const extentDbPath = path.join(location, EXTENT_DB);
  if (!fs.existsSync(blobDbPath)) throw new Error(`${blobDbPath} not found; is this an Azurite folder?`);

  if (opts.apply) await assertAzuriteNotRunning(opts.blobPort);

  const statBefore = fs.statSync(blobDbPath);
  console.log(`Reading ${blobDbPath} (${formatBytes(statBefore.size)})`);
  const db = readLokiFile(blobDbPath);
  const blobs = getCollection(db, BLOBS, blobDbPath);
  const blocks = getCollection(db, BLOCKS, blobDbPath);
  const containers = getCollection(db, CONTAINERS, blobDbPath);
  console.log(`  ${blobs.data.length.toLocaleString("en-US")} blobs, ${blocks.data.length.toLocaleString("en-US")} uncommitted blocks`);
  for (const c of [blobs, blocks]) {
    if (Array.isArray(c.DynamicViews) && c.DynamicViews.length > 0) {
      throw new Error(`${c.name} has dynamic views, which this tool does not know how to update`);
    }
    for (const w of describeIndexHealth(c)) console.log(`  note: ${c.name} ${w} (will be rebuilt on --apply)`);
  }

  const accountOk = (acct) => opts.account === null || acct === opts.account;
  const blobMatches = (b, t) => b.containerName === t.container && typeof b.name === "string" && b.name.startsWith(t.prefix);
  const blockMatches = (k, t) => k.containerName === t.container && typeof k.blobName === "string" && k.blobName.startsWith(t.prefix);

  const deleteBlob = new Set();
  const deleteBlock = new Set();
  console.log(opts.apply ? "\nDeleting:" : "\nDry run (nothing will be changed; pass --apply to delete):");
  for (const t of opts.targets) {
    const label = `${t.container}/${t.prefix}`;
    const containerKnown = containers.data.some((c) => c.name === t.container && accountOk(c.accountName));
    let n = 0, bytes = 0, snapshots = 0, uncommitted = 0;
    const samples = [];
    for (const b of blobs.data) {
      if (!accountOk(b.accountName) || !blobMatches(b, t)) continue;
      deleteBlob.add(b);
      n++;
      bytes += (b.properties && b.properties.contentLength) || 0;
      if (b.snapshot) snapshots++;
      if (b.isCommitted === false) uncommitted++;
      if (samples.length < opts.samples) samples.push(b.snapshot ? `${b.name} (snapshot ${b.snapshot})` : b.name);
    }
    let kn = 0, kbytes = 0;
    for (const k of blocks.data) {
      if (!accountOk(k.accountName) || !blockMatches(k, t)) continue;
      deleteBlock.add(k);
      kn++;
      kbytes += k.size || (k.persistency && k.persistency.count) || 0;
    }
    console.log(`\n  ${label}${t.prefix === "" ? "  (whole container)" : ""}`);
    if (!containerKnown) console.log(`    warning: no container named "${t.container}" exists`);
    if (n === 0) printTargetHints(t, label, containers.data, blobs.data, accountOk, containerKnown);
    let detail = [];
    if (snapshots) detail.push(`${snapshots} snapshots`);
    if (uncommitted) detail.push(`${uncommitted} with no committed content yet`);
    console.log(`    blobs:              ${n.toLocaleString("en-US")}${detail.length ? ` (incl. ${detail.join(", ")})` : ""}, ${formatBytes(bytes)}`);
    console.log(`    uncommitted blocks: ${kn.toLocaleString("en-US")}, ${formatBytes(kbytes)}`);
    for (const s of samples) console.log(`      ${s}`);
    if (n > samples.length && samples.length > 0) console.log(`      ...`);
  }

  const keptBlobs = blobs.data.filter((b) => !deleteBlob.has(b));
  const keptBlocks = blocks.data.filter((k) => !deleteBlock.has(k));
  const totalBytes = [...deleteBlob].reduce((s, b) => s + ((b.properties && b.properties.contentLength) || 0), 0);
  console.log(
    `\nTotal: ${deleteBlob.size.toLocaleString("en-US")} blobs (${formatBytes(totalBytes)}) and ` +
      `${deleteBlock.size.toLocaleString("en-US")} uncommitted blocks` +
      `; ${keptBlobs.length.toLocaleString("en-US")} blobs remain.`
  );

  reportExtents(location, extentDbPath, blobs.data, blocks.data, keptBlobs, keptBlocks);

  if (!opts.apply) {
    console.log("\nDry run only. Re-run with --apply (Azurite stopped) to delete.");
    return;
  }
  if (deleteBlob.size === 0 && deleteBlock.size === 0) {
    console.log("\nNothing matched; database left untouched.");
    return;
  }

  if (opts.backup) {
    const dir = path.join(location, BACKUP_DIR, timestamp());
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(blobDbPath, path.join(dir, BLOB_DB));
    if (fs.existsSync(extentDbPath)) fs.copyFileSync(extentDbPath, path.join(dir, EXTENT_DB));
    console.log(`\nBacked up metadata to ${dir}`);
  }

  blobs.data = keptBlobs;
  blocks.data = keptBlocks;
  rebuildIndexes(blobs);
  rebuildIndexes(blocks);
  // maxId is deliberately left alone so $loki ids are never reused.
  const text = JSON.stringify(db);

  // Last-moment guard: if Azurite started (or anything rewrote the file) while
  // we were working, don't clobber it.
  await assertAzuriteNotRunning(opts.blobPort);
  const statNow = fs.statSync(blobDbPath);
  if (statNow.mtimeMs !== statBefore.mtimeMs || statNow.size !== statBefore.size) {
    throw new Error(`${blobDbPath} changed while this tool was running; nothing written`);
  }
  writeAtomic(blobDbPath, text);
  console.log(`Wrote ${blobDbPath} (${formatBytes(Buffer.byteLength(text))})`);
  console.log(
    "Done. Start Azurite again: its blob GC runs at startup and then every 10 minutes, deleting extent " +
      "files under __blobstorage__ that nothing references and that weren't written in the last 10 minutes."
  );
}

// A target matched nothing. Usually the "container" is really a folder inside
// some other container, so look for the whole target string as a blob-name
// prefix everywhere, and list the containers that do exist.
function printTargetHints(t, label, containers, blobs, accountOk, containerKnown) {
  const counts = new Map();
  for (const c of containers) if (accountOk(c.accountName)) counts.set(c.name, 0);
  const elsewhere = new Map();
  for (const b of blobs) {
    if (!accountOk(b.accountName)) continue;
    counts.set(b.containerName, (counts.get(b.containerName) || 0) + 1);
    if (typeof b.name === "string" && b.name.startsWith(label)) {
      elsewhere.set(b.containerName, (elsewhere.get(b.containerName) || 0) + 1);
    }
  }
  for (const [container, n] of elsewhere) {
    console.log(`    hint: ${n.toLocaleString("en-US")} blobs in container "${container}" start with "${label}"; try container "${container}" with prefix "${label}"`);
  }
  if (!containerKnown) {
    console.log(`    containers: ${[...counts].sort().map(([c, n]) => `${c} (${n.toLocaleString("en-US")})`).join(", ") || "(none)"}`);
  }
}

function reportExtents(location, extentDbPath, allBlobs, allBlocks, keptBlobs, keptBlocks) {
  if (!fs.existsSync(extentDbPath)) {
    console.log(`\n(${EXTENT_DB} not found; skipping extent report)`);
    return;
  }
  const extents = getCollection(readLokiFile(extentDbPath), EXTENTS, extentDbPath).data;
  const before = referencedExtents(allBlobs, allBlocks);
  const after = referencedExtents(keptBlobs, keptBlocks);
  const sizeOf = (e) => {
    const file = path.join(location, EXTENT_DIR, e.id);
    try {
      return fs.statSync(file).size;
    } catch {
      return e.size || 0;
    }
  };
  let freedN = 0, freedBytes = 0, alreadyN = 0, alreadyBytes = 0, keptN = 0;
  for (const e of extents) {
    if (after.has(e.id)) {
      keptN++;
      continue;
    }
    if (before.has(e.id)) {
      freedN++;
      freedBytes += sizeOf(e);
    } else {
      alreadyN++;
      alreadyBytes += sizeOf(e);
    }
  }
  console.log(`\nExtent files (${extents.length} total, ${EXTENT_DIR}):`);
  console.log(`  becoming unreferenced: ${freedN}, ${formatBytes(freedBytes)}`);
  if (alreadyN) console.log(`  already unreferenced (pending Azurite GC): ${alreadyN}, ${formatBytes(alreadyBytes)}`);
  console.log(`  still referenced: ${keptN} (space held by deleted blobs inside these is not reclaimed)`);
  // Blobs pointing at extents the extent DB doesn't list. Not caused by this
  // tool; such blobs most likely fail to download in Azurite already.
  const known = new Set(extents.map((e) => e.id));
  const missing = [...after].filter((id) => !known.has(id));
  if (missing.length) {
    const onDisk = missing.filter((id) => fs.existsSync(path.join(location, EXTENT_DIR, id))).length;
    console.log(`  note: remaining blobs reference ${missing.length} extent(s) not listed in ${EXTENT_DB} (${onDisk} of them exist on disk): ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""}`);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    throw e;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  try {
    await run(opts);
  } catch (e) {
    console.error(`\nerror: ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parseTarget, rebuildIndexes, referencedExtents };
