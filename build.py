#!/usr/bin/env python3
import os, requests, yaml, subprocess, argparse, json, shutil

component_map = {
    None: 'Unity',
    'linux': 'Unity',
    'ios': 'iOS',
    'android': 'Android',
    'mac': 'Mac,Mac-Mono',
    'windows': 'Windows,Windows-Mono',
    'webgl': 'WebGL',
    'facebook': 'Facebook-Games'
}

# Determine the appropriate docker tag for a version+component
def get_version_tag(version, component):
    tag = version
    if component and len(component) > 0: tag += '-' + component
    return tag

# Print a message wrapped with div-lines
def _div(msg):
    print('-------------------------------------------')
    print(msg)
    print('-------------------------------------------')

# Build new unity3d versions from scratch
def build(version, components, registry, push, quiet):
    re = requests.get('https://public-cdn.cloud.unity3d.com/hub/prod/releases-linux.json').text
    releases = json.loads(re)
    choices = {}
    groups = {}
    versions = {}

    for group in releases:
        versions[group] = []
        for release in releases[group]:
            v = release["version"]
            url = release["downloadUrl"]
            versions[group].append(v)
            groups[v] = group
            choices[v] = url.replace('LinuxEditorInstaller/Unity.tar.xz', f'UnitySetup-{v}')
            if not version:
                print(f'{len(choices)}: [{group}] {v}')
    if not version:
        c = int(input(f'Which version (1-{len(choices)})? ')) - 1
        version = list(choices)[c]
    if not version in list(choices):
        raise Exception(f'Version {version} is not currently available for download.')
    download_url = choices[version]
    group = groups[version]
    if group == 'official':
        if version == versions['official'][len(versions['official'])-1]:
            group = 'latest'
        else:
            group = version.split('.')[0]
    elif group == 'beta' and 'a' in version:
        group = 'alpha'

    for c in components:
        img = f'{registry}:{get_version_tag(version, c)}'
        build_args = [f'DOWNLOAD_URL={download_url}', f'COMPONENTS={component_map[c]}']
        _div(f'Building {img} ({group}) with components: {component_map[c]}')

        # Create a single Dockerfile of all the component Dockerfiles
        df = 'docker/Dockerfile'
        if os.path.isfile(df): os.remove(df)
        cfs = [f'docker/base.Dockerfile', f'docker/{c}.Dockerfile', 'docker/unity.Dockerfile']
        with open(df, 'w+') as dst:
            for cf in cfs:
                if not os.path.isfile(cf): continue
                with open(cf) as src:  dst.write(src.read())

        # Build & Push docker image
        build = 'docker build'
        if quiet: build += ' -q'
        for a in build_args: build += f' --build-arg {a}'
        subprocess.run(f'{build} ./docker -t {img}', shell=True, check=True)
        if push:
            _div(f'pushing {img}')

            latest = f'{registry}:{get_version_tag(group, c)}'
            subprocess.run(f'docker tag {img} {latest}', shell=True, check=True)
            subprocess.run(f'docker push {registry} &', shell=True, check=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', '-v',  help='Which Unity version to build')
    parser.add_argument('--components', '-c', help='Comma-separated components to build')
    parser.add_argument('--dst', '-d', default = 'inzania/unity3d-buildkite',
        help='The repository with which to tag the built image')
    parser.add_argument('--no-push', action='store_true',
        help='Push the built images?')
    parser.add_argument('--verbose', action='store_true',
        help='Include Docker output?')
    opts = parser.parse_args()

    if opts.components: components = opts.components.split(',')
    else: components = list(component_map)

    build(opts.version, components, opts.dst, not opts.no_push, not opts.verbose)
