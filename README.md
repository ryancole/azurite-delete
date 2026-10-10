# azurite-delete

Deletes blobs from a local [Azurite](https://github.com/Azure/Azurite) data folder by
editing its on-disk metadata directly instead of going through the HTTP API.

On a large store, deleting tens of thousands of blobs over HTTP is very slow. Azurite
runs on a single Node thread, and every write marks its in-memory LokiJS database
dirty, so the whole database gets re-serialized to one big JSON file again and again.
This tool rewrites `__azurite_db_blob__.json` once, while Azurite is stopped. On an
80k-blob, 60 MB database that takes about a second.

Verified against **Azurite 3.35.0** (the version bundled with Visual Studio 18) and
**LokiJS 1.5.12** (the version Azurite 3.35.0 resolves to).

## Usage

```powershell
# Dry run (default): counts, sizes and sample names per target. Changes nothing.
.\etc\azurite-delete.ps1 -Location C:\Users\ryan\source\repos\WhatInBox\.azurite -Target images/2024/, thumbnails

# Delete. Stop Azurite first.
.\etc\azurite-delete.ps1 -Location C:\Users\ryan\source\repos\WhatInBox\.azurite -Target images/2024/, thumbnails -Apply
```

Each `-Target` is `container` or `container/prefix`:

| Target               | Deletes                                                |
|----------------------|--------------------------------------------------------|
| `thumbnails`         | every blob in `thumbnails` (the container itself stays) |
| `images/2024/`       | blobs in `images` whose name starts with `2024/`       |
| `images/2024`        | also matches `2024-old/...`, `20240101.jpg`, ...       |

Prefix matching is ordinal and case-sensitive, like Azure's own `prefix=` listing.
Snapshots of matching blobs and uncommitted (staged) blocks of matching blob names are
deleted too.

Other options: `-Account <name>` (default: any account), `-BlobPort <port>` (default
10000, used for the "is Azurite running" check), `-Samples <n>`, `-NoBackup`.

The wrapper finds `node.exe` on PATH or, failing that, the copy inside Visual Studio
(`MSBuild\Microsoft\VisualStudio\NodeJs`). On first run it installs the one runtime
dependency (`lokijs`) with `npm ci --omit=dev`. You can also call the script directly:

```
node src\azurite-delete.js --location <folder> --target images/2024/ --target thumbnails [--apply]
```

## What `--apply` does

1. **Refuses to run while Azurite is running.** Azurite keeps the database in memory
   and autosaves it every 5 seconds, so it would overwrite the edit. The tool refuses
   if any process named `azurite*` (or whose command line mentions azurite) is running,
   or if anything listens on the blob port. It checks again just before writing, and
   aborts if the database file changed while it was working.
2. **Backs up** `__azurite_db_blob__.json` and `__azurite_db_blob_extent__.json` to
   `<location>\azurite-delete-backups\<yyyyMMdd-HHmmss>\`. To undo, stop Azurite and
   copy them back. Extent files are never touched by this tool, so that only works
   until Azurite's GC has deleted the newly unreferenced ones (see below). Delete old
   backups yourself when you no longer need them.
3. **Removes** matching docs from `$BLOBS_COLLECTION$` and `$BLOCKS_COLLECTION$`.
4. **Rebuilds the LokiJS indices** of both collections (see below).
5. **Writes** the file as compact JSON to a temp file, fsyncs it, then renames it
   over the original.

Then it reports which extent files are now unreferenced and how many bytes they hold.

## How it works, and what was verified

### Azurite's files

- `__azurite_db_blob__.json`: a serialized LokiJS database. `$BLOBS_COLLECTION$` has one
  doc per blob or snapshot. Small blobs point at their bytes with
  `persistency: {id, offset, count}`, block blobs with
  `committedBlocksInOrder[].persistency`, and page blobs with
  `pageRangesInOrder[].persistency`. `$BLOCKS_COLLECTION$` holds uncommitted blocks.
- `__azurite_db_blob_extent__.json`: LokiJS database listing the extent files.
- `__blobstorage__\<extent id>`: packed blob bytes. Many blobs share one extent file,
  so a blob is deleted by removing its metadata, never by deleting a file.
- Table and queue databases are not touched.

### Index rebuild (differs from the obvious approach)

LokiJS's `loadJSONObject` ignores the saved `idIndex` (it's rebuilt lazily, and LokiJS
often saves it as `null`). It does load `binaryIndices` as-is. Azurite's collections use
**adaptive** binary indices (`adaptiveBinaryIndices: true`). In that mode,
`Resultset.find()` uses `binaryIndices[prop].values` without checking the `dirty`
flag, and `ensureIndex()` returns early without rebuilding.

So marking the indices `{dirty: true, values: []}` and letting LokiJS rebuild them does
**not** work: after loading, every indexed lookup (`findOne({accountName,
containerName, name, snapshot})`, container listings, ...) returns nothing, and later
inserts produce one-entry indices. (Checked directly against LokiJS 1.5.12.)

Instead, the tool rebuilds each index with LokiJS's own `Collection.ensureIndex(prop,
true)` over the remaining docs and stores it with `dirty: false`, so the sort order is
exactly what LokiJS would produce. It also writes `idIndex` as the remaining `$loki`
ids in data order, after checking they're ascending (`Collection.get()`
binary-searches it). `maxId` is left alone so ids are never reused.

A side effect: if your indices were already inconsistent (the dry run prints a note
like `binary index "name" has 80047 entries for 80141 docs`), the rebuild repairs
them. Blobs that were missing from an index, and so invisible to Azurite's indexed
lookups, can show up again after the first `--apply`.

### Reclaiming disk space (Azurite's blob GC)

From `BlobGCManager`, `BlobReferredExtentsAsyncIterator` and `LokiExtentMetadataStore`
in Azurite 3.35.0:

- The GC is a mark-and-sweep. It runs once when the blob service starts and then every
  **10 minutes**. It is always on for the default (Loki) metadata store. Nothing has
  to be marked: it compares every extent in the extent DB against every
  `persistency.id` referenced by blobs (committed blocks, page ranges, small-blob
  persistency, snapshots, uncommitted blobs) and uncommitted blocks.
- It only considers extents whose `LastModifyInMS` is **more than 10 minutes old**,
  and it skips extents that are currently open for writing. Unreferenced extents in a
  long-lived store are deleted on the first pass after restart. Extents written in the
  last 10 minutes wait for a later pass.
- It deletes the file and its extent DB entry.
- An extent is freed only when **every** blob and block in it is gone. Azurite never
  compacts extents. If the deleted blobs are scattered across extents that also hold
  kept blobs, the dry run shows few or no extents "becoming unreferenced", and that
  space stays used. Blobs uploaded around the same time tend to share extents, so
  deleting by date-based prefix usually frees more.

## Notes

- **Azure Functions blob triggers:** receipts for processed blobs live in the
  `azure-webjobs-hosts` container under `blobreceipts/...`. Deleting receipts while
  keeping their blobs makes the triggers fire again for those blobs. To delete both
  blobs and their receipts, target both. To keep blobs and receipts consistent, don't
  target `azure-webjobs-hosts/blobreceipts/` on its own.
- Deleting blobs here doesn't touch any SQL database or other store that refers to them.
- Blob leases, legal holds and immutability policies are not checked. The blobs are
  removed regardless.
- Azurite's other `--location` layouts (custom `--blobStorageFolder` paths, SQL
  metadata via `AZURITE_DB`) aren't supported.

## Testing

`npm install` (dev dependencies include Azurite 3.35.0 and `@azure/storage-blob`), then
`npm test`. The end-to-end test:

- builds a throwaway store under `test\.work` with Azurite's real blob service:
  ~360 blobs across three containers, small blobs, multi-block blobs, page and append
  blobs, snapshots, staged-only blobs and pending blocks, written across two Azurite
  sessions so that some extents are shared and some hold only deletable blobs;
- checks refusal while Azurite listens on the port and while an Azurite process
  runs on another port, that a dry run doesn't modify the file, and that a prefix
  matching nothing and an unknown container leave the database alone;
- applies several overlapping targets, including a whole container (empty prefix), and
  checks the backup, the doc counts, `maxId`, compact output, and that every index
  equals a fresh LokiJS rebuild;
- restarts Azurite and checks over HTTP that deleted blobs/snapshots are gone and
  listings are empty, that every kept blob and snapshot downloads byte-identical, and
  that kept pending blocks survive;
- creates, overwrites, re-creates and deletes blobs to check that writes work after the
  edit;
- ages all extents past the GC protection window and checks that exactly the
  unreferenced extent files are deleted and every referenced one is kept;
- restarts once more and checks everything again after Azurite has re-saved the database.
