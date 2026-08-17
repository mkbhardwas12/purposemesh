# Control-plane backup, integrity verification, and restore

This runbook covers `CCA_CONTROL_DB`, the single-writer SQLite repository that
contains personas, capsules, memberships, contracts, JIT grants, workflow
metadata, and the in-process audit chain. It does **not** back up the synthetic
warehouse at `CCA_DB`, external identity-provider state, or any future native
target configuration.

The command requires the repository's pinned Node release (`nvm use`) and no
additional packages:

```sh
npm ci
npm run ops:control-plane -- --help
```

## What the tool guarantees

- Backup uses SQLite's online backup API, not a filesystem copy, so committed
  WAL state is included in one consistent snapshot while the API is running.
- Every backup is loaded through the same production repository parser used at
  API startup. Verification covers SQLite integrity, required schema and state
  row, JSON envelope and API metadata, store relationships, classification
  invariants, and the complete local audit hash chain.
- A bundle manifest records SHA-256 hashes, byte size, snapshot/store versions,
  object counts, update time, and audit head. Bundle files are mode `0600` and
  the directory is mode `0700` on POSIX systems.
- Existing bundles and files are never silently overwritten. Every existing
  component of source, bundle, target, rollback, and SQLite-sidecar paths is
  checked with `lstat`; a symlink anywhere in those paths is rejected.
- Restore requires an explicit stopped-writer confirmation. Before changing an
  existing target, the tool creates and verifies a rollback bundle. The state
  replacement is one SQLite transaction and is checked again after commit.

This remains a single-node recovery mechanism. A hash stored beside its backup
detects accidental corruption but is not an external, immutable audit anchor.
Encrypt and replicate bundles through the organization's approved backup
system, with separate credentials, retention, legal-hold, and restore controls.

## Create a backup

Choose a new directory name. The parent directory may be created by the tool,
but the bundle itself must not already exist. Supply canonical physical paths;
the tool intentionally rejects symlinked parent directories as well as a
symlink at the final path.

```sh
npm run ops:control-plane -- backup \
  --source data/cca-control.sqlite \
  --out data/backups/control-2026-08-16T1900Z
```

The resulting bundle contains only:

```text
control-2026-08-16T1900Z/
├── control-plane.sqlite
└── manifest.json
```

Do not use `cp` on `cca-control.sqlite` while the API is running; a separate
`-wal` file may hold committed state. The command above is safe for an online
backup, although scheduling it during a quiet interval reduces retries.

## Verify a backup or live database

Run verification after copying a bundle to another storage tier and as a
scheduled integrity check:

```sh
npm run ops:control-plane -- verify \
  --bundle data/backups/control-2026-08-16T1900Z

npm run ops:control-plane -- verify \
  --database data/cca-control.sqlite
```

Success prints structured JSON with `"ok": true`, the payload hash, audit head,
and object counts. Any nonzero exit or `"ok": false` makes the snapshot
ineligible for restore. Capture stdout/stderr in the operator's approved log.

## Restore an existing control plane

1. Stop the API and confirm that no process, job, or second node can write to
   `CCA_CONTROL_DB`. This repository supports one writer only.
2. Verify the selected bundle.
3. Run restore with the explicit confirmation flag:

```sh
npm run ops:control-plane -- restore \
  --bundle data/backups/control-2026-08-16T1900Z \
  --target data/cca-control.sqlite \
  --confirm-stopped
```

For an existing target, stdout reports `rollbackBundle`. By default it is placed
under `data/backups/` with a `pre-restore` timestamp. A different new directory
may be selected with `--rollback-out <bundle-dir>`.

The restore changes only `control_plane_state`, which is the authorization state
owned by `SqliteControlPlaneRepository`; the readiness timestamp is operational
and is intentionally not rolled back. If post-commit verification fails, the
previous state row is put back automatically. The verified rollback bundle is
the crash-recovery path if the process or host fails between those steps.

4. Verify the target again.
5. Start exactly one API writer and require `/ready` to succeed.
6. Sign in as an administrator and one restricted persona. Confirm expected
   capsule membership, denied data boundaries, JIT state, and audit head.
7. Retain the restore command output and rollback-bundle location with the
   incident/change record. Do not delete the rollback bundle until acceptance.

## Recover when the current database is damaged

The tool refuses an in-place transaction if the existing target cannot pass
repository validation. Restore the verified bundle to a **new** path instead:

```sh
npm run ops:control-plane -- restore \
  --bundle /approved/backup/control-2026-08-16T1900Z \
  --target data/recovery/cca-control.sqlite \
  --confirm-stopped
```

The target must not already exist. After verification, update
`CCA_CONTROL_DB` through the deployment's normal configuration/change-control
process and start one API writer. Preserve the damaged database and its WAL/SHM
sidecars for investigation; this tool never deletes or replaces them.

## Minimum operating schedule

- Back up after every approved policy release and at an interval shorter than
  the agreed recovery-point objective.
- Verify each new bundle immediately and re-verify retained bundles regularly.
- Perform a restore rehearsal to an isolated path at least quarterly; measure
  recovery time rather than claiming an untested RTO.
- Alert on backup, hash, integrity, repository-validation, replication, or
  retention failures. A created file alone is not a successful backup.
