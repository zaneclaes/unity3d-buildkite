#!/usr/bin/env python3
import requests, yaml, subprocess

def get_unity_versions(fn):
    url = f'https://gitlab.com/gableroux/unity3d/raw/master/ci-generator/{fn}'
    data = yaml.load(requests.get(url).text)
    if not data or len(data) <= 0:
        raise Exception(f'Failed to load yaml data from: {url}')
    return data

def build(unity_version, component = None):
    tag = unity_version
    if component: tag += '-' + component
    img = f'inzania/unity3d-buildkite:{tag}'
    print(f'Building {img}')
    subprocess.run(f'docker build --build-arg UNITY_TAG={tag} . -t {img}', shell=True, check=True)
    subprocess.run(f'docker push {img}', shell=True, check=True)

if __name__ == "__main__":
  vers = get_unity_versions('unity_versions.yml')
  latest = list(vers)[0]
  b = input(f'Build latest version? ({latest})? [Y/n]: ')
  if b.lower() == 'n':
      vers = get_unity_versions('unity_versions.old.yml')
      x = 0
      for v in vers:
          print(f'{x}: {v}')
          x += 1
      b = int(input(f'Which version? '))
      unity_version = list(vers)[b]
  else:
      unity_version = latest

  components = [None, 'ios', 'android', 'mac', 'windows', 'webgl', 'facebook']
  for c in components:
      build(unity_version, c)

