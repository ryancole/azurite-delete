"use strict";
// End-to-end test against a throwaway Azurite store. Run with `npm test`.
// Needs the dev dependencies (azurite, @azure/storage-blob).

const fs = require("fs");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const assert = require("assert/strict");
const { spawn, spawnSync } = require("child_process");
const Loki = require("lokijs");
const { BlobServiceClient } = require("@azure/storage-blob");

const ROOT = path.join(__dirname, "..");
const TOOL = path.join(ROOT, "src", "azurite-delete.js");
const WORK = path.join(__dirname, ".work", String(Date.now()));
const LOC = path.join(WORK, "azurite");
const PORT = 20110;
const OTHER_PORT = 20120;
const BLOB_DB = path.join(LOC, "__azurite_db_blob__.json");
const EXTENT_DIR = path.join(LOC, "__blobstorage__");
const KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

const children = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const fileHash = (f) => sha(fs.readFileSync(f));
const rand = (n) => crypto.randomBytes(n);
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

function client(port = PORT) {
  return BlobServiceClient.fromConnectionString(
    `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${KEY};` +
      `BlobEndpoint=http://127.0.0.1:${port}/devstoreaccount1;`
  );
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

async function startAzurite(port = PORT, location = LOC) {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, "azurite-child.js"), "--location", location, "--blobPort", String(port), "--skipApiVersionCheck", "--loose"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  children.add(child);
  child.once("exit", () => children.delete(child));
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (await portOpen(port)) return { child, log: () => log };
    if (child.exitCode !== null) break;
    await sleep(200);
  }
  throw new Error(`Azurite didn't start:\n${log}`);
}

async function stopAzurite(az) {
  const exited = new Promise((r) => az.child.once("exit", r));
  az.child.stdin.write("stop\n");
  const t = setTimeout(() => az.child.kill(), 20000);
  await exited;
  clearTimeout(t);
}

function runTool(...args) {
  const r = spawnSync(process.execPath, [TOOL, "--location", LOC, "--blob-port", String(PORT), ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

async function streamToBuffer(s) {
  const chunks = [];
  for await (const c of s) chunks.push(c);
  return Buffer.concat(chunks);
}

// key -> {container, name, snapshot, hash}
const expected = new Map();
const keyOf = (c, n, s = "") => `${c}/${n}@${s}`;
function remember(container, name, buf, snapshot = "") {
  expected.set(keyOf(container, name, snapshot), { container, name, snapshot, hash: sha(buf) });
}

async function uploadSmall(cc, name) {
  const buf = rand(randInt(1, 5000));
  await cc.getBlockBlobClient(name).uploadData(buf);
  remember(cc.containerName, name, buf);
}

async function uploadBlocks(cc, name, nBlocks) {
  const bb = cc.getBlockBlobClient(name);
  const parts = [];
  const ids = [];
  for (let i = 0; i < nBlocks; i++) {
    const p = rand(randInt(1000, 64 * 1024));
    const id = Buffer.from(`block-${String(i).padStart(6, "0")}`).toString("base64");
    await bb.stageBlock(id, p, p.length);
    parts.push(p);
    ids.push(id);
  }
  await bb.commitBlockList(ids);
  remember(cc.containerName, name, Buffer.concat(parts));
}

async function stageOnly(cc, name) {
  const p = rand(2000);
  await cc.getBlockBlobClient(name).stageBlock(Buffer.from("uncommitted-1").toString("base64"), p, p.length);
}

async function uploadPage(cc, name) {
  const pb = cc.getPageBlobClient(name);
  await pb.create(2048);
  const p = rand(512);
  await pb.uploadPages(p, 512, 512);
  const full = Buffer.alloc(2048);
  p.copy(full, 512);
  remember(cc.containerName, name, full);
}

async function uploadAppend(cc, name) {
  const ab = cc.getAppendBlobClient(name);
  await ab.create();
  const a = rand(700), b = rand(1300);
  await ab.appendBlock(a, a.length);
  await ab.appendBlock(b, b.length);
  remember(cc.containerName, name, Buffer.concat([a, b]));
}

async function snapshot(cc, name) {
  const { snapshot } = await cc.getBlobClient(name).createSnapshot();
  const base = expected.get(keyOf(cc.containerName, name));
  expected.set(keyOf(cc.containerName, name, snapshot), { ...base, snapshot });
}

async function listNames(cc, prefix) {
  const out = [];
  for await (const b of cc.listBlobsFlat({ prefix, includeSnapshots: true, includeUncommitedBlobs: true })) out.push(b.name);
  return out;
}

const isDeleted = (e) =>
  (e.container === "ctr1" && e.name.startsWith("del/")) || (e.container === "ctr2" && e.name.startsWith("x/")) || e.container === "ctr3";

// Every extent id referenced anywhere under the given docs. Deliberately a
// generic walk rather than the tool's own logic.
function extentIdsIn(docs) {
  const ids = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === "object") {
      if (o.persistency && typeof o.persistency.id === "string") ids.add(o.persistency.id);
      Object.values(o).forEach(walk);
    }
  };
  walk(docs);
  return ids;
}

function loadRaw() {
  return JSON.parse(fs.readFileSync(BLOB_DB, "utf8"));
}

function checkIndexes(raw) {
  // Load exactly like Azurite does, then compare each index with a forced rebuild.
  const db = new Loki("check.json", { persistenceMethod: "memory" });
  db.loadJSONObject(raw);
  for (const name of ["$BLOBS_COLLECTION$", "$BLOCKS_COLLECTION$"]) {
    const coll = db.getCollection(name);
    assert.equal(coll.adaptiveBinaryIndices, true, `${name} uses adaptive indices`);
    const rawColl = raw.collections.find((c) => c.name === name);
    // LokiJS itself often saves idIndex as null (rebuilt lazily on load).
    if (rawColl.idIndex !== null) {
      assert.deepEqual(rawColl.idIndex, rawColl.data.map((d) => d.$loki), `${name} idIndex`);
    }
    for (const prop of Object.keys(coll.binaryIndices)) {
      const stored = coll.binaryIndices[prop].values.slice();
      assert.equal(coll.binaryIndices[prop].dirty, false);
      coll.ensureIndex(prop, true);
      assert.deepEqual(stored, coll.binaryIndices[prop].values, `${name}.${prop} index`);
    }
    assert.deepEqual(coll.checkAllIndexes(), [], `${name} checkAllIndexes`);
  }
}

async function verifyContents(svc, label) {
  let checked = 0;
  for (const e of expected.values()) {
    const bc = svc.getContainerClient(e.container).getBlobClient(e.name);
    const target = e.snapshot ? bc.withSnapshot(e.snapshot) : bc;
    if (isDeleted(e)) {
      assert.equal(await target.exists(), false, `${label}: ${e.container}/${e.name} ${e.snapshot} should be gone`);
    } else {
      const body = await streamToBuffer((await target.download()).readableStreamBody);
      assert.equal(sha(body), e.hash, `${label}: ${e.container}/${e.name} ${e.snapshot} bytes`);
      checked++;
    }
  }
  return checked;
}

function step(msg) {
  console.log(`\n=== ${msg}`);
}

async function main() {
  fs.mkdirSync(LOC, { recursive: true });
  console.log(`Work folder: ${WORK}`);

  step("Phase 1: populate (shared extents)");
  let az = await startAzurite();
  let svc = client();
  const c1 = svc.getContainerClient("ctr1");
  const c2 = svc.getContainerClient("ctr2");
  const c3 = svc.getContainerClient("ctr3");
  for (const c of [c1, c2, c3]) await c.create();
  const jobs = [];
  for (let i = 0; i < 60; i++) jobs.push(uploadSmall(c1, `keep/small/${i}.bin`), uploadSmall(c1, `del/a/${i}.bin`));
  for (let i = 0; i < 15; i++) jobs.push(uploadBlocks(c1, `keep/blocks/${i}.bin`, 3), uploadBlocks(c1, `del/b/${i}.bin`, 4));
  for (let i = 0; i < 50; i++) jobs.push(uploadSmall(c2, `x/${i}.bin`), uploadSmall(c2, `y/${i}.bin`));
  for (let i = 0; i < 20; i++) jobs.push(uploadSmall(c3, `${i % 3}/${i}.bin`));
  jobs.push(uploadPage(c1, "keep/page"), uploadPage(c1, "del/page"));
  jobs.push(uploadAppend(c1, "keep/append"), uploadAppend(c1, "del/append"));
  jobs.push(uploadBlocks(c2, "y/big.bin", 6), uploadBlocks(c2, "x/big.bin", 6));
  await Promise.all(jobs);
  await snapshot(c1, "keep/small/0.bin");
  await snapshot(c1, "del/a/0.bin");
  await stageOnly(c1, "del/uncommitted/only-staged");
  await stageOnly(c1, "keep/uncommitted/only-staged");
  await stageOnly(c1, "keep/blocks/0.bin"); // committed blob with an extra pending block
  await stageOnly(c1, "del/b/0.bin");
  await stopAzurite(az);

  step("Phase 2: populate (only deletable blobs, so their extents become unreferenced)");
  az = await startAzurite();
  svc = client();
  const late = [];
  for (let i = 0; i < 40; i++) late.push(uploadBlocks(svc.getContainerClient("ctr1"), `del/late/${i}.bin`, 2));
  for (let i = 0; i < 40; i++) late.push(uploadSmall(svc.getContainerClient("ctr2"), `x/late/${i}.bin`));
  await Promise.all(late);
  console.log(`  ${expected.size} blobs/snapshots recorded`);

  step("Refuses --apply while Azurite listens on the blob port");
  let before = fileHash(BLOB_DB);
  let r = runTool("--target", "ctr1/del/", "--apply");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Azurite appears to be running/);
  assert.match(r.out, new RegExp(`listening on 127\\.0\\.0\\.1:${PORT}`));
  assert.equal(fs.existsSync(path.join(LOC, "azurite-delete-backups")), false);
  await stopAzurite(az);

  step("Refuses --apply when an Azurite process runs, even on another port");
  const otherLoc = path.join(WORK, "other");
  const other = await startAzurite(OTHER_PORT, otherLoc);
  before = fileHash(BLOB_DB);
  r = runTool("--target", "ctr1/del/", "--apply");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /process \d+ .*azurite-child/);
  assert.equal(fileHash(BLOB_DB), before);
  await stopAzurite(other);

  step("Dry run changes nothing");
  before = fileHash(BLOB_DB);
  const mtime = fs.statSync(BLOB_DB).mtimeMs;
  r = runTool("--target", "ctr1/del/", "--target", "ctr2/x/", "--target", "ctr3");
  assert.equal(r.code, 0, r.out);
  console.log(r.out);
  assert.match(r.out, /Dry run/);
  assert.equal(fileHash(BLOB_DB), before);
  assert.equal(fs.statSync(BLOB_DB).mtimeMs, mtime);

  step("Prefix matching nothing (and unknown container) leaves the database alone");
  r = runTool("--target", "ctr1/nothing-here/", "--target", "nosuchcontainer", "--apply");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Nothing matched/);
  assert.match(r.out, /no container named "nosuchcontainer"/);
  assert.equal(fileHash(BLOB_DB), before);
  assert.equal(fs.existsSync(path.join(LOC, "azurite-delete-backups")), false);

  step("Apply: ctr1/del/ (+ overlapping ctr1/del/a/), ctr2/x/, whole ctr3");
  const raw = loadRaw();
  const blobsBefore = raw.collections.find((c) => c.name === "$BLOBS_COLLECTION$").data;
  const blocksBefore = raw.collections.find((c) => c.name === "$BLOCKS_COLLECTION$").data;
  const docDeleted = (d) => isDeleted({ container: d.containerName, name: "blobName" in d ? d.blobName : d.name });
  const keptIds = extentIdsIn([blobsBefore.filter((d) => !docDeleted(d)), blocksBefore.filter((d) => !docDeleted(d))]);
  const allExtentFiles = new Set(fs.readdirSync(EXTENT_DIR));
  const expectFreed = [...allExtentFiles].filter((id) => !keptIds.has(id));
  console.log(`  ${allExtentFiles.size} extent files; ${expectFreed.length} should be freed`);
  assert.ok(expectFreed.length > 0, "test setup should leave some extents fully unreferenced");
  const expectBlobDocs = blobsBefore.filter((d) => !docDeleted(d)).length;
  const expectBlockDocs = blocksBefore.filter((d) => !docDeleted(d)).length;
  const maxIdBefore = raw.collections.find((c) => c.name === "$BLOBS_COLLECTION$").maxId;

  r = runTool("--target", "ctr1/del/", "--target", "ctr1/del/a/", "--target", "ctr2/x/", "--target", "ctr3", "--apply");
  console.log(r.out);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`becoming unreferenced: ${expectFreed.length},`));
  const backups = fs.readdirSync(path.join(LOC, "azurite-delete-backups"));
  assert.equal(backups.length, 1);
  assert.equal(fileHash(path.join(LOC, "azurite-delete-backups", backups[0], "__azurite_db_blob__.json")), before);
  assert.ok(fs.existsSync(path.join(LOC, "azurite-delete-backups", backups[0], "__azurite_db_blob_extent__.json")));

  const after = loadRaw();
  const blobsAfter = after.collections.find((c) => c.name === "$BLOBS_COLLECTION$");
  const blocksAfter = after.collections.find((c) => c.name === "$BLOCKS_COLLECTION$");
  assert.equal(blobsAfter.data.length, expectBlobDocs);
  assert.equal(blocksAfter.data.length, expectBlockDocs);
  assert.equal(blobsAfter.maxId, maxIdBefore);
  assert.ok(blocksAfter.data.length > 0, "kept uncommitted blocks remain");
  assert.ok(!blobsAfter.data.some(docDeleted));
  assert.ok(!blocksAfter.data.some(docDeleted));
  assert.ok(!fs.readFileSync(BLOB_DB, "utf8").includes("\n"), "compact JSON");
  checkIndexes(after);
  for (const id of expectFreed) assert.ok(fs.existsSync(path.join(EXTENT_DIR, id)), "extents untouched by the tool itself");

  // Azurite's GC ignores extents modified in the last 10 minutes
  // (DEFAULT_EXTENT_GC_PROTECT_TIME_IN_MS). A real store's extents are old; age
  // this one's so the startup GC pass considers every extent, referenced or not.
  const extentDb = path.join(LOC, "__azurite_db_blob_extent__.json");
  const ext = JSON.parse(fs.readFileSync(extentDb, "utf8"));
  for (const e of ext.collections.find((c) => c.name === "$EXTENTS_COLLECTION$").data) {
    e.LastModifyInMS = Date.now() - 60 * 60 * 1000;
  }
  fs.writeFileSync(extentDb, JSON.stringify(ext));

  step("Restart Azurite: deleted blobs gone, kept blobs intact");
  az = await startAzurite();
  svc = client();
  for (const [c, p] of [["ctr1", "del/"], ["ctr2", "x/"], ["ctr3", ""]]) {
    assert.deepEqual(await listNames(svc.getContainerClient(c), p), [], `listing ${c}/${p}`);
  }
  assert.ok(await svc.getContainerClient("ctr3").exists(), "emptied container still exists");
  const kept = await verifyContents(svc, "after apply");
  console.log(`  ${kept} kept blobs/snapshots verified byte-for-byte`);
  const keptList = await listNames(svc.getContainerClient("ctr1"), "keep/");
  assert.ok(keptList.includes("keep/uncommitted/only-staged"));
  const bl = await svc.getContainerClient("ctr1").getBlockBlobClient("keep/blocks/0.bin").getBlockList("uncommitted");
  assert.equal(bl.uncommittedBlocks.length, 1, "kept pending block survives");
  const del0 = svc.getContainerClient("ctr1").getBlockBlobClient("del/b/0.bin");
  assert.equal(await del0.exists(), false);

  step("Writes still work (index inserts/updates/removes after the rebuild)");
  const c1b = svc.getContainerClient("ctr1");
  const c3b = svc.getContainerClient("ctr3");
  await uploadSmall(c1b, "del/a/0.bin"); // re-create a deleted name
  await uploadBlocks(c1b, "keep/new/blocks.bin", 3);
  await uploadSmall(c1b, "keep/small/1.bin"); // overwrite a kept blob
  await uploadSmall(c3b, "fresh.bin");
  await c1b.getBlobClient("keep/small/2.bin").delete();
  expected.delete(keyOf("ctr1", "keep/small/2.bin"));
  for (const [c, n] of [["ctr1", "del/a/0.bin"], ["ctr3", "fresh.bin"]]) {
    const e = expected.get(keyOf(c, n));
    expected.delete(keyOf(c, n));
    const body = await streamToBuffer((await svc.getContainerClient(c).getBlobClient(n).download()).readableStreamBody);
    assert.equal(sha(body), e.hash, `new upload ${c}/${n}`);
  }
  assert.equal(await c1b.getBlobClient("keep/small/2.bin").exists(), false);
  await verifyContents(svc, "after new writes");

  step("Azurite GC removes the unreferenced extent files");
  let remaining;
  for (let i = 0; i < 120; i++) {
    remaining = expectFreed.filter((id) => fs.existsSync(path.join(EXTENT_DIR, id)));
    if (remaining.length === 0) break;
    await sleep(500);
  }
  assert.deepEqual(remaining, [], "freed extents deleted by GC");
  for (const id of keptIds) assert.ok(fs.existsSync(path.join(EXTENT_DIR, id)), `referenced extent ${id} kept`);
  console.log(`  ${expectFreed.length} extent files removed by Azurite; ${keptIds.size} referenced ones kept`);
  await stopAzurite(az);

  step("Restart once more (loads Azurite's own re-save of the edited DB)");
  az = await startAzurite();
  svc = client();
  await verifyContents(svc, "second restart");
  assert.deepEqual(await listNames(svc.getContainerClient("ctr1"), "del/"), ["del/a/0.bin"]);
  await stopAzurite(az);
  checkIndexes(loadRaw());

  console.log("\nALL TESTS PASSED");
  fs.rmSync(WORK, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  for (const c of children) c.kill();
  console.error(`\nWork folder kept for inspection: ${WORK}`);
  process.exit(1);
});
