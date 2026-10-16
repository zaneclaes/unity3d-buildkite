#!/usr/bin/env python3
"""Build (and push) the buildkite-agent image (formerly maker-builder). Standard library only.

  ./build-agent.py              # build and push :latest and :dotnet-<sdk>-<date>
  ./build-agent.py --no-push    # build into the local docker only

Both tags point at the same image. The agents pull with `imagePullPolicy: IfNotPresent`, so roll out
by digest (or the dated tag), never :latest: pin moongate's buildkite/cabin/agent-amd64-patch.yaml and
unity.Dockerfile's BASE_IMAGE to the printed digest, then `zz app buildkite apply -e cabin`.

The versioned archives (buildkite-agent, AWS CLI, .NET SDK, regctl, kubectl) are downloaded once into
the cache (--cache-dir, default ~/.cache/unity3d-buildkite, or $UNITY_DOWNLOAD_CACHE) and handed to
the build as read-only contexts, so rebuilds and `buildx prune` never re-download them. With
$BUILD_ARTIFACTS_PATH set, missing archives are restored from <it>/unity3d-buildkite first and new ones
are backed up there (download_cache.py). Versions are the ARG defaults in agent.Dockerfile; bump them there.
"""
import argparse, datetime, json, os, re, subprocess, sys, tempfile, urllib.parse, urllib.request

import download_cache

ROOT = os.path.dirname(os.path.abspath(__file__))
DOCKERFILE = 'agent.Dockerfile'
REGISTRY = 'containers.oodalolly.camp'
REPOSITORY = 'buildkite-agent'
CACHE_DIR = os.environ.get('UNITY_DOWNLOAD_CACHE', os.path.expanduser('~/.cache/unity3d-buildkite'))

# Build context (`FROM scratch AS <name>` in agent.Dockerfile) -> the ARG that versions it, and the
# URLs its RUN step passes to fetch-cached. Must match agent.Dockerfile, or the build downloads (and
# fetch-cached says so in the log).
DOWNLOADS = {
    'dl-buildkite': ('BUILDKITE_VERSION', [
        'https://github.com/buildkite/agent/releases/download/v{BUILDKITE_VERSION}/'
        'buildkite-agent-linux-{BUILDKITE_ARCH}-{BUILDKITE_VERSION}.tar.gz']),
    'dl-awscli': ('AWSCLI_VERSION', [
        'https://awscli.amazonaws.com/awscli-exe-linux-x86_64-{AWSCLI_VERSION}.zip']),
    'dl-dotnet': ('DOTNET_VERSION', [
        'https://builds.dotnet.microsoft.com/dotnet/Sdk/{DOTNET_VERSION}/'
        'dotnet-sdk-{DOTNET_VERSION}-linux-{DOTNET_ARCH}.tar.gz']),
    'dl-regctl': ('REGCTL_VERSION', [
        'https://github.com/regclient/regclient/releases/download/v{REGCTL_VERSION}/regctl-linux-amd64']),
    'dl-kubectl': ('KUBECTL_VERSION', [
        'https://dl.k8s.io/release/v{KUBECTL_VERSION}/bin/linux/amd64/kubectl',
        'https://dl.k8s.io/release/v{KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256']),
}


def dockerfile_args():
    with open(os.path.join(ROOT, DOCKERFILE)) as f:
        return dict(re.findall(r'^ARG (\w+)="([^"]*)"', f.read(), re.M))


def prefetch(cache_dir, url, ctx):
    """Download url into ctx unless it is already there or in the download mirror. Writes go through
    a .part file, so a file that exists is complete. Some names (kubectl, regctl-linux-amd64) carry no version, which is why
    each context directory is per version."""
    path = os.path.join(ctx, os.path.basename(urllib.parse.urlparse(url).path))
    download_cache.restore(cache_dir, path)
    if os.path.isfile(path):
        print(f'cached: {path} ({os.path.getsize(path) / 1e6:.0f} MB)', flush=True)
        return path
    print(f'downloading {url}', flush=True)
    part = path + '.part'
    with urllib.request.urlopen(url, timeout=120) as r, open(part, 'wb') as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(part, path)
    return path


def stage_downloads(cache_dir, args):
    """One directory per archive and version, holding exactly that archive: a context's contents are
    part of its RUN step's cache key, so bumping one tool leaves the other layers cached."""
    contexts, files = {}, []
    for name, (version_arg, urls) in DOWNLOADS.items():
        ctx = os.path.join(cache_dir, 'agent', f'{name.removeprefix("dl-")}-{args[version_arg]}')
        os.makedirs(ctx, exist_ok=True)
        files += [prefetch(cache_dir, url.format(**args), ctx) for url in urls]
        contexts[name] = ctx
    # Before the build rather than after, so a failed build still keeps what it downloaded.
    download_cache.backup(cache_dir, files)
    return contexts


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--registry', default=REGISTRY)
    p.add_argument('--tag', help='override the dated tag (:latest is always applied too)')
    p.add_argument('--no-push', action='store_true', help='load into the local docker instead of pushing')
    p.add_argument('--cache-dir', default=CACHE_DIR, help='where archives are kept between builds')
    a = p.parse_args()

    args = dockerfile_args()
    contexts = stage_downloads(a.cache_dir, args)

    tag = a.tag or f'dotnet-{args["DOTNET_VERSION"]}' # -{datetime.datetime.now(datetime.UTC):%Y%m%d}
    images = [f'{a.registry}/{REPOSITORY}:{t}' for t in (tag, 'latest')]
    with tempfile.TemporaryDirectory() as tmp:
        meta = os.path.join(tmp, 'metadata.json')
        cmd = ['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--file', DOCKERFILE,
               *[arg for name, path in contexts.items() for arg in ('--build-context', f'{name}={path}')],
               '--metadata-file', meta, *[arg for image in images for arg in ('-t', image)],
               '--load' if a.no_push else '--push', '.']
        print('+', ' '.join(cmd), flush=True)
        subprocess.run(cmd, cwd=ROOT, check=True)
        digest = json.load(open(meta)).get('containerimage.digest') if os.path.exists(meta) else None

    print('\n'.join(images))
    if digest and not a.no_push:
        print(f'{a.registry}/{REPOSITORY}@{digest}')


if __name__ == '__main__':
    sys.exit(main())
