#!/usr/bin/env bash

echo "Copying Unity config to $(pwd)"
cp -r /var/lib/buildkite-agent/.local ./
cp -r /var/lib/buildkite-agent/.config ./
chown -R buildkite-agent:buildkite-agent .

unset SSH_KEYS
unset UNITY_LICENSE

vers=$(git tag -l "v*" | tail -1 | cut -c2-100)

cmd="/bin/ci/make.py $@ --work $(pwd) --unity_bin $(pwd)/bin --version $vers --build $BUILDKITE_BUILD_NUMBER --prerelease $BUILDKITE_BRANCH --commit $BUILDKITE_COMMIT"
echo "'buildkite-agent' will run: $cmd"
su - "buildkite-agent" -c "$cmd"
