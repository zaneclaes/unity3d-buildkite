# Unity build lane for the cabin cluster: maker-builder plus a batchmode Linux Unity Editor.
# Plan and rationale: UPGRADE.md. Build with ./build-unity.py, which reads the defaults below.
#
# Parity with maker-builder is inherited, not copied: the base is the exact image the amd64 agents
# run (moongate buildkite/cabin/agent-amd64-patch.yaml), built from agent.Dockerfile by
# ./build-agent.py. Bump it there first, then here.
ARG BASE_IMAGE="containers.oodalolly.camp/buildkite-agent@sha256:7d89fe6a85edf79d79e6d21901fcc42421ffc24d2d88a70f4b878bf99cc39ae1"

# Unity's archives (~7 GB) come from a host-side cache, never the network, when built by ./build-unity.py:
# it downloads each archive once into ~/.cache/unity3d-buildkite and replaces these empty stages
# with `--build-context unity-editor-downloads=<dir>` (and modules). A plain `docker build` sees
# them empty and the installer downloads instead. Editor and modules are separate contexts so that
# changing the module list leaves the editor layer cached.
FROM scratch AS unity-editor-downloads
FROM scratch AS unity-module-downloads

FROM ${BASE_IMAGE}

# Bumping Unity: change both (./build-unity.py resolve <version> prints the changeset) and MODULES if needed.
ARG UNITY_VERSION="6000.6.5f1"
ARG UNITY_CHANGESET="3ff58d469c8a"
ARG UNITY_MODULES="webgl,windows-mono,mac-mono,android"

ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

# Editor runtime dependencies: GameCI's images/ubuntu/base list mapped to trixie names (t64
# renames; libgconf-2-4 and libncurses5 are gone and Unity 6 needs neither). xvfb/xauth and Mesa
# already come from maker-builder. cpio/xz-utils are for the installer.
RUN apt-get update -qq -y && apt-get install -qq -y --no-install-recommends \
      cpio \
      tini \
      xz-utils \
      git-lfs \
      atop \
      lsb-release \
      libasound2t64 \
      libc6-dev \
      libcap2 \
      libglu1-mesa \
      libgtk-3-0t64 \
      libncurses6 \
      libnotify4 \
      libnss3 \
      libvulkan1 \
      libxss1 \
      libxtst6 \
  && git lfs install --system --skip-repo \
  && rm -rf /var/lib/apt/lists/*

# No sound card in a pod: point ALSA's default at the null device so Unity, BASS and JUCE stop
# probing for one (GameCI does the same).
COPY unity/conf/asound.conf /etc/asound.conf

ENV UNITY_VERSION="${UNITY_VERSION}" \
    UNITY_CHANGESET="${UNITY_CHANGESET}" \
    UNITY_MODULES="${UNITY_MODULES}" \
    UNITY_PATH="/opt/unity"

COPY unity/unity_release.py /usr/local/lib/unity/unity_release.py

# The editor (4.2 GB download, 9.3 GB installed) and the modules are separate layers, so changing
# the module list does not re-download the editor. Archives stream through md5 checks; a mismatch
# fails the step. No chmod pass: the agent runs as root (as maker-builder does), and a recursive
# chmod in a later layer would copy the whole editor into that layer again.
RUN --mount=type=bind,from=unity-editor-downloads,target=/downloads \
    python3 /usr/local/lib/unity/unity_release.py install "$UNITY_VERSION" \
      --changeset "$UNITY_CHANGESET" --dest "$UNITY_PATH" --skip-modules --cache-dir /downloads
RUN --mount=type=bind,from=unity-module-downloads,target=/downloads \
    python3 /usr/local/lib/unity/unity_release.py install "$UNITY_VERSION" \
      --changeset "$UNITY_CHANGESET" --dest "$UNITY_PATH" --skip-editor --modules "$UNITY_MODULES" \
      --cache-dir /downloads \
  && test -x "$UNITY_PATH/Editor/Unity" \
  && test -x "$UNITY_PATH/Editor/Data/Resources/Licensing/Client/Unity.Licensing.Client"

COPY unity/bin/ /usr/local/bin/
COPY unity/hooks/ /unity/hooks/
RUN chmod 755 /usr/local/bin/unity-editor /usr/local/bin/unity-license /usr/local/bin/unity-entrypoint.sh \
      /unity/hooks/*

# Image hooks run alongside the shared NFS hooks in /buildkite/hooks (that path is a volume, so the
# image cannot ship hooks there). persisted|hooks|floating: see README "Licensing".
ENV BUILDKITE_ADDITIONAL_HOOKS_PATHS="/unity/hooks" \
    UNITY_LICENSE_MODE="persisted"

ENTRYPOINT ["/usr/local/bin/unity-entrypoint.sh"]
CMD ["start"]
