# azurite-delete

Bulk-delete blobs from a local [Azurite](https://github.com/Azure/Azurite) store by
editing its LokiJS metadata directly, while Azurite is stopped. Deleting tens of
thousands of blobs over HTTP is very slow, because Azurite re-saves its whole database
after each write. This tool rewrites the database once, in about a second.

```text
PS> .\etc\azurite-delete.ps1 -Location C:\Users\ryan\source\repos\WhatInBox\.azurite -Container "wib-apparatus-box-image" -Prefix "dev/Import Test/Import Test/"
Reading C:\Users\ryan\source\repos\WhatInBox\.azurite\__azurite_db_blob__.json (66.19 MB (69,400,603 bytes))
  73,902 blobs, 6 uncommitted blocks

Dry run (nothing will be changed; pass --apply to delete):

  wib-apparatus-box-image/dev/Import Test/Import Test/
    blobs:              12,208, 1.31 GB (1,401,836,476 bytes)
    uncommitted blocks: 0, 0 B (0 bytes)
      dev/Import Test/Import Test/rcole-import_202610062144/Pap - Pezzuto #27(3)/content-1251.jpg
      dev/Import Test/Import Test/rcole-import_202610062144/Pap - Pezzuto #27(3)/content-1252.jpg
      dev/Import Test/Import Test/rcole-import_202610062144/Pap - Pezzuto #27(3)/content-1253.jpg
      dev/Import Test/Import Test/rcole-import_202610062144/Pap - Pezzuto #27(3)/content-1254.jpg
      dev/Import Test/Import Test/rcole-import_202610062144/Pap - Pezzuto #27(3)/content-1255.jpg
      ...

Total: 12,208 blobs (1.31 GB (1,401,836,476 bytes)) and 0 uncommitted blocks; 61,694 blobs remain.

Extent files (556 total, __blobstorage__):
  becoming unreferenced: 6, 32.80 MB (34,392,256 bytes)
  still referenced: 550 (space held by deleted blobs inside these is not reclaimed)
  note: remaining blobs reference 1 extent(s) not listed in __azurite_db_blob_extent__.json (0 of them exist on disk): bdc2b927-1a0b-44ab-86c0-beb698c8671b

Dry run only. Re-run with --apply (Azurite stopped) to delete.
```

Tested with Azurite 3.35.0 (bundled with Visual Studio 18) and LokiJS 1.5.12.

## Usage

```powershell
# Dry run (the default): changes nothing
.\etc\azurite-delete.ps1 -Location <azurite folder> -Container images -Prefix "2024/"

# Delete (stop Azurite first)
.\etc\azurite-delete.ps1 -Location <azurite folder> -Container images -Prefix "2024/" -Apply
```

- **`-Prefix`** is the start of the blob name *inside* the container. It's ordinal and
  case-sensitive, and you can pass several (`-Prefix "a/", "b/"`). Leave it out to
  delete the whole container; the container itself stays.
- **`-Target`** covers several containers in one run:
  `-Target images/2024/, thumbnails`.
- **Other options:** `-Account`, `-BlobPort` (default 10000), `-Samples`, `-NoBackup`.
- **Snapshots and staged blocks:** snapshots and uncommitted blocks of matching blobs are
  deleted too.
- **No matches:** if a prefix matches nothing, the dry run suggests the container that
  holds it.

The wrapper finds `node.exe` on PATH or inside Visual Studio, and installs `lokijs` on
first run. To call Node directly:
`node src\azurite-delete.js --location <folder> --container images --prefix 2024/ [--apply]`.

## What `-Apply` does

1. Refuses to run if an Azurite process is running or the blob port is in use. Azurite
   autosaves its in-memory database every 5 seconds and would overwrite the edit.
2. Backs up the blob and extent databases to `<location>\azurite-delete-backups\<timestamp>\`.
   To undo, stop Azurite and copy them back. This works only until Azurite's
   cleanup has deleted the freed extent files.
3. Removes matching blob and block docs.
4. Rebuilds the LokiJS indices of both collections.
5. Writes the file atomically (temp file, then rename).

**Why rebuild the indices?** Azurite's collections use LokiJS *adaptive* indices, which
are used as-is on load, without checking the `dirty` flag. Leaving them empty and dirty
would make every lookup return nothing. The tool rebuilds them with LokiJS's own
`ensureIndex`, which also repairs indices that were already out of sync.

## Disk space

Blob bytes live in shared extent files under `__blobstorage__`. This tool deletes only
metadata. Azurite's cleanup then deletes extent files that nothing references any more.
It runs at startup and every 10 minutes, and skips extents written in the last 10
minutes.

An extent is freed only when *every* blob in it is gone, and Azurite never compacts
extents. The dry run's "becoming unreferenced" line shows what will actually be
reclaimed. In the example above, that's 33 MB of the 1.31 GB deleted.

## Notes

- **Azure Functions blob triggers:** receipts live in `azure-webjobs-hosts` under
  `blobreceipts/...`. Deleting receipts while keeping their blobs makes the triggers fire
  again.
- **Not checked:** SQL databases or other stores that refer to the deleted blobs, and blob
  leases, legal holds and immutability policies.
- **Not supported:** custom `--blobStorageFolder` paths and SQL metadata (`AZURITE_DB`).

## Testing

```powershell
npm install
npm test
```

The end-to-end test builds a throwaway store with Azurite's real blob service. It
deletes several containers and prefixes, then restarts Azurite and checks:

- the deleted blobs are gone;
- every kept blob downloads byte-identical;
- new writes still work;
- Azurite's cleanup removes exactly the unreferenced extent files;
- the tool refuses to run while Azurite is running.
