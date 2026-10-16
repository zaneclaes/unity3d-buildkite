#!/bin/bash
set -euo pipefail

# DIR=/docker-entrypoint.d

# if [[ -d "$DIR" ]] ; then
#   echo "Executing scripts in $DIR"
#   /bin/run-parts --exit-on-error "$DIR"
# fi

SSH="$HOME/.ssh"
if [[ -d "/etc/secrets" ]]; then
  mkdir -p "$SSH"
  echo "Copying /etc/secrets/* to $SSH"
  cp /etc/secrets/id* "${SSH}/"
  chmod 600 /root/.ssh/*
  # chmod 600 "${SSH}/*"
else
  echo "Warning: /etc/secrets did not exist ($SSH may be misconfigured)"
fi

exec /buildkite-agent "$@"
