#!/bin/bash
# Gives the pod a stable Unity identity, then hands off to maker-builder's entrypoint unchanged.
#
# UNITY_STATE_DIR (e.g. /buildkite/builds/.unity-state/$(hostname), on the per-node hostPath) holds a
# per-replica /etc/machine-id and the licensing client's state directories, so an activation
# survives a pod restart the way it survives a reboot on a native box. Whether Unity's binding also
# depends on things a pod cannot keep (the veth MAC address) is UPGRADE.md's Phase 1 question;
# `unity-license status` shows what is persisted. Unset, nothing is persisted (fine for floating).
#
# UNITY_LICENSING_SERVER (floating mode) writes the client's services-config.json.
set -euo pipefail

STATE="${UNITY_STATE_DIR:-}"
if [[ -n "$STATE" ]]; then
  mkdir -p "$STATE"
  if [[ ! -s "$STATE/machine-id" ]]; then
    tr -d '-' < /proc/sys/kernel/random/uuid > "$STATE/machine-id"
    echo "[unity] new machine-id for $(hostname)"
  fi
  cp "$STATE/machine-id" /etc/machine-id
  mkdir -p /var/lib/dbus && ln -sf /etc/machine-id /var/lib/dbus/machine-id

  # The licensing client's state, plus the Package Manager cache under ~/.config/unity3d as a bonus.
  for dir in "$HOME/.local/share/unity3d" "$HOME/.config/unity3d" /usr/share/unity3d; do
    keep="$STATE/$(echo "${dir#/}" | tr '/' '_')"
    mkdir -p "$keep" "$(dirname "$dir")"
    if [[ -d "$dir" && ! -L "$dir" ]]; then
      cp -an "$dir/." "$keep/"  # seed from the image, never overwriting persisted state
      rm -rf "$dir"
    fi
    ln -sfn "$keep" "$dir"
  done
  echo "[unity] identity $(hostname) machine-id $(cat /etc/machine-id), state in $STATE"
elif [[ ! -s /etc/machine-id ]]; then
  # The licensing client wants one; an unpersisted pod gets a fresh one each start.
  tr -d '-' < /proc/sys/kernel/random/uuid > /etc/machine-id
fi

if [[ -n "${UNITY_LICENSING_SERVER:-}" ]]; then
  mkdir -p /usr/share/unity3d/config
  jq -n --arg url "$UNITY_LICENSING_SERVER" --arg toolset "${UNITY_LICENSING_TOOLSET:-}" '{
      licensingServiceBaseUrl: $url,
      enableEntitlementLicensing: true,
      enableFloatingApi: true,
      clientConnectTimeoutSec: 5,
      clientHandshakeTimeoutSec: 10
    } + (if $toolset == "" then {} else {toolset: $toolset} end)' \
    > /usr/share/unity3d/config/services-config.json
  echo "[unity] licensing server $UNITY_LICENSING_SERVER${UNITY_LICENSING_TOOLSET:+ toolset $UNITY_LICENSING_TOOLSET}"
fi

exec /maker-builder/scripts/docker-entrypoint.sh "$@"
