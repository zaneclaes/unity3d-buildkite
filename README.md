# unity3d-buildkite

Two images for the cabin cluster's Buildkite agents: **buildkite-agent**, the agent image every
agent runs (formerly maker-builder, moved here from `MakerHub/src/maker-builder`), and
**buildkite-unity**, the Unity build lane: buildkite-agent plus a batchmode Linux Unity Editor and the build modules Chordzy needs. Why and how it fits together: [UPGRADE.md](UPGRADE.md).

| | |
|---|---|
| Unity | `6000.6.5f1` (changeset `3ff58d469c8a`) |
| Modules | `webgl`, `windows-mono`, `linux-il2cpp`, `mac-mono` |
| Agent image | `containers.oodalolly.camp/buildkite-agent:dotnet-<sdk>-<date>` (and `:latest`) |
| Unity base | `containers.oodalolly.camp/maker-builder@sha256:7e0e33…` (the image the amd64 agents run, until buildkite-agent replaces it) |
| Image | `containers.oodalolly.camp/buildkite-unity:<unity>` |
| Deployed by | moongate `buildkite/cabin/agent-unity.yaml` |

## Layout

```
agent.Dockerfile         buildkite-agent: Buildkite agent, .NET, Node, Chrome, Playwright, kubectl, ... Version pins.
build-agent.py           Build (linux/amd64) and push buildkite-agent; prints the digest to pin.
agent/                   The @openworkshop/maker-builder package (maker-* CLIs), agent config, entrypoint.
agent/bin/fetch-cached   Build-time helper: take an archive from the host cache, else download it.
unity.Dockerfile         FROM buildkite-agent; Unity deps, editor, modules, scripts. Holds the version pins.
build-unity.py           Resolve, build (linux/amd64) and push buildkite-unity; prints the digest to pin.
unity/unity_release.py   Resolver + installer against Unity's release API (stdlib only, runs in the build).
unity/bin/unity-editor   xvfb-run wrapper: `unity-editor <args>` = Unity -batchmode <args>; checks /dev/shm.
unity/bin/unity-license  activate | return | status, per UNITY_LICENSE_MODE.
unity/bin/unity-entrypoint.sh  Per-replica identity and license state, then maker-builder's entrypoint.
unity/hooks/             pre-command / pre-exit agent hooks (BUILDKITE_ADDITIONAL_HOOKS_PATHS=/unity/hooks).
unity/conf/asound.conf   ALSA default → null device (pods have no sound card).
```

## Building

```
./build-agent.py                       # buildkite-agent: push :latest and :dotnet-<sdk>-<date>; prints the digest
./build-agent.py --no-push             # build into the local docker only
./build-unity.py resolve               # what unity.Dockerfile pins: changeset, archive sizes (~7 GB)
./build-unity.py resolve 6000.6.6f1    # look up another version
./build-unity.py                       # build and push; prints the tag and the @sha256 digest
./build-unity.py --no-push             # build into the local docker only
```

Each Dockerfile has its own `<name>.Dockerfile.dockerignore`, so the agent build sees only `agent/`
and the Unity build only `unity/`. Agents pull with `IfNotPresent`, so deploy buildkite-agent by digest
(or its dated tag), never `:latest`.

Requires `docker buildx` with a `linux/amd64` builder and push access to `containers.oodalolly.camp`.
On Docker Desktop, raise Settings → Resources → Disk usage limit to ~120 GB: the build VM needs the
~19 GB of Unity layers, their compressed copies for the push, and the 7 GB of archives at once.

**Downloads happen once.** `build-unity.py` keeps Unity's archives in `~/.cache/unity3d-buildkite/downloads`
(`--cache-dir` or `$UNITY_DOWNLOAD_CACHE` to move it) and fetches only what is missing (a file counts as
cached when its size matches the API's). It hands them to the build as two read-only named contexts,
`unity-editor-downloads` and `unity-module-downloads` (hard links under `.../contexts/`, so no extra
disk). The install steps read from those; their log says `using cached` per archive, or
`not cached, downloading` if something slipped through. So a rebuild, a `docker buildx prune`, or a new
maker-builder base re-extracts from the Mac's disk and never touches the network. Delete old versions'
archives from the cache by hand. A plain `docker build` without build-unity.py still works but downloads.
Unity adds about 19 GB to maker-builder (per the release API's installed sizes: editor 9.3 GB, webgl
7.4, mac-mono 1.5, windows-mono 0.8–1.0, linux-il2cpp 0.3). The editor and the modules are separate
layers, so changing modules does not re-download the editor.

`build-agent.py` does the same for maker-builder's versioned archives (buildkite-agent, AWS CLI,
.NET SDK, regctl, kubectl): one directory per archive and version under
`~/.cache/unity3d-buildkite/agent/`, each passed as its own `dl-<name>` context, so bumping one tool
re-runs only its layer and those after it. Unversioned downloads (Chrome stable, apt, npm, Playwright's
Chromium) still come from the network whenever their layer rebuilds.

**NAS mirror.** With `$BUILD_ARTIFACTS_PATH` set (e.g. `/Volumes/cluster/buildkite/artifacts`), both
scripts restore any missing archive from `$BUILD_ARTIFACTS_PATH/unity3d-buildkite/` (same layout:
`downloads/`, `agent/`) before downloading, and copy newly downloaded ones back there once the downloads
are done, before the docker build, so a failed build still keeps them. `contexts/` is not mirrored. If the
share is not mounted, the scripts warn and carry on without it. See `download_cache.py`.

**Bumping Unity:** set `UNITY_VERSION` and `UNITY_CHANGESET` in unity.Dockerfile (`./build-unity.py resolve
<version>` prints the changeset; the build refuses a mismatch), build, then update the digest and the
`unity_version` agent tag in moongate's `cabin/agent-unity.yaml`. Chordzy's `version.env` should move
in the same change.

**Bumping buildkite-agent:** change the version `ARG`s in agent.Dockerfile, `./build-agent.py`, pin the
printed digest in moongate's `agent-amd64-patch.yaml`, then set unity.Dockerfile's `BASE_IMAGE` to it
and rebuild the lane.

The agent image includes `crun` for Buildah's OCI execution. Development snapshots must run as
an unprivileged UID with capabilities dropped, networking disabled and private namespaces;
the privileged agent's credentials and host mounts never belong in that execution root.
The SDK lives at `/usr/share/dotnet` and is readable and executable by that UID. Qualify the
actual OCI execution against the newly built digest before changing the deployed image pin.
Installing a runtime alone does not establish sandbox isolation. Cabin deployment follows
moongate's existing mutation policy and requires its specific human authorization.

How the installer lays out modules (verified on 6000.6.5f1): the editor and `TAR_XZ` modules are
rooted at the install root; `PKG` modules are xar archives whose cpio payload is rooted at the module's
`destination` (their macOS pre/postinstall scripts are not run); every download is md5-checked against
the API's `integrity`. A Hub-style `modules.json` and a `version` file are written to `$UNITY_PATH`.

## Using the lane

Agents carry the maker-builder tags plus `unity=true,unity_version=<ver>`, at priority 1 (the plain
amd64 agents are 2, so ordinary Linux steps prefer them). A Chordzy step:

```yaml
- label: ":unity: compile"
  command: unity-editor -nographics -quit -projectPath ChordzyGame -logFile -
  agents: { os: linux, unity: "true" }
```

`unity-editor` needs `/dev/shm` ≥ 1 GiB (Unity 6.6 exits silently below it). The StatefulSet mounts a
2 GiB memory emptyDir; locally use `docker run --shm-size=1g`.

## Licensing

`UNITY_LICENSE_MODE` picks one of three flows (UPGRADE.md §3). The image is the same for all three.

| Mode | When | Per job | Setup |
|---|---|---|---|
| `persisted` (default) | Personal or Pro seat; the pod behaves like a native machine | nothing | `kubectl -n btd exec -it buildkite-agent-unity-0 -- unity-license activate` once per replica (prompts for the password; nothing stored) |
| `hooks` | the persisted activation does not survive pod restarts | `pre-command` activates, `pre-exit` returns | `unity_email` / `unity_password` in the `buildkite-agent` secret; 2FA off |
| `floating` | Pro + Build Server, Unity Licensing Server on a persistent host | `pre-command` leases, `pre-exit` returns the lease | `UNITY_LICENSING_SERVER` (and optional `UNITY_LICENSING_TOOLSET`) |

**persisted.** `UNITY_STATE_DIR` (the StatefulSet sets `/buildkite/builds/.unity-state/<pod>`, on the
node's hostPath) keeps a per-replica `/etc/machine-id` plus `~/.local/share/unity3d`,
`~/.config/unity3d` and `/usr/share/unity3d`, so an activation should survive a pod restart the way it
survives a reboot. **That is UPGRADE.md's Phase 1 question and is not verified yet**: Unity may also
bind to things a pod cannot keep (its veth MAC address). Test: activate, delete the pod, then run a
compile. `Machine bindings don't match` means switch to `hooks`. `unity-license status` shows what is
persisted.

**hooks.** Every job activates and returns. A pod killed mid-job leaves its device on the seat; return
stale devices from the Unity ID page if activation starts failing with "already active on two devices".

**floating.** The entrypoint writes `/usr/share/unity3d/config/services-config.json`. Leases expire on
the server if a pod dies (set `floatingLicenseExpirationInMinutes` to ~120). Keep a Buildkite
`concurrency_group` on the Unity steps equal to the Build Server seat count.

Any mode: a step that never opens Unity can skip the hooks with `env: { UNITY_LICENSE_SKIP: "1" }`.
Flags follow GameCI (`--activate-all --include-personal`, `--return-ulf`, `--acquire-floating`,
`--return-floating`). Never commit `.ulf`/`.alf` files; a `.ulf` is machine-bound on Unity 6 anyway.

## History

Until 2020 this repo built `inzania/unity3d-buildkite` images on Ubuntu 18.04 for Unity 2019 with a
Helm chart and a shared `.ulf`. That design does not work on Unity 6 (UPGRADE.md §1.1, §3.1) and was
removed; see git history before this rewrite.
