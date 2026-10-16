#!/usr/bin/env python3
"""Build (and push) the buildkite-unity image (the Unity lane). Standard library only.

  ./build-unity.py                      # unity.Dockerfile defaults: version, changeset, modules, base image
  ./build-unity.py resolve 6000.6.6f1   # print a release's changeset and module sizes, build nothing
  ./build-unity.py --version 6000.6.6f1 --modules webgl,windows-mono --no-push

The tag is versioned like maker-builder's (`<unity>-<modules>-<date>`): agents pull with
`imagePullPolicy: IfNotPresent`, so a reused tag would never roll out. Pin moongate's
buildkite/cabin/agent-unity.yaml to the printed digest, then `zz app buildkite apply -e cabin`.

Unity's archives are downloaded once into the cache (--cache-dir, default ~/.cache/unity3d-buildkite,
or $UNITY_DOWNLOAD_CACHE) and handed to the build as read-only contexts, so rebuilds, `buildx prune`
and base-image bumps never re-download them. A cached file is reused when its size matches; the
build itself re-checks every md5. With $BUILD_ARTIFACTS_PATH set, missing archives are restored from
<it>/unity3d-buildkite first and new ones are backed up there (download_cache.py).
"""
import argparse, datetime, json, os, re, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
DOCKERFILE = 'unity.Dockerfile'
sys.path.insert(0, os.path.join(ROOT, 'unity'))
import unity_release  # noqa: E402
import download_cache  # noqa: E402

REGISTRY = 'containers.oodalolly.camp'
REPOSITORY = 'buildkite-unity'
CACHE_DIR = os.environ.get('UNITY_DOWNLOAD_CACHE', os.path.expanduser('~/.cache/unity3d-buildkite'))


def dockerfile_default(name):
    with open(os.path.join(ROOT, DOCKERFILE)) as f:
        m = re.search(rf'^ARG {name}="([^"]*)"', f.read(), re.M)
    if not m:
        raise SystemExit(f'{DOCKERFILE} has no ARG {name}="..." default')
    return m.group(1)


def stage_downloads(cache_dir, version, modules, download, picked):
    """Download what is missing into <cache>/downloads, then hard-link exactly the files each install
    step needs into its own context directory. A context's contents are part of that RUN step's cache
    key, so extra files would rebuild a layer that has not changed (and cost a copy into the VM)."""
    downloads = os.path.join(cache_dir, 'downloads')
    items = unity_release.prefetch_items(download, picked)
    paths = [os.path.join(downloads, unity_release.cache_name(url)) for _name, url, _integrity, _size in items]
    for path, (_name, _url, _integrity, size) in zip(paths, items):
        download_cache.restore(cache_dir, path, size)
    unity_release.prefetch(items, downloads)
    # Before the build rather than after, so a failed build still keeps what it downloaded.
    download_cache.backup(cache_dir, paths)
    contexts = {}
    for name, items in (('unity-editor-downloads', [download]),
                        ('unity-module-downloads', picked)):
        ctx = os.path.join(cache_dir, 'contexts', version, name, '_'.join(modules) if items is picked else 'editor')
        want = {unity_release.cache_name(item['url']) for item in items}
        os.makedirs(ctx, exist_ok=True)
        # Synced in place rather than recreated, so nothing about the context changes between builds.
        for file in set(os.listdir(ctx)) - want:
            os.remove(os.path.join(ctx, file))
        for file in want:
            src, dst = os.path.join(downloads, file), os.path.join(ctx, file)
            if not (os.path.exists(dst) and os.path.samefile(src, dst)):
                if os.path.exists(dst):
                    os.remove(dst)
                os.link(src, dst)
        contexts[name] = ctx
    return contexts


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('command', nargs='?', default='build', choices=['build', 'resolve'])
    p.add_argument('resolve_version', nargs='?', help='resolve: the version to look up')
    p.add_argument('--version', '-v', default=dockerfile_default('UNITY_VERSION'))
    p.add_argument('--modules', '-m', default=dockerfile_default('UNITY_MODULES'))
    p.add_argument('--base', default=dockerfile_default('BASE_IMAGE'), help='agent image to build FROM (./build-agent.py builds it)')
    p.add_argument('--registry', default=REGISTRY)
    p.add_argument('--tag', help='override the computed tag')
    p.add_argument('--no-push', action='store_true', help='load into the local docker instead of pushing')
    p.add_argument('--cache-dir', default=CACHE_DIR, help='where Unity archives are kept between builds')
    a = p.parse_args()

    version = a.resolve_version or a.version
    modules = [m for m in a.modules.split(',') if m]
    release, download = unity_release.resolve(version)
    changeset = release['shortRevision']
    picked = unity_release.select_modules(download, modules)
    total = unity_release._size(download) + sum(unity_release._size(m) for m in picked)
    print(f'Unity {version} ({changeset}), released {release["releaseDate"][:10]}, {release.get("stream")}'
          f'{", recommended" if release.get("recommended") else ""}; '
          f'modules {",".join(modules) or "-"}; {total / 1e9:.1f} GB of archives')
    if a.command == 'resolve':
        return

    if version == dockerfile_default('UNITY_VERSION') and changeset != dockerfile_default('UNITY_CHANGESET'):
        raise SystemExit(f'Unity re-released {version} as {changeset}; update ARG UNITY_CHANGESET in {DOCKERFILE}')

    contexts = stage_downloads(a.cache_dir, version, modules, download, picked)

    tag = a.tag or f'{version}' #-{"_".join(modules)}'
    image = f'{a.registry}/{REPOSITORY}:{tag}'
    with tempfile.TemporaryDirectory() as tmp:
        meta = os.path.join(tmp, 'metadata.json')
        cmd = ['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--file', DOCKERFILE,
               '--build-arg', f'BASE_IMAGE={a.base}',
               '--build-arg', f'UNITY_VERSION={version}',
               '--build-arg', f'UNITY_CHANGESET={changeset}',
               '--build-arg', f'UNITY_MODULES={",".join(modules)}',
               *[arg for name, path in contexts.items() for arg in ('--build-context', f'{name}={path}')],
               '--metadata-file', meta, '-t', image,
               # --push sends the layers straight from the builder; --load-then-push would copy ~19 GB twice.
               '--load' if a.no_push else '--push', '.']
        print('+', ' '.join(cmd), flush=True)
        subprocess.run(cmd, cwd=ROOT, check=True)
        digest = json.load(open(meta)).get('containerimage.digest') if os.path.exists(meta) else None

    print(image)
    if digest and not a.no_push:
        print(f'{a.registry}/{REPOSITORY}@{digest}')


if __name__ == '__main__':
    main()
