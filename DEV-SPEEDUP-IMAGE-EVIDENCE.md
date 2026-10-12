# DEV-SPEEDUP A2 existing agent image prerequisite

2026-10-12. Worker `01a13264-c55e-7310-a48a-e0c4a50e3480`, receipt start
`2026-10-12T23:13:56.012016Z`; normal Own succeeded before tree creation.
MODEL SELECTOR ACCEPTED (identity unavailable).

## Producer and custody

The actual existing producer is `Programming/unity3d-buildkite/agent.Dockerfile`.
Its README documents registry `containers.oodalolly.camp/buildkite-agent` and
Buildx delivery, followed by moongate's existing image pin and `zz` apply.
MakerHub's producer publishes another repository and is not the current owner.

External HEAD is `307a914598672b57fd2f77918561653796a8057c` (old iOS implementation).
The current Dockerfile and agent context are foreign untracked input; the current README
is foreign modified input. Their adoption into this single worktree was explicitly
authorized by the parent. The shared external checkout remains untouched.
The isolated worktree branch is `wip/dev-image-codex-20261012`.

Original SHA-256:

- agent.Dockerfile: `2ef075136a79b3e2bf893fa6bb32592445ddc936bb6570a73543487c4befd1ee`
- agent.Dockerfile.dockerignore: `e2e6a6db224410d8ccccc84f1d3e6ead08b73e317a834d0a18509640a6e122b6`
- README.md: `d1dff68ebfddf597970b9b99d4438dc9e3ef596c0366990d1fe47c584d563c79`

`producer-input-sha256.txt` records the copied agent context hashes. Context inventory
contains source/configuration/package lock/entrypoint files, no node_modules or dist;
the agent configuration has only a commented token placeholder. No active credential,
Python build script, unrelated Unity input or secret-bearing file was copied.
The before files preserve exact reviewed baseline text.

## Minimal change

Add `crun` beside existing Buildah. Move SDK from inaccessible `/root/dotnet` to
`/usr/share/dotnet`, preserving its version and adding read/execute permission for
the nonroot runner. Document OCI qualification and the existing human delivery gate.
No bubblewrap, alternate isolation, service, pod, topology, capacity or spend change.

## Current result

Source preparation PASS. Image build NOT RUN. Image qualification NOT RUN.
Push NOT RUN. Deployment NOT RUN. Existing Docker Buildx lists default and desktop-linux,
but both fail to connect because their existing Docker sockets are absent.
No builder was created, Docker service started or alternative build route substituted.

The direct existing Dockerfile build (after the existing builder is available) is:

```sh
cd /Users/zaneclaes/zdrive/zaneclaes/Programming/Chordzy
sh ci/worker-process.sh dotnet -- docker buildx build --platform linux/amd64 --file .scratch/dev-image-codex-20261012/agent.Dockerfile --metadata-file .scratch/dev-image-codex-20261012/image-metadata.json --load -t containers.oodalolly.camp/buildkite-agent:dotnet-10.0.401-dev-speedup-20261012 .scratch/dev-image-codex-20261012
```

This consumes the actual existing Dockerfile and its existing download fallback, without
running legacy Python or creating a second script/tool. All metadata remains in this tree.
Build and push must be reported to the parent before execution.

Docker.app is installed. Its supported activation command is
`docker desktop start --timeout 60`, and `docker desktop status` confirms it is stopped.
Activation was not performed: the existing worker guard monitors only its owned process
group, while Docker Desktop's persistent detached VM/backend escapes that accounting.
The Buildx CLI's existing 8GiB reservation would not establish a bounded VM workload.
There is no existing Docker-specific profile/lease in the current worker-process owner.
No new profile, VM, builder or custom reservation was introduced. Network downloads
follow the existing Dockerfile's public archive/apt/npm/Chrome fetch route; no secret is
passed to that route. This is a resource-path gate in addition to the later human delivery gate.

Safe key-only settings queries found current `settings-store.json` values
`MemoryMiB=8192` and `Cpus=10`; the legacy settings file agrees. The configured 8GiB VM
cap does not reserve persistent host resources in the worker ledger or account for host
backend RSS. Docker contexts are only default and desktop-linux; no existing remote
Docker context supplies another supported route. Parent explicitly held activation/build
until existing resource accounting can represent the persistent VM. This prerequisite
remains in original DEV-SPEEDUP A2; no new plan or resource architecture was created.

## Qualification and delivery still owed

Require the image's actual nonroot SDK execution through Buildah/crun OCI, dropped
capabilities, no networking, private mount/PID namespaces, private scratch and a read-only
trusted runner bundle. Prove that kube token, host checkout, NAS, SSH credentials, home and
control sockets are unavailable. Bind evidence to fixed digest. Installing crun is not PASS.

The existing `moongate/AGENTS.md` and `hooks/policy.md` require specific current-human
authorization for cluster mutation. The current deployed amd64 pin is
`containers.oodalolly.camp/buildkite-agent:dotnet-10.0.401` with IfNotPresent;
the qualified replacement must use its printed fixed digest or unique tag.
The owning source pin is `moongate/buildkite/cabin/agent-amd64-patch.yaml` and the existing
deployment command is `zz app buildkite apply -e cabin`. Neither pin editing nor apply
was performed. An executable final delivery handoff needs the actual qualified digest
and verified live workload selectors; inventing a placeholder handoff would be incomplete.
