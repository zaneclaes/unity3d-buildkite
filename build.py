#!/usr/bin/env python3
import requests, yaml, subprocess, argparse, json


def download_unity_ci_dockerfile(src, dst = None):
    if not dst: dst = src
    url = f'https://gitlab.com/gableroux/unity3d/raw/master/docker/{src}'
    with open(f'docker/{dst}', 'w+') as f: f.write(requests.get(url).text)

# Determine the appropriate docker tag for a version+component
def get_version_tag(version, component):
    tag = version
    if component and len(component) > 0: tag += '-' + component
    return tag

def _docker_build(img, dockerfile, build_args = [], directory = './docker'):
    build = 'docker build'
    for a in build_args: build += f' --build-arg {a}'
    bf = f'-f {dockerfile}' if dockerfile else ''
    print(f'{build} {bf} {directory} -t {img}')
    subprocess.run(f'{build} {bf} {directory} -t {img}', shell=True, check=True)

# Build the final image
def build(unity_version, src, dst, component, push):
    tag = get_version_tag(unity_version, component)
    img = f'{dst}:{tag}'
    print(f'Building {img}')
    _docker_build(img, 'docker/buildkite.Dockerfile', [f'BASE_IMAGE={src}:{tag}'])
    subprocess.run(f'docker tag {img} {dst}:{get_version_tag("latest", component)}', shell=True, check=True)
    if push: subprocess.run(f'docker push {dst}', shell=True, check=True)

# Check Gableroux's repo for the published versions
def get_unity_ci_versions(fn):
    url = f'https://gitlab.com/gableroux/unity3d/raw/master/ci-generator/{fn}'
    data = yaml.load(requests.get(url).text)
    return data

# Build new unity3d versions from scratch
def build_unity_base_images(components, registry = 'inzania/unity3d'):
    re = requests.get('https://public-cdn.cloud.unity3d.com/hub/prod/releases-linux.json').text
    releases = json.loads(re)
    choices = {}

    for group in releases:
        for release in releases[group]:
            v = release["version"]
            url = release["downloadUrl"]
            choices[v] = url.replace('LinuxEditorInstaller/Unity.tar.xz', f'UnitySetup-{v}')
            print(f'{len(choices)}: [{group}] {v}')
    c = int(input(f'Which version (1-{len(choices)})? ')) - 1
    unity_version = list(choices)[c]
    download_url = choices[unity_version]

    for c in components:
        img = f'{registry}/{get_version_tag(unity_version, c)}'
        print(f'Building {img}')
        _docker_build(img, 'unity.Dockerfile', [f'DOWNLOAD_URL={download_url}'])
        subprocess.run(cmd, shell=True, check=True)


if __name__ == "__main__":
    components = [None, 'ios', 'android', 'mac', 'windows', 'webgl', 'facebook']

    parser = argparse.ArgumentParser()
    parser.add_argument('--components', '-c', help='Comma-separated components to build')
    parser.add_argument('--src', default = 'gableroux/unity3d',
        help='The repository with the base image')
    parser.add_argument('--dst', default = 'inzania/unity3d-buildkite',
        help='The repository with which to tag the built image')
    parser.add_argument('--no-push', action='store_true',
        help='Push the built images?')
    opts = parser.parse_args()

    if opts.components: components = opts.components.split(',')

    vers = get_unity_ci_versions('unity_versions.yml')
    latest = list(vers)[0]
    b = input(f'Build latest version? ({latest})? [Y/n]: ')
    if b.lower() == 'n':
        vers = get_unity_ci_versions('unity_versions.old.yml')
        x = 0
        for v in vers:
            print(f'{x}: {v}')
            x += 1
        b = int(input(f'Which version? '))
        unity_version = list(vers)[b]
    else:
        unity_version = latest

    for c in components: build(unity_version, opts.src, opts.dst, c, not opts.no_push)
