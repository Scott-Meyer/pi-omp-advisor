# OMP compatibility harness

This harness tests the npm-packed extension through a real, isolated OMP install. It never reads or writes the normal `~/.omp` or Pi configuration.

It covers:

- package manifest and extension loading;
- exact provider-visible child tool restrictions, including fail-closed removal of an explicitly requested `request_stop` grant because OMP 18.2.4 exposes no abort-in-progress state;
- bounded provider context across large tool loops;
- terminal settlement after OMP automatic continuation;
- primary abort during a running tool, delayed blocker preservation, inbox delivery on a user-attributed `/skill:` RPC resume, and later blocker steering;
- recovery after a malformed advisor tool stream, with provider-boundary validation that rejects orphaned, duplicate, or incomplete tool exchanges;
- session-local disabling of OMP's native advisor inside the extension child while the primary native advisor remains enabled; and
- the collision-free `/pi-advisor` command and host-aware help text.

## Run

Install the official OMP binary separately, then point the harness at it:

```bash
OMP_BIN=/path/to/omp npm run test:omp
```

The default contract is OMP `18.2.4`. To intentionally test another release:

```bash
OMP_BIN=/path/to/omp EXPECTED_OMP_VERSION=18.3.0 npm run test:omp
```

Set `RUN_TUI=1` to include the real PTY command probe. It requires Python and `pexpect`:

```bash
OMP_BIN=/path/to/omp RUN_TUI=1 npm run test:omp
```

By default the harness packs the current checkout. To validate the immutable package delivered by npm instead:

```bash
OMP_BIN=/path/to/omp \
OMP_COMPAT_PACKAGE_SPEC=pi-omp-advisor@0.5.1 \
RUN_TUI=1 npm run test:omp
```

The harness records that registry artifact's distribution metadata and the downloaded tarball's SHA-256 alongside its other evidence.

The harness creates a temporary home, package staging directory, project, model configuration, and deterministic local OpenAI-compatible provider. Set `KEEP_OMP_COMPAT_WORK=1` to retain its artifacts, or `OMP_COMPAT_WORK_DIR=/absolute/path` to choose their location.
