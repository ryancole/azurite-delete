"use strict";

// Offline compaction of Azurite's extent files.
//
// Azurite packs blob bytes into shared extent files and only ever deletes an
// extent once nothing references it; it never reclaims dead bytes inside a
// file that still holds live data. This copies the live byte ranges of
// mostly-dead extents into new, packed extents and repoints every reference.
// The old extents become unreferenced, and Azurite's GC deletes them on its
// next pass (at startup, as they are old).
//
// References can overlap: page-range splits point at sub-ranges of an earlier
// write, and snapshots and copies share ranges. So live ranges are merged per
// extent and each merged segment is moved once; every reference is remapped by
// its offset within the segment that contains it.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Same cap Azurite uses before starting a new extent (DEFAULT_MAX_EXTENT_SIZE).
const MAX_EXTENT_SIZE = 64 * 1024 * 1024;
const COPY_CHUNK = 8 * 1024 * 1024;

// Every {id, offset, count} object that points into an extent. Mirrors
// Azurite's BlobReferredExtentsAsyncIterator.
function forEachReference(blobs, blocks, fn) {
  for (const b of blobs) {
    for (const blk of b.committedBlocksInOrder || []) if (blk.persistency) fn(blk.persistency);
    for (const r of b.pageRangesInOrder || []) if (r.persistency) fn(r.persistency);
    if (b.persistency) fn(b.persistency);
  }
  for (const k of blocks) if (k.persistency) fn(k.persistency);
}

function mergeRanges(ranges) {
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of ranges) {
    const last = out[out.length - 1];
    if (last && s <= last.end) last.end = Math.max(last.end, e);
    else out.push({ start: s, end: e });
  }
  return out;
}

// Work out per-extent live bytes and which extents to rewrite.
// minDead is a fraction: extents with at least that share of dead bytes are
// compacted (0 = any dead bytes at all).
function planCompaction(location, extentDocs, blobs, blocks, extentDir) {
  const ranges = new Map();
  const problems = [];
  forEachReference(blobs, blocks, (p) => {
    if (!ranges.has(p.id)) ranges.set(p.id, []);
    ranges.get(p.id).push([p.offset, p.offset + p.count]);
  });
  const extents = [];
  for (const e of extentDocs) {
    const refs = ranges.get(e.id);
    if (!refs) continue; // unreferenced: Azurite's GC deletes it, nothing to move
    let size;
    try {
      size = fs.statSync(path.join(location, extentDir, e.id)).size;
    } catch {
      problems.push(`extent ${e.id} is referenced but its file is missing; left alone`);
      continue;
    }
    const segments = mergeRanges(refs);
    if (segments[segments.length - 1].end > size) {
      problems.push(`extent ${e.id} is referenced past its end (${size} bytes); left alone`);
      continue;
    }
    const live = segments.reduce((s, g) => s + (g.end - g.start), 0);
    extents.push({ id: e.id, size, live, dead: size - live, segments });
  }
  return { extents, problems };
}

function selectExtents(plan, minDead) {
  // An extent that is already a single packed segment gains nothing.
  return plan.extents.filter((x) => x.dead > 0 && x.size > 0 && x.dead / x.size >= minDead);
}

function summarize(selected) {
  return selected.reduce(
    (s, x) => ({ files: s.files + 1, copy: s.copy + x.live, freed: s.freed + x.dead }),
    { files: 0, copy: 0, freed: 0 }
  );
}

function sha(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readRange(fd, start, length) {
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, start + done);
    if (n === 0) throw new Error(`unexpected end of file reading ${length} bytes at ${start}`);
    done += n;
  }
  return buf;
}

// Copy the live segments of the selected extents into new extent files.
// Returns the new extent docs and a remap function; nothing references the new
// files until the caller rewrites the metadata. On failure, removes what it wrote.
function copySegments(location, selected, extentDir, log) {
  const dir = path.join(location, extentDir);
  const created = [];
  const newExtents = [];
  const placement = new Map(); // old extent id -> segments with {newId, newStart}
  let out = null;

  const finish = () => {
    if (!out) return;
    fs.fsyncSync(out.fd);
    fs.closeSync(out.fd);
    // Verify: re-read every segment from the new file and compare hashes.
    const fd = fs.openSync(out.file, "r");
    try {
      for (const v of out.verify) {
        const got = sha(readRange(fd, v.start, v.length));
        if (got !== v.hash) throw new Error(`verification failed for new extent ${out.id} at offset ${v.start}`);
      }
    } finally {
      fs.closeSync(fd);
    }
    const now = Date.now();
    newExtents.push({ id: out.id, locationId: "Default", path: out.id, size: out.size, lastModifiedInMS: now, LastModifyInMS: now });
    out = null;
  };

  const open = () => {
    const id = crypto.randomUUID();
    const file = path.join(dir, id);
    const fd = fs.openSync(file, "wx");
    created.push(file);
    out = { id, file, fd, size: 0, verify: [] };
  };

  try {
    let copied = 0;
    const total = selected.reduce((s, x) => s + x.live, 0);
    let lastReport = Date.now();
    for (const x of selected) {
      const src = fs.openSync(path.join(dir, x.id), "r");
      try {
        const placed = [];
        for (const g of x.segments) {
          const len = g.end - g.start;
          if (!out || (out.size > 0 && out.size + len > MAX_EXTENT_SIZE)) {
            finish();
            open();
          }
          const newStart = out.size;
          const hash = crypto.createHash("sha256");
          for (let off = 0; off < len; off += COPY_CHUNK) {
            const n = Math.min(COPY_CHUNK, len - off);
            const buf = readRange(src, g.start + off, n);
            hash.update(buf);
            let w = 0;
            while (w < n) w += fs.writeSync(out.fd, buf, w, n - w, newStart + off + w);
          }
          out.size += len;
          out.verify.push({ start: newStart, length: len, hash: hash.digest("hex") });
          placed.push({ start: g.start, end: g.end, newId: out.id, newStart });
          copied += len;
          if (log && Date.now() - lastReport > 5000) {
            log(`  copied ${(copied / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB`);
            lastReport = Date.now();
          }
        }
        placement.set(x.id, placed);
      } finally {
        fs.closeSync(src);
      }
    }
    finish();
  } catch (e) {
    if (out) {
      try {
        fs.closeSync(out.fd);
      } catch {}
    }
    for (const f of created) fs.rmSync(f, { force: true });
    throw e;
  }

  const remap = (p) => {
    const segs = placement.get(p.id);
    if (!segs) return false;
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].start <= p.offset) lo = mid;
      else hi = mid - 1;
    }
    const g = segs[lo];
    if (!(g.start <= p.offset && p.offset + p.count <= g.end)) {
      throw new Error(`internal error: reference ${p.id}@${p.offset}+${p.count} not inside a copied segment`);
    }
    p.offset = g.newStart + (p.offset - g.start);
    p.id = g.newId;
    return true;
  };

  return { newExtents, remap, created };
}

module.exports = { forEachReference, mergeRanges, planCompaction, selectExtents, summarize, copySegments };
