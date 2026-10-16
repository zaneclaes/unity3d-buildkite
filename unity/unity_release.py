#!/usr/bin/env python3
"""Resolve and install a Unity Linux Editor and its modules from Unity's release API.

Standard library only: it runs inside the image build (debian trixie's python3) and on the host
(build-unity.py imports it to validate a version before starting a multi-GB docker build).

  unity_release.py resolve <version> [--modules webgl,windows-mono] [--json]
  unity_release.py install <version> --modules webgl,windows-mono --dest /opt/unity [--changeset X]
                                     [--skip-editor] [--skip-modules] [--cache-dir DIR ...]
  unity_release.py prefetch <version> --modules webgl,windows-mono --cache-dir DIR

Downloads are expensive, so build-unity.py prefetches every archive once into a host-side cache and the
image build reads them from there (--cache-dir, a read-only bind mount); `install` only goes to the
network for a file the cache lacks, and says so.

Archive layouts, verified against 6000.6.5f1:
  - The editor and every TAR_XZ module are rooted at the install root (`Editor/...`, `./Editor/...`),
    so they extract into --dest regardless of the API's `destination`.
  - PKG modules (windows-mono, mac-mono, android) are macOS xar archives. The cpio payload inside
    `TargetSupport.pkg.tmp/Payload` is rooted at the module's `destination`. Their pre/postinstall
    scripts are macOS-only (PlistBuddy, chown root:wheel) and are not run.
  - ZIP submodules (Android SDK/NDK/JDK) extract into `destination`, then `extractedPathRename`.
  - `integrity` is "md5-<base64 digest>"; it is empty for some submodules, which are then unverified.
"""
import argparse, base64, hashlib, json, os, shutil, struct, subprocess, sys, tempfile, urllib.parse
import urllib.request, xml.etree.ElementTree as ET, zlib

API = 'https://services.api.unity.com/unity/editor/release/v1/releases'
CHUNK = 4 * 1024 * 1024
CACHE_DIRS = []  # searched by file name before downloading; set by --cache-dir


def log(msg):
    print(f'[unity_release] {msg}', flush=True)


def resolve(version):
    """The release record for `version` plus its Linux x86_64 download."""
    q = urllib.parse.urlencode({'version': version, 'platform': 'LINUX', 'architecture': 'X86_64', 'limit': 5})
    with urllib.request.urlopen(f'{API}?{q}', timeout=60) as r:
        results = json.load(r)['results']
    release = next((x for x in results if x['version'] == version), None)
    if not release:
        raise SystemExit(f'Unity {version} is not in the release API for Linux x86_64.')
    download = next(d for d in release['downloads'] if d['platform'] == 'LINUX' and d['architecture'] == 'X86_64')
    return release, download


def _flatten(modules):
    for m in modules:
        yield m
        yield from _flatten(m.get('subModules') or [])


def select_modules(download, ids):
    """The requested modules plus their required submodules, in install order (parents first)."""
    top = {m['id']: m for m in download['modules']}
    unknown = [i for i in ids if i not in top]
    if unknown:
        raise SystemExit(f'Unknown module(s) {unknown}; available: {sorted(top)}')
    picked = []

    def add(m):
        picked.append(m)
        for s in m.get('subModules') or []:
            if s.get('required'):
                add(s)

    for i in ids:
        add(top[i])
    return picked


def _size(m):
    return m['downloadSize']['value']


def _dest(m, unity_path):
    return m['destination'].replace('{UNITY_PATH}', unity_path)


def _md5_of(integrity):
    if integrity and integrity.startswith('md5-'):
        return base64.b64decode(integrity[4:]).hex()
    return None


def _verify(name, digest, integrity):
    want = _md5_of(integrity)
    if not want:
        log(f'{name}: no md5 published, unverified')
    elif digest != want:
        raise SystemExit(f'{name}: md5 mismatch (got {digest}, want {want}); if it came from a cache, '
                         f'delete the cached file and rebuild')
    else:
        log(f'{name}: md5 ok')


def cache_name(url):
    """Unity's archive names carry the version (Unity-6000.6.5f1.tar.xz), so the URL's file name is a
    unique cache key."""
    return os.path.basename(urllib.parse.urlparse(url).path)


def cached(url):
    for d in CACHE_DIRS:
        path = os.path.join(d, cache_name(url))
        if os.path.isfile(path):
            return path
    return None


def _md5_file(path):
    md5 = hashlib.md5()
    with open(path, 'rb') as f:
        while chunk := f.read(CHUNK):
            md5.update(chunk)
    return md5.hexdigest()


def _stream(url, sink):
    """Feed url (from the cache when present) into sink(chunk); returns the md5 hex digest."""
    md5 = hashlib.md5()
    path = cached(url)
    if path:
        log(f'using cached {path}')
        src = open(path, 'rb')
    else:
        log(f'not cached, downloading {url}')
        src = urllib.request.urlopen(url, timeout=120)
    with src:
        while chunk := src.read(CHUNK):
            md5.update(chunk)
            sink(chunk)
    return md5.hexdigest()


def _download(url, path):
    with open(path, 'wb') as f:
        return _stream(url, f.write)


def _local_verified(url, name, integrity, tmp):
    """A verified local copy of url: the cached file itself, or a fresh download into tmp."""
    path = cached(url)
    if path:
        log(f'using cached {path}')
        _verify(name, _md5_file(path), integrity)
        return path, False
    path = os.path.join(tmp, cache_name(url))
    _verify(name, _download(url, path), integrity)
    return path, True


def prefetch(items, cache_dir):
    """Download each (name, url, integrity, size) into cache_dir unless an intact copy is there.
    A cached file is trusted by size (hashing ~7 GB every build is slow); install re-verifies md5."""
    os.makedirs(cache_dir, exist_ok=True)
    for name, url, integrity, size in items:
        path = os.path.join(cache_dir, cache_name(url))
        if os.path.isfile(path) and os.path.getsize(path) == size:
            log(f'{name}: cached ({size / 1e9:.2f} GB)')
            continue
        log(f'{name}: downloading {size / 1e9:.2f} GB from {url}')
        part = path + '.part'
        md5 = hashlib.md5()
        with urllib.request.urlopen(url, timeout=120) as r, open(part, 'wb') as f:
            while chunk := r.read(CHUNK):
                md5.update(chunk)
                f.write(chunk)
        _verify(name, md5.hexdigest(), integrity)  # exits on mismatch, leaving only the .part
        os.replace(part, path)


def prefetch_items(download, picked, editor=True):
    items = [('editor', download['url'], download.get('integrity'), _size(download))] if editor else []
    return items + [(m['id'], m['url'], m.get('integrity'), _size(m)) for m in picked]


def _extract_tar_xz(url, dest, name, integrity):
    """Stream (from the cache or the network) straight into tar, so the archive is never copied. A
    bad md5 fails the RUN step, so a corrupt extraction is never committed as a layer."""
    os.makedirs(dest, exist_ok=True)
    tar = subprocess.Popen(['sh', '-c', 'xz -dc -T0 | tar -x -C "$0"', dest], stdin=subprocess.PIPE)
    try:
        digest = _stream(url, tar.stdin.write)
    finally:
        tar.stdin.close()
    if tar.wait():
        raise SystemExit(f'{name}: tar exited {tar.returncode}')
    _verify(name, digest, integrity)


def xar_payload(pkg_path):
    """(offset, length) of the Payload file inside a xar (.pkg) archive."""
    with open(pkg_path, 'rb') as f:
        magic, header_size, _ver, toc_len, _toc_raw, _alg = struct.unpack('>4sHHQQI', f.read(28))
        if magic != b'xar!':
            raise SystemExit(f'{pkg_path} is not a xar archive')
        f.seek(header_size)
        toc = ET.fromstring(zlib.decompress(f.read(toc_len)))
    heap = header_size + toc_len
    for node in toc.iter('file'):
        if node.findtext('name') != 'Payload':
            continue
        data = node.find('data')
        style = data.find('encoding').get('style')
        if style != 'application/octet-stream':
            raise SystemExit(f'{pkg_path}: unsupported Payload encoding {style}')
        return heap + int(data.findtext('offset')), int(data.findtext('length'))
    raise SystemExit(f'{pkg_path}: no Payload in xar TOC')


def _extract_pkg(url, dest, name, integrity, tmp):
    pkg, temporary = _local_verified(url, name, integrity, tmp)
    offset, length = xar_payload(pkg)
    os.makedirs(dest, exist_ok=True)
    with open(pkg, 'rb') as f:
        f.seek(offset)
        if f.read(2) != b'\x1f\x8b':
            raise SystemExit(f'{name}: Payload is not gzip cpio (pbzx payloads are not supported)')
        f.seek(offset)
        cpio = subprocess.Popen(['sh', '-c', 'gzip -dc | cpio -idmu --quiet --no-absolute-filenames'],
                                stdin=subprocess.PIPE, cwd=dest)
        remaining = length
        while remaining:
            chunk = f.read(min(CHUNK, remaining))
            cpio.stdin.write(chunk)
            remaining -= len(chunk)
        cpio.stdin.close()
        if cpio.wait():
            raise SystemExit(f'{name}: cpio exited {cpio.returncode}')
    if temporary:
        os.remove(pkg)


def _extract_zip(m, dest, unity_path, tmp):
    z, temporary = _local_verified(m['url'], m['id'], m.get('integrity'), tmp)
    os.makedirs(dest, exist_ok=True)
    subprocess.run(['unzip', '-q', '-o', z, '-d', dest], check=True)  # unzip keeps exec bits; zipfile does not
    if temporary:
        os.remove(z)
    rename = m.get('extractedPathRename')
    if rename:
        src, dst = (rename[k].replace('{UNITY_PATH}', unity_path) for k in ('from', 'to'))
        if os.path.exists(src) and src != dst:
            if os.path.exists(dst):
                # NDK's rename targets its own parent: move children up instead.
                for child in os.listdir(src):
                    shutil.move(os.path.join(src, child), dst)
                os.rmdir(src)
            else:
                shutil.move(src, dst)


def install_editor(download, unity_path):
    log(f'editor: {download["url"]} ({_size(download) / 1e9:.1f} GB)')
    _extract_tar_xz(download['url'], unity_path, 'editor', download.get('integrity'))


def install_module(m, unity_path, tmp):
    dest = _dest(m, unity_path)
    log(f'{m["id"]}: {m["type"]} {m["url"]} ({_size(m) / 1e6:.0f} MB) -> {dest}')
    kind = m['type']
    if kind == 'TAR_XZ':
        _extract_tar_xz(m['url'], unity_path, m['id'], m.get('integrity'))
    elif kind == 'PKG':
        _extract_pkg(m['url'], dest, m['id'], m.get('integrity'), tmp)
    elif kind == 'ZIP':
        _extract_zip(m, dest, unity_path, tmp)
    else:
        raise SystemExit(f'{m["id"]}: module type {kind} is not supported')


def write_modules_json(download, picked, unity_path):
    """What Unity Hub writes next to an install: every module, `selected` when installed."""
    installed = {m['id'] for m in picked}
    out = []
    for m in _flatten(download['modules']):
        entry = {k: v for k, v in m.items() if k != 'subModules'}
        entry['downloadUrl'] = m['url']
        entry['visible'] = not m.get('hidden', False)
        entry['selected'] = m['id'] in installed
        out.append(entry)
    with open(os.path.join(unity_path, 'modules.json'), 'w') as f:
        json.dump(out, f, indent=2)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('command', choices=['resolve', 'install', 'prefetch'])
    p.add_argument('version')
    p.add_argument('--modules', default='', help='comma-separated module ids, e.g. webgl,windows-mono')
    p.add_argument('--changeset', help='fail unless the release has this changeset (shortRevision)')
    p.add_argument('--dest', help='install root, i.e. UNITY_PATH (install only)')
    p.add_argument('--skip-editor', action='store_true')
    p.add_argument('--skip-modules', action='store_true')
    p.add_argument('--cache-dir', action='append', default=[],
                   help='install: look here for archives first (repeatable); prefetch: download here')
    p.add_argument('--json', action='store_true', help='resolve: print machine-readable output')
    a = p.parse_args()
    CACHE_DIRS.extend(a.cache_dir)

    release, download = resolve(a.version)
    changeset = release['shortRevision']
    if a.changeset and a.changeset != changeset:
        raise SystemExit(f'Unity {a.version} has changeset {changeset}, expected {a.changeset}')
    picked = select_modules(download, [m for m in a.modules.split(',') if m])

    if a.command == 'resolve':
        info = {
            'version': release['version'], 'changeset': changeset, 'releaseDate': release['releaseDate'],
            'stream': release.get('stream'), 'recommended': release.get('recommended'),
            'editor': {'url': download['url'], 'downloadSize': _size(download)},
            'modules': [{'id': m['id'], 'type': m['type'], 'url': m['url'], 'downloadSize': _size(m)} for m in picked],
            'available': [m['id'] for m in download['modules']],
        }
        if a.json:
            print(json.dumps(info, indent=2))
        else:
            print(f'Unity {info["version"]} ({changeset}) released {info["releaseDate"][:10]}, '
                  f'{info["stream"]}{", recommended" if info["recommended"] else ""}')
            print(f'  editor  {_size(download) / 1e9:6.2f} GB')
            for m in picked:
                print(f'  {m["id"]:<40} {_size(m) / 1e9:6.2f} GB  {m["type"]}')
            total = _size(download) + sum(_size(m) for m in picked)
            print(f'  total download {total / 1e9:.1f} GB; available modules: {", ".join(info["available"])}')
        return

    if a.command == 'prefetch':
        if len(a.cache_dir) != 1:
            raise SystemExit('prefetch needs exactly one --cache-dir')
        prefetch(prefetch_items(download, [] if a.skip_modules else picked, not a.skip_editor), a.cache_dir[0])
        return

    if not a.dest:
        raise SystemExit('install needs --dest')
    os.makedirs(a.dest, exist_ok=True)
    if not a.skip_editor:
        install_editor(download, a.dest)
    if not a.skip_modules:
        with tempfile.TemporaryDirectory() as tmp:
            for m in picked:
                install_module(m, a.dest, tmp)
    # modules.json reflects every module asked for across both install passes.
    write_modules_json(download, picked, a.dest)
    with open(os.path.join(a.dest, 'version'), 'w') as f:
        f.write(f'{release["version"]}\n')
    log('done')


if __name__ == '__main__':
    main()
