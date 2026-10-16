"""Mirror of the host download cache at $BUILD_ARTIFACTS_PATH/unity3d-buildkite (a NAS), so a wiped or
new machine restores archives over the LAN instead of the internet. Standard library only.

Paths in the mirror are the same as under the cache dir (downloads/<file>, agent/<name>-<version>/<file>).
contexts/ is not mirrored: build-unity.py rebuilds it from downloads/ with hard links on every run.
The mirror is best-effort: if it is unset or not mounted, or a copy fails, the build goes on (and downloads
what is missing) with a warning.
"""
import functools, os, shutil

_ROOT = os.environ.get('BUILD_ARTIFACTS_PATH')


@functools.cache  # warn about an unmounted share once, not per file
def _mirror():
    if not _ROOT:
        return None
    if not os.path.isdir(_ROOT):
        # Not mounted: never create /Volumes/<share>/... on the local disk by accident.
        print(f'warning: BUILD_ARTIFACTS_PATH {_ROOT} is not mounted; skipping the download mirror', flush=True)
        return None
    return os.path.join(_ROOT, 'unity3d-buildkite')


def _copy(src, dst):
    """Through a .part file, so a file that exists at dst is complete."""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    part = dst + '.part'
    shutil.copyfile(src, part)
    os.replace(part, dst)


def _intact(path, size):
    return os.path.isfile(path) and (size is None or os.path.getsize(path) == size)


def restore(cache_dir, path, size=None):
    """Copy path (a file under cache_dir) from the mirror when it is missing locally, or is not `size`
    bytes when a size is known. Returns True if it restored the file."""
    mirror = _mirror()
    if not mirror or _intact(path, size):
        return False
    remote = os.path.join(mirror, os.path.relpath(path, cache_dir))
    if not _intact(remote, size):
        return False
    print(f'restoring {path} from {remote}', flush=True)
    try:
        _copy(remote, path)
    except OSError as e:
        print(f'warning: restore from {remote} failed ({e}); downloading instead', flush=True)
        return False
    return True


def backup(cache_dir, paths):
    """Copy each file under cache_dir to the mirror unless a copy of the same size is already there."""
    mirror = _mirror()
    if not mirror:
        return
    for path in paths:
        remote = os.path.join(mirror, os.path.relpath(path, cache_dir))
        if not os.path.isfile(path) or _intact(remote, os.path.getsize(path)):
            continue
        print(f'backing up {path} to {remote}', flush=True)
        try:
            _copy(path, remote)
        except OSError as e:
            print(f'warning: backup to {remote} failed: {e}', flush=True)
