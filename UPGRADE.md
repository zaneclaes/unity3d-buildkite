# UPGRADE: Unity builds on the cabin Kubernetes cluster

Feasibility plan, written 2026-10-06. No code yet. The question: can the cabin cluster's Buildkite
agents (today `openworkshop/maker-builder`, deployed from `$MG_SRC/buildkite`) be upgraded so that
Linux containers compile, build, and test the `$ZP/Chordzy` Unity project, with several builds in
flight at once, and with licensing that is neither a conflict nor a chore?

> **Status 2026-10-09.** Target moved to **`6000.6.5f1`** (changeset `3ff58d469c8a`, released
> 2026-10-08, now Unity's "Recommended"); `6000.6.4f1` below is the version this plan was written
> against. Phase 2 is implemented in this repo (now `unity.Dockerfile`, `build-unity.py`, `unity/`; maker-builder
> itself moved here too as `agent.Dockerfile`/`build-agent.py`; see README).
> Not done: Phase 4's Chordzy changes. Correction to §2.1: with these four modules
> Unity adds ~19 GB installed (webgl alone is 7.4 GB), not 9–11 GB in total.
>
> **Phase 1 licensing result, 2026-10-09: the persisted-identity path works.** The tier is **Unity
> Personal** (open decision #1). `Unity.Licensing.Client` 1.18.3 `--showContext` binds the machine
> by `/etc/machine-id` alone (`Legacy.MachineBinding1/2`), plus hostname; no MAC or disk serial. On
> `buildkite-agent-unity-0` (StatefulSet, state on nixie-beast's hostPath via `UNITY_STATE_DIR`):
> one interactive `unity-license activate` wrote `~/.config/unity3d/Unity/licenses/UnityEntitlementLicense.xml`;
> a batchmode Editor run licensed as Unity Personal and exited 0; the pod was deleted and recreated
> (new pod uid and IP, same machine-id); the same run passed again, reusing the license file unchanged.
> `[Licensing::Module] Error: Access token is unavailable` appears on every run and is harmless (no Hub
> sign-in token on a headless box). Lane deployed at moongate `cabin/agent-unity.yaml` (in the
> kustomization). Its first image was built editor-only; rebuild with the default modules before
> moving Chordzy builds.

Short answer:

- **Hardware: yes, cheaply.** A batchmode Unity 6 Linux Editor needs no GPU. One build lane is
  roughly 4–8 CPU, 12–16 GiB RAM and 20 GB of disk. The upgraded `nixie-beast` alone could host
  three or four lanes next to the three existing agents.
- **Tooling: yes, proven.** GameCI publishes Ubuntu images for exactly `6000.6.4f1` (pushed
  2026-10-01) with the modules Chordzy needs, and the Linux Editor builds WebGL, Linux, Windows
  (Mono) and an unsigned macOS `.app`. Only iOS and macOS signing/notarization stay on `zmac-mini`.
- **Licensing is the gate, but it is an activation-accounting problem, not a concurrency one.**
  The 2020 trick this repo was built on (one `.ulf` file reused by every container) no longer
  works on Unity 6: the file is machine-bound and Personal seats cannot be manually activated at
  all. What Unity actually enforces is a **per-seat device activation count** (nominally two);
  nothing checks simultaneous use. The same seat already runs natively and concurrently on this
  laptop plus three Buildkite machines, so in practice the cluster can run as many lanes as the
  account tolerates activations, **provided each pod keeps a stable machine identity and
  persisted license state across restarts**, exactly like a native box. That is the key Phase 1
  spike. The terms themselves say one instance per seat at a time; the by-the-book answer for
  many lanes is **Build Server** floating licenses served by an on-premises Unity Licensing
  Server (one lease per concurrent batchmode Editor, auto-returned on exit), which needs a Pro
  subscription and costs roughly one Build Server seat per lane.
- **Testing offload: partly.** The branch dev gate (`./ccc game compile Editor`), Unity Test
  Framework runs, and the planned Linux-player smokescreen move cleanly. The development
  smokescreen app half, which attaches to a developer's open editor, is a research item, not a
  plan step.

The rest of this document is the evidence, the design, the phases, and the open decisions.

---

## 1. Where things stand

### 1.1 This repository (unity3d-buildkite)

Last commit 2020-01-21. Ubuntu 18.04, Unity 2019.2, Buildkite agent v3 from apt, a Helm chart
with one container per Unity module, and `build.py`, which pulled the editor installer from the
old `public-cdn.cloud.unity3d.com/hub/prod/releases-linux.json` feed. Its activation story was
`UNITY_LICENSE` (a `.ulf` in an env var written to `~/.local/share/unity3d/Unity/Unity_lic.ulf`)
or `make.py unity activate` (username/password manual activation). Everything here except the
idea is obsolete:

| Piece | Status in 2026 |
|---|---|
| `releases-linux.json` feed | Replaced by `services.api.unity.com/unity/editor/release/v1/releases` (verified working today for 6000.6.4f1). |
| `UnitySetup` self-extracting installer | Linux editor now ships as `Unity-<ver>.tar.xz` plus per-module installers, or via Unity Hub headless / the new `unity install` CLI. |
| `.ulf` reuse across containers | Dead on Unity 6 (machine bindings) and unavailable for Personal. See §3. |
| Buildkite v3 apt package, Ubuntu 18.04 | Agent v4 is stable since 2026-09-01; maker-builder already runs 4.1.0. |
| Helm chart | moongate deploys with kustomize (`base/` + `cabin/` patches). The chart should be retired, not upgraded. |
| `make.py` / `UnityCI/*.cs` build scripts | Chordzy has its own (`ChordzyGame/Assets/Editor/CI.cs`, `BuildMenu.cs`, `ci/*.sh`). Not needed. |

What is worth keeping: the repo as the home of the **image definition** (Dockerfile(s) and a
version-resolving build script), the module list concept, and the Docker Hub namespace.

### 1.2 The working agent image: maker-builder

`~/zdrive/zaneclaes/Programming/MakerHub/src/maker-builder/Dockerfile`, as of 2026-10-03:

- `debian:trixie-slim`, Buildkite agent **4.1.0** (tarball), `/buildkite/{builds,hooks,plugins}`.
- .NET SDK **10.0.401** (pinned for the GC fix Chordzy's tests need), Node 24.21 via nvm, npm/yarn/esbuild.
- Google Chrome stable, Xvfb + Mesa (`libgl1-mesa-dri libegl1 libgles2 libgbm1`), Lighthouse CI 0.15.1,
  Playwright 1.63.0 with Chromium in `/ms-playwright` (for Chordzy's lighthouse and smokescreen web half).
- buildah/netavark, AWS CLI v2, regctl, kubectl 1.37.1, nsis, osslsigncode (Windows installer
  publishing happens on these Linux agents).
- Entry: `scripts/docker-entrypoint.sh` copies `/etc/secrets/id*` into `~/.ssh`, then `exec /buildkite-agent "$@"`.
- Built by `build.sh` with `docker buildx --platform linux/amd64`, tagged `inzania/maker-builder:dotnet-<sdk>-<date>`,
  then pinned by digest in moongate's `buildkite/cabin/agent-amd64-patch.yaml`.

### 1.3 How it is deployed (moongate `buildkite/`)

`base/agent-amd64.yaml` is a StatefulSet (3 replicas) of privileged pods, service account
`buildkite-agent`, requests `cpu: 2, memory: 8Gi, ephemeral-storage: 8Gi`, limits
`cpu: 6, memory: 16Gi, ephemeral-storage: 30Gi`. Mounts: `/buildkite/builds` from hostPath
`/k8s/buildkite` (so checkouts, and a Unity `Library/`, survive pod restarts), `/artifacts`,
`/buildkite/plugins`, `/buildkite/hooks` and `/assets` from the NFS PVC `buildkite-claim`
(NAS `10.0.0.11:/volume2/cluster/buildkite`), `/var/lib/containers` as a 25 Gi emptyDir, secrets
at `/etc/secrets`. The cabin patch pins the image by digest at `containers.oodalolly.camp`, sets
tags `os=linux,os_variant=ubuntu,arch=amd,cpu=64,arch_variant=x64,geo=co,mbps=20`, priority 2,
and mounts `chordzy-assets-staging`. Rollout is `zz app buildkite apply -e cabin`.

All three replicas run on `nixie-beast` today.

### 1.4 The cluster (read 2026-10-06)

| Node | Role | CPU | RAM | Disk free | GPU | OS / runtime |
|---|---|---|---|---|---|---|
| `conductor` | control-plane (agents tolerate it) | 8 | 16 GiB | ~880 GB | none | Ubuntu 24.04, containerd 2.2.1, k8s 1.33 |
| `nixie-beast` | worker | 16 | 121 GiB | 464 GB of 916 GB | RTX 3090 24 GB | Ubuntu 26.04, containerd 1.7.27, k8s 1.34 |

Two findings worth acting on regardless of this plan:

- **The RTX 3090 is currently unusable by Kubernetes.** The NVIDIA device plugin has marked it
  unhealthy since 2026-09-28 with `XidCriticalError: Xid=79` ("GPU has fallen off the bus"), so
  `nvidia.com/gpu` allocatable is **0** (capacity 1). ComfyUI in the `home` namespace is its
  consumer. A host reboot (or reseat) is the usual fix. For this plan the GPU is optional (§4.3).
- `nixie-beast` is on Ubuntu 26.04 with k8s 1.34 while `conductor` is 1.33. Fine for now, but the
  Buildkite agent-stack-k8s controller (if ever adopted, §5.6) wants ≥1.29 everywhere.

### 1.5 What Chordzy needs from Unity

- `version.env` pins `UNITY_VERSION=6000.6.0f1`; **target for this plan is `6000.6.4f1`** (Unity's
  current "Recommended", released 2026-10-01). The 6.6 line matters: it contains the fix for
  UUM-142572 ("floating license is lost for concurrent jobs", fixed 6000.6.0a6), and it is the
  line where the Editor demands a 1 GiB `/dev/shm`.
- Standalone scripting backend is **Mono** (`scriptingBackend: Standalone: 0`). So the Windows
  player can be built by the Linux Editor's `windows-mono` module. (Windows IL2CPP cannot be
  cross-built from Linux; that is irrelevant today.)
- Targets actually built (`ci/buildkite-game-build.yaml`): WebGL, MacOS, Windows, Linux. iOS and
  Android are commented out. Entry point is `-batchmode -executeMethod BuildMenu.Build_<Target>_<Env> -quit`.
- The branch dev gate is `./ccc game compile Editor`: a `-batchmode -nographics -quit` open of
  `ChordzyGame`, no player. `compile-game.sh` and `build-game.sh` hard-code the macOS editor path
  `/Applications/Unity/Hub/Editor/$UNITY_VERSION/...`; the Windows twin lives in `ccc.cmd`. A
  Linux branch is a small change.
- Current timings, from the NAS build reports of today's staging build (`/Volumes/cluster/buildkite/artifacts/Chordzy/staging/ChordzyGame/*/info/report.json`):

  | Target | Agent | Player build step |
  |---|---|---|
  | WebGL | `ZDW-1` (Windows 11) | 364 s |
  | Windows | `ZDW-1` | 15 s |
  | Linux | `ZDW-1` | 14 s |
  | MacOS | `zmac-mini` | 17 s |

  The standalone numbers are warm, incremental builds. WebGL (IL2CPP + emscripten link) is the
  only heavy step and it is CPU-bound. The whole job also pays editor boot plus asset import; the
  `Library/` is 5.1 GB, so a cold import is tens of minutes and a warm one is a couple of minutes.
  `BUILDKITE_CLEAN_CHECKOUT=false` and `-fq` git clean exist precisely to keep `Library/` warm.
- Native plugins: BASS (`libbass.so`, `libbassmix.so`), `libChordzyJuce.so` (glibc ≥ 2.34, ALSA,
  libcurl) and `librtmidi.so` under `Assets/Plugins/Linux/x86_64`. They are not loaded by a
  batchmode compile or a player build. They are loaded by the Linux **player** and by the Editor
  in **Play mode**, which matters for §6.3. `Docs/Plans/CI-JUCE.md` wants to build the Linux
  plugin in CI from an `ubuntu:22.04` toolchain; the Unity agent image is a natural host for it.
- No Unity Test Framework assemblies exist in `ChordzyGame/Assets` today. Tests are .NET
  (`TuneTests`) and run on the Linux agents already.
- Smokescreen: the **web** half is Playwright/Chrome (already in maker-builder). The **app**
  half runs the shipped macOS app from the NAS on staging/production, and on development attaches
  to the one persistent editor through `SmokeBridge.cs` (HTTP on port 9334); `Unity.cs` "never
  launches, quits or kills Unity". `Docs/Plans/SMOKESCREEN-DETERMINISTIC.md` A3 plans
  `smokescreen linux`: run the Linux player under `Xvfb :99` with Mesa software rendering on the
  Linux agents, with a documented fallback if Xvfb/Mesa cannot run the player in the container.

---

## 2. Target architecture

```
                 Buildkite (SaaS)
                        │
   ┌────────────────────┼─────────────────────────────┐
   │ cabin cluster (btd namespace)                    │
   │                                                  │
   │  buildkite-agent-amd64 ×3   (unchanged)          │
   │    maker-builder image: .NET, node, buildah...   │
   │    tags: os=linux,...                            │
   │                                                  │
   │  buildkite-agent-unity ×N   (new StatefulSet)    │
   │    image: unity3d-buildkite:6000.6.4f1-<mods>    │
   │      = maker-builder tooling + Linux Editor      │
   │        + webgl, windows-mono, linux-il2cpp,      │
   │          mac-mono (+ android later)              │
   │    tags: os=linux,unity=true,unity_version=...   │
   │    /dev/shm 1Gi, /buildkite/builds hostPath,     │
   │    per-replica Library cache                     │
   │    license: lease per job (Pro/Build Server) or  │
   │             concurrency_group=1 (Personal)       │
   └──────────────────────────────────────────────────┘
                        │
        Unity Licensing Server (Pro path only)
        on a persistent host (NOT a pod): conductor's
        OS, or the NAS  ── floating Build Server pool
```

Outside the cluster, unchanged: `zmac-mini` keeps the macOS publish (signing, notarization) and
any iOS work. `ZDW-1` becomes optional once the Linux lane produces WebGL, Linux and Windows
players; it can be kept as a fallback `unity=true,os=win` agent during the transition.

### 2.1 Image layering (the user's stated order)

1. **Bring this repo's Dockerfile to parity with maker-builder.** Same base (`debian:trixie-slim`),
   same tool versions, same entrypoint, same `/buildkite` layout. The cleanest way is
   `FROM containers.oodalolly.camp/maker-builder@sha256:<the pinned digest>` so parity is
   inherited, not copied. If a standalone Dockerfile is preferred, copy maker-builder's verbatim
   and treat maker-builder as upstream.
2. **Layer the Unity install on top.** Two viable mechanisms:
   - **Tarball + module installers from the release API** (the modern equivalent of what
     `build.py` did). `Unity-6000.6.4f1.tar.xz` is 4.1 GB; `webgl` 1.6 GB, `windows-mono` 378 MB,
     `linux-il2cpp` 65 MB, `mac-mono` 753 MB, `android` 1.8 GB (plus SDK/NDK/JDK). The API
     returns the exact URLs and sizes per version, so `build.py` becomes a thin resolver again.
   - **Unity Hub headless** (`unityhub --headless install --version 6000.6.4f1 --changeset 12bfff696524 --module webgl ...`),
     which is what GameCI's Dockerfiles do. Note the Hub CLI is deprecated from Hub 3.18 in favor
     of the new `unity install <ver> -m webgl android ...` CLI; either works today.
   The Unity runtime dependency list should be lifted from GameCI's `images/ubuntu/base/Dockerfile`
   (Ubuntu 22.04). Debian trixie is newer than Unity's officially supported Ubuntu 22.04/24.04;
   the Editor runs on it (glibc is newer, not older) but it is "unsupported". If that ever bites,
   the fallback is to flip the base to `ubuntu:24.04` and re-install maker-builder's tooling,
   which is all tarball/npm based except `buildah`, `nsis`, `osslsigncode`, `libicu`.
3. **Add the CI glue**: a `unity-editor` wrapper (`xvfb-run -ae /dev/stdout $UNITY_PATH/Editor/Unity -batchmode "$@"`,
   as GameCI does), license activate/return hooks, and `UNITY_PATH`/`UNITY_VERSION` env.

Expected image size: 9–11 GB with webgl + windows-mono + linux-il2cpp + mac-mono. The local
registry and the 464 GB free on `nixie-beast` absorb that; pull time on the LAN is minutes.

### 2.2 Why not just run `unityci/editor` directly

It would work for a spike (and §5.1 uses it for exactly that), but Chordzy jobs need
maker-builder's .NET 10, node, buildah, NAS conventions and hooks. Combining is required either
way, and the user's stated preference is maker-builder as the base.

---

## 3. Licensing (the real constraint)

Sources: Unity Editor Software Terms (`unity.com/legal/editor-terms-of-service/software`),
Unity 6.6 manual (`docs.unity3d.com/Manual/ManagingYourUnityLicense.html`, `ManualActivationGuide.html`),
Named User Licensing FAQ (support.unity.com, updated 2025-11-06), Licensing Server docs
(`docs.unity.com/en-us/licensing-server/*`), GameCI `cli` repo (`activate.sh`, PR #246 merged 2026-09-05).

### 3.1 What no longer works

- **Reusing a `.ulf` across containers.** On 6000.x the file is cryptographically bound to the
  requesting machine; a fresh container fails with "Machine bindings don't match" (GameCI observed
  this on 6000.6.0f1). This repo's `UNITY_LICENSE` env var design is therefore dead.
- **Manual (offline) activation for Personal or Pro assigned seats.** `-createManualActivationFile`
  / `-manualLicenseFile` now supports only Enterprise/Industry assigned seats and legacy
  serial-based Pro. `license.unity3d.com/manual` redirects for Personal.
- **The "every 3 days" rule** is not current. Personal has a 30-day offline grace period; an
  ephemeral container never reaches it.

### 3.2 What the terms allow per tier

| Tier | Concurrent batchmode Editors you may run | Headless activation | Cost (2026) |
|---|---|---|---|
| **Personal** (< $200k trailing-12-month finances) | Terms: one instance per seat at a time (§2.8), primary + secondary computer. Enforced: an activation count per seat (error text: "Your license is already active on two devices"); simultaneous use is not checked. Today the one seat is active on four machines concurrently without complaint. | `Unity.Licensing.Client --activate-all --include-personal --username --password` (GameCI PR #246), `--return-ulf` on exit or the activation lingers on the account; 2FA unsupported. `-serial`/`-username` flags do not apply to Personal. Or: activate once and persist the state (§3.4). | $0 |
| **Pro** (required above $200k) | Same wording and the same activation-count mechanism. | `-username -password -serial` then `-returnlicense`, or the licensing client. | $2,310/yr per seat (after the 2026-01-12 increase) |
| **Pro + Build Server** | One **lease per concurrent batchmode Editor**, from a floating pool served by the on-prem Licensing Server; auto-returned on exit (lease renew 15 min, expiry 480 min, both configurable). No Editor UI entitlement. | `services-config.json` → `licensingServiceBaseUrl`; the Editor leases on start. GameCI runs this in Linux containers in production (`UNITY_LICENSING_SERVER`). | Pro seat + Build Server packs. **Pricing is contact-sales**: a reseller lists $2,310/yr per Build Server seat, other listings show ~$750; the Unity product page redirects to docs. Historically sold in packs. |
| Enterprise | Floating licenses included. | Licensing Server. | > $25M revenue, custom. Not applicable. |

Two clauses to keep in mind: §2.8 forbids third parties running the Editor "on or simulated by
the cloud or a remote server" except by your own Authorized Users, which is satisfied by your own
hardware and your own account. And Build Server licenses "can only be used to generate builds",
which is what we want them for.

### 3.3 Which tier is Chordzy on today?

Unknown from the repos. The `.ulf` on this Mac is a legacy `SC-` (Pro-style) serial that
**expired 2024-12-28**; today's Windows build log shows the named-user licensing client
(`LicenseClient-zaneclaes`), which is consistent with either Personal or Pro via Hub sign-in.
**Open decision #1**: confirm the tier and whether Chordzy's finances keep it under $200k.

### 3.4 Licensing design per answer

**If Personal or plain Pro seats (the "behave like a native machine" path)**: the goal is for
each pod to be one more device on the account, activated once, the way `ZDW-1` and `zmac-mini`
are. What a native box has and a fresh container lacks is a stable machine identity and a
license state directory that survives reboots. A StatefulSet provides the stable hostname; the
licensing client's state (`~/.config/unity3d`, `/usr/share/unity3d/config`, and whatever else
the client binds to, which the Phase 1 spike must enumerate) goes on the per-replica hostPath
next to `/buildkite/builds`. If the binding survives a pod restart, activation is a one-time
interactive step per replica (`Unity.Licensing.Client --activate-all --include-personal` run
once with `kubectl exec`, password typed, nothing stored), and the lane count is bounded only by
how many activations the account accepts, which is empirically at least four today. If the
binding does **not** survive restarts, fall back to activate-on-start / return-on-exit hooks
with the password in the `buildkite-agent` secret and 2FA off; then the risk is activation
sprawl when a pod dies without returning, handled by a runbook (return stale devices from the
Unity ID page). A Buildkite `concurrency_group` is then a policy choice (how many Editors you
want the one seat to run at once), not a technical requirement.

**If Pro**: buy the Build Server add-on for N lanes, install the **Unity Licensing Server** on a
persistent host. Unity says VMs and containers are not supported for the *server* because its
bindings change on restart, so do not run it as a pod; run it as a systemd service on
`conductor`'s OS (it is the control plane and the most persistent box) or on the NAS. Clients
are the Unity pods, configured by a `services-config.json` baked into the image or mounted from a
ConfigMap, with `toolset` selecting the Build Server pool. Each job leases on Editor start and
returns on exit; a crashed pod's lease expires at `floatingLicenseExpirationInMinutes` (set it to
something like 120, not the 480 default, so a lost lease frees quickly). Use Licensing Server
≥ 2.1 (2.0.x closed Editors at the 8 h mark). Keep `concurrency_group`/`concurrency: N` in
Buildkite as a belt-and-braces cap equal to the number of Build Server seats, so the queue waits
instead of a job failing on "no license available".

**Either way**: `priority` and `concurrency_group` live in the pipeline YAMLs in Chordzy, not in
the image, so the image is tier-agnostic. Only the activation hook differs.

**Spike worth one hour** (§5.1): the new experimental **Unity CLI** documents service-account
auth (`UNITY_SERVICE_ACCOUNT_ID/SECRET`) "for unattended workflows such as CI" and a `license`
subcommand. Whether that activates a Personal seat headlessly without a password is not stated;
if it does, it removes the password-in-a-secret and the 2FA objections.

### 3.5 Alternative: Unity Build Automation (cloud)

Since 2026-03-01: two free concurrent builds, 200/100/100 free Windows/Mac/Linux minutes per
month, $10 per extra concurrency slot, $0.02–$0.37 per overage minute. It does not use the cabin
hardware and its macOS minutes are the expensive ones. Mentioned for completeness; it is the
comparison point if Build Server pricing comes back high.

---

## 4. Hardware sizing and the "headroom" question

### 4.1 Per-lane budget

| Resource | Compile gate | Standalone (Mono) player | WebGL player | Notes |
|---|---|---|---|---|
| CPU | 2–4 | 2–4 | 6–8 | IL2CPP and emscripten scale with cores; `ZDW-1` does WebGL in 6 min. |
| RAM | 6–8 GiB | 8 GiB | 12–16 GiB | WebGL linking is the peak. Set limits so a runaway evicts only its pod (the existing pattern). |
| `/dev/shm` | 1 GiB | 1 GiB | 1 GiB | Unity 6.6 hard-fails on Docker's 64 MB default. emptyDir `medium: Memory`, `sizeLimit: 2Gi`. |
| Disk | ~6 GB Library + checkout | same | same + ~3 GB WebGL cache | Keep on hostPath `/k8s/buildkite/<replica>` as today; `ephemeral-storage` request ≈ 20 Gi. |
| GPU | no | no | no | §4.3. |

### 4.2 What the cluster can hold

Today's `nixie-beast` (16 CPU / 121 GiB) already runs three agents at 2–6 CPU each plus home
services. Two Unity lanes (one sized for WebGL) fit now. After the CPU upgrades the natural
shape is: WebGL lane(s) on `nixie-beast`, compile/standalone lanes wherever. Node affinity by a
`unity-lane` label keeps the WebGL lane off `conductor`'s 16 GiB.

Bigger processors buy headroom in the only place it is scarce: the ~6 minute WebGL build and the
cold-import case. Everything else Unity does for Chordzy is short. Realistically, **two lanes
clear the current pipeline; three is comfortable; more is licensing-limited, not hardware-limited.**
Without Build Server the ceiling is the seat's activation tolerance (§3.4), not the hardware.

### 4.3 The GPU

Not needed. GameCI runs every batchmode build under Xvfb with no GPU; Unity's GPU Progressive
Lightmapper is Windows-only; nothing in the Chordzy build path renders. Where a GPU could matter:

- the **Linux player smokescreen** (A3) and any **Play-mode** testing in the Editor, which render
  frames. Mesa `llvmpipe` on 8 cores is adequate for screenshots, which is what A3 assumes.
- If `llvmpipe` proves too slow, a pod can request `nvidia.com/gpu: 1`, but the 3090 is a single
  device shared with ComfyUI, k8s cannot split it without time-slicing config, and it is currently
  unhealthy (Xid 79). Treat the GPU as a later optimization, and fix its health for ComfyUI's sake.

### 4.4 Library cache strategy

Keep the existing model: each replica owns `/buildkite/builds/<agent>/inzania/chordzy` on
hostPath, `BUILDKITE_CLEAN_CHECKOUT=false`, Unity `Library/` warm across jobs. The StatefulSet's
stable pod names make this deterministic. Two refinements, both optional:

- Seed a new lane's `Library/` by copying a sibling's (a `tar | tar` from the NAS or a sidecar
  init), since a cold import is the slowest thing the lane will ever do.
- **Unity Accelerator** (`unitytechnologies/accelerator` image, official) shares import results
  across lanes and across the Windows/Mac boxes. Worth it once there are three or more lanes or
  frequent cold Libraries; RAM ≈ one Library per project.

---

## 5. Phases

Each phase ends in something observable. Nothing in Phase 1–2 commits to a license purchase.

### Phase 0: decisions and prerequisites (no code)

1. Confirm the Unity subscription tier and the Build Server pricing (one email to Unity sales or
   the account page). This decides §3.4 and the replica count.
2. Decide the Linux Unity lane's platform scope for v1: **WebGL, Linux, Windows** (all buildable
   from Linux, all published from the Linux agents already). macOS `.app` from Linux is possible
   via `mac-mono` and `rcodesign` can ad-hoc sign on Linux, but staging/production macOS stays on
   `zmac-mini` in v1.
3. Fix the RTX 3090 health on `nixie-beast` (reboot after the CPU upgrade is a natural moment).
   Independent of this plan.
4. Decide ownership: this repo owns the image; moongate owns the StatefulSet; Chordzy owns the
   pipeline YAML and `ci/*.sh` changes. (This matches how maker-builder is split today.)

### Phase 1: spike on stock GameCI (1 day, proves licensing and the build before any image work)

Run a one-off pod on `nixie-beast` from `unityci/editor:ubuntu-6000.6.4f1-webgl-3` with
`/dev/shm` 1 GiB, a hostPath checkout of Chordzy, and:

1. Activate with the chosen method (§3.4) and confirm `Unity.Licensing.Client` reports a
   license while the Windows box and the Mac editor are also open (expected to work, as it does
   natively today). Then the real test: find which directories the licensing client writes,
   persist them on the hostPath, **delete and recreate the pod**, and check whether the
   activation is still valid or the client reports a machine-binding mismatch. That single
   result decides between the one-time-activation path and the hooks path in §3.4. Finally
   return the license and confirm the device disappears from the Unity ID page.
2. `xvfb-run Unity -batchmode -nographics -quit -projectPath ChordzyGame -logFile -` (the compile
   gate). Record cold-import and warm times.
3. `-executeMethod BuildMenu.Build_WebGL_Staging`. Compare `info/report.json` size and the
   output tree to today's `ZDW-1` build from the NAS. Then Linux and Windows (`windows-mono`
   needs a second image tag or module; for the spike use two pods).
4. Try the Unity CLI service-account path (§3.4 spike).

Exit criteria: a WebGL build from Linux that the web publish step accepts, with a known license
flow and known timings. If the Editor on trixie is a worry, this phase on Ubuntu 22.04 is the
control.

### Phase 2: the image (this repo)

1. Replace `docker/*.Dockerfile` with one Dockerfile: `FROM` the pinned maker-builder digest,
   Unity runtime deps (from GameCI's base), the Editor tarball plus modules resolved by the
   release API, the `unity-editor` xvfb wrapper, `services-config.json` (Pro path) or the
   licensing-client state on a persisted path or activate/return hooks (seat path), and `UNITY_PATH`/`UNITY_VERSION` env.
2. Rewrite `build.py`: resolve `--version 6000.6.4f1 --modules webgl,windows-mono,linux-il2cpp,mac-mono`
   through `services.api.unity.com`, verify checksums, build with `docker buildx --platform linux/amd64`,
   tag `unity3d-buildkite:6000.6.4f1-<modules>-<date>`, push to `containers.oodalolly.camp`
   (mirroring maker-builder's `build.sh` conventions: date-stamped tag, digest pinning).
3. Delete the Helm chart, `docker/bin/ci` (make.py, UnityCI), `ios-bak.Dockerfile`, `xcode-cross`.
   Rewrite README around the new flow. Keep `.gitignore` entries for license files.
4. Add Buildkite hooks for the lane: a no-op on the persisted-identity path and on floating, or
   `pre-command` activate / `pre-exit` return on the hooks fallback, reading secrets from env and
   never echoing them.
5. Optional but cheap: install the CI-JUCE Linux toolchain (`build-essential cmake libasound2-dev libcurl4-openssl-dev`)
   so `Docs/Plans/CI-JUCE.md` J1 can run on the same lane.

### Phase 3: deploy one lane (moongate)

1. New `base/agent-unity.yaml` StatefulSet (`replicas: 1`), cloned from `agent-amd64.yaml`, with:
   the new image, tags `os=linux,unity=true,unity_version=6000.6.4f1,arch=amd,cpu=64,geo=co`,
   `/dev/shm` memory emptyDir, requests `cpu: 4, memory: 12Gi, ephemeral-storage: 20Gi`, limits
   `cpu: 8, memory: 16Gi, ephemeral-storage: 40Gi`, node affinity to `nixie-beast`, the same
   NFS/hostPath/secret mounts, and the licensing config (ConfigMap or env).
2. License state: on the persisted-identity path, activate each replica once by `kubectl exec`
   (nothing stored in a secret); on the hooks fallback, add username/password to the
   `buildkite-agent` secret; on the floating path, only the server URL, in the image or a ConfigMap.
3. `zz app buildkite apply -e cabin`; verify the agent appears in Buildkite with the new tags.

### Phase 4: move Chordzy steps (Chordzy repo)

1. `ChordzyGame/ci/compile-game.sh` and `build-game.sh`: choose the Editor binary by OS
   (`$UNITY_PATH/Editor/Unity` on Linux, the Hub path on macOS), wrap in `xvfb-run` on Linux.
2. `ci/buildkite-dev-unity.yaml`: add `os: linux` to the compile gate (or leave `unity: "true"`
   only, so whichever Unity agent is free takes it).
3. `ci/buildkite-game-build.yaml`: WebGL, Linux, Windows → `unity: "true", os: linux`; MacOS stays
   `os: mac`. Optionally add `concurrency_group: unity-license` / `concurrency: <n>` to the Unity
   steps as a policy cap (required only on the floating path, where it should equal the seat count).
4. Run staging end to end; compare the published artifacts; let `ZDW-1` idle for a week as the
   fallback before retiring it from `unity=true`.
5. `TuneTests/Lib/StagingCabinCiTests` and `CiArtifactsRuleTests` pin pipeline facts; update them.

### Phase 5: scale out (Pro path only)

Install Licensing Server on the persistent host, point the image's `services-config.json` at it,
set `replicas` to the Build Server seat count, raise `concurrency` to match, add the Accelerator
if cold imports show up in timings. On the seat path this phase is "add a replica, activate it once".

### Phase 6: tests on the lane

See §6.

### 5.6 A note on agent-stack-k8s

Buildkite's official Kubernetes stack (pod per job, v0.51.0 on 2026-09-29, agent v4) is the
"proper" k8s model and would make per-step resources trivial. It is **not** recommended here:
the warm `Library/` cache and the one-checkout-per-pipeline conventions that Chordzy's CI
depends on (`BUILDKITE_CLEAN_CHECKOUT=false`, git hygiene hooks, NAS layout) fit long-running
StatefulSet agents far better, and a floating-license lease per short-lived pod adds churn. If
pod-per-job is ever wanted, the image built here works unchanged under it.

---

## 6. Offloading tests

### 6.1 Immediately movable

- **Branch dev gate** (`./ccc game compile Editor`). Today it runs on `ZDW-1` or `zmac-mini` at
  priority −1. On the Linux lane it becomes just another queued job and stops competing with a
  developer's Windows box.
- **Player builds** for WebGL/Linux/Windows, which are themselves the gate for the publish steps
  already on the Linux agents.
- **CI-JUCE J1** (the Linux plugin build) if the toolchain is in the image.

### 6.2 Unity Test Framework (new capability, not used today)

The lane can run `-runTests -testPlatform EditMode|PlayMode -testResults out/tests.xml` under
Xvfb. GameCI runs these without `-nographics`; the folklore that Play-mode tests cannot use
`-nographics` is third-party and unverified, so default to Xvfb with graphics and treat
`-nographics` as an optimization to test. Chordzy has no test assemblies in the Unity project
today, so this is an enabling step, not a migration. Each test run is one Editor instance, so it
counts against the same license concurrency.

### 6.3 Smokescreen

- **Web half** (`smokescreen web`): needs only Chrome/Playwright. Already runs on maker-builder;
  SMOKESCREEN-DETERMINISTIC's post-rollout steps target `os: linux, geo: co`. No Unity involved.
- **Linux player half** (`smokescreen linux`, A3): runs the built `Chordzy.x86_64` under
  `Xvfb :99` with Mesa in the agent. The maker-builder image already has Xvfb and Mesa; the open
  risk A3 itself names (can the player run inside the privileged container?) is really two
  risks: software GL (fine with `llvmpipe`) and **audio**. BASS and JUCE will look for ALSA
  devices; a container has none. Options in order of preference: PulseAudio/PipeWire null sink
  inside the pod, the host's `snd-dummy` module exposed via `/dev/snd`, or making the
  JUce/BASS bridge tolerate "no device" in CI. This is A3's problem to solve and the lane only
  needs to not make it harder.
- **Development app half** (the persistent editor driven through `SmokeBridge`): designed around
  an editor the developer opened on the working tree. A containerized equivalent would be a
  non-batch Editor under Xvfb, held open, with `SmokeBridge` listening and `kubectl port-forward`
  to 9334. It is plausible (`SmokeBridge` is `[InitializeOnLoad]` and serves from
  `EditorApplication.update`), but it holds a license seat permanently, needs the audio fix above
  for Play mode, renders through `llvmpipe`, and inverts the skill's "never launch Unity" rule.
  **Research item, out of scope for v1.** It also holds one activation on the seat permanently.

### 6.4 What stays local or on the Macs

macOS signing/notarization, iOS (Xcode), and the smokescreen's shipped-macOS-app half. Nothing
on Linux changes those.

---

## 7. Is it worth it without Build Server?

Yes. Lanes behave like the native machines do today, so the practical ceiling is the account's
activation tolerance, not one. Beyond that:

- the WebGL/Linux/Windows builds and the compile gate leave a desktop Windows PC for a pod that
  Kubernetes schedules, restarts, and caps;
- the lane is reproducible from a Dockerfile, pinned by digest, and versioned with Unity;
- `smokescreen linux` and CI-JUCE get a home;
- the same image and manifests become N lanes the day a Pro + Build Server subscription exists,
  with only `replicas`, `concurrency` and the server URL changing.

What it does not do is make the arrangement by-the-book: the terms still say one instance per
seat at a time, and the day Unity tightens activation enforcement, Build Server is the fix.

---

## 8. Open decisions

1. **License tier and Build Server pricing** (§3.3). Everything about replica count hangs on it.
2. **Debian trixie vs Ubuntu 24.04 base** for the Unity image. Default: trixie via `FROM maker-builder`,
   with Phase 1 on Ubuntu as the control; switch only if the Editor misbehaves.
3. **Licensing Server host** (Pro path): `conductor`'s OS vs the NAS. Default: `conductor`.
4. **Only if the persisted-identity spike fails:** where the account password lives for the
   activate-on-start hooks and whether 2FA can be off on that account. If neither is acceptable,
   the Unity CLI service-account spike decides, else the lane needs the floating path.
5. **Retire `ZDW-1`** after Phase 4, or keep it as a fallback `unity=true,os=win` agent.
6. **macOS from Linux** (`mac-mono` + `rcodesign`) for staging only, later. Not in v1.
7. **Android** (`android` module, +1.8 GB plus SDK/NDK/JDK): possible on the lane, blocked
   today by Chordzy's `#android-ndk` item, out of scope until that moves.

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Activation sprawl: pods that die without returning accumulate devices on the seat until Unity refuses new ones | medium on the hooks path, low on the persisted-identity path | Stable identity + persisted license state (§3.4); otherwise a `pre-exit` return hook and a runbook to return stale devices from the Unity ID page; floating licenses expire by themselves. |
| Unity tightens activation-count enforcement and the four-plus-N concurrent devices stop working | low, unknown timing | Build Server floating licenses (§3.4, Pro path); the image and manifests are unchanged by the switch. |
| `/dev/shm` or Xvfb missing → Editor exits before logging anything | high if forgotten | Bake both into the image wrapper and the StatefulSet; Phase 1 verifies. |
| Editor on Debian trixie hits a glibc/lib mismatch | low | Ubuntu 24.04 fallback base (§2.1). |
| Cold `Library/` import on every pod restart | medium | hostPath cache per replica (exists today), Library seeding, Accelerator later. |
| Output drift between Linux-built and Windows-built players | low for Mono/WebGL | Phase 4 compares NAS artifacts before cutover; keep `ZDW-1` a week. |
| Unity 6.6 is "Supported", not LTS; GameCI lags a new patch by days | low | Pin by exact version; the release API makes bumping a one-line change. |
| Build Server pricing or pack minimums make N lanes uneconomic | unknown | Phase 0 quote; fall back to one lane + Unity Build Automation for bursts. |

## 10. Reference facts gathered for this plan

- Unity `6000.6.4f1` Linux: released 2026-10-01, changeset `12bfff696524`, editor tarball 4.1 GB;
  modules available: android, ios, visionos, linux-il2cpp, linux-server, mac-mono, mac-server,
  webgl, windows-mono, windows-server. Queried via `services.api.unity.com/unity/editor/release/v1/releases`.
- GameCI `unityci/editor` tags for `ubuntu-6000.6.4f1-{base,linux-il2cpp,windows-mono,mac-mono,ios,android,webgl}-3`,
  pushed 2026-10-01; base 5.0 GB, webgl 7.8 GB, android 8.1 GB. Image series v3.2.x; `unity-builder` v6.0.0 (2026-09-10).
- Unity Licensing Server: server on Ubuntu 20.04+ persistent hosts (VMs/containers unsupported for
  the server), clients Linux Editor 2019.4+; config at `/usr/share/unity3d/config/services-config.json`;
  use ≥ 2.1.0.
- Buildkite agent v4 stable since 2026-09-01; maker-builder ships 4.1.0; agent-stack-k8s v0.51.0.
- Chordzy standalone scripting backend: Mono. WebGL memory 16 (MB units in the asset), threads off.
- Cabin: `nixie-beast` 16 CPU / 121 GiB / RTX 3090 (unhealthy since 2026-09-28, Xid 79) / 464 GB free;
  `conductor` 8 CPU / 16 GiB; three maker-builder agents on `nixie-beast`.
