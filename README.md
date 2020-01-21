## Unity3D-Buildkite

A docker container that can build Unity projects, with support for Buildkite (CI). [Read all about this project](https://www.technicallywizardry.com/open-source-unity-cloud-build-ci-buildkite/). This page serves as an installation/technical guide.

Meant to be powerful and simple, this implementation requires no changes to the Unity project itself.

Derivative of [Gableroux's GitLab Unity3D CI tool](https://gitlab.com/gableroux/unity3d).

Skip to the bottom for help with deployment, determining which Unity versions are available, or building your own versions of the container.

## Capabilities

### Building for Any Platform

The docker container includes `/bin/ci/make.py`. Running this script without any arguments will provide hints as to how to use it.

### Example

Assuming that you are already in the folder which contains the Unity project, here are sample build commands:
```
/bin/ci/make.py unity build my-project iOS "Assets/Scenes/Client.unity"
/bin/ci/make.py unity build my-project Android "Assets/Scenes/Server.unity"
/bin/ci/make.py unity build my-project StandaloneLinux64 "Assets/Scenes/Server.unity"
```

The first parameter was the name (just like you'd type in when you use the "Build" window in Unity), and the second is the platform (i.e., one of Unity's `BuildTarget` values). The third defines the scenes to include (comma-separated). Sample output from a build step is as follows:

```
[INFO] [Unity] [Build] [Information] [11:14:00:638496] Ready to build.
[INFO] [Unity] [Build] [Information] [11:14:00:652722] Writing "0.0.1-master+59" to "Assets/Resources/Version.txt"
[INFO] [Unity] [Build] [Information] [11:14:00:655389] Writing "747516b350f3b98d5eabee17a1890ccf95507642" to "Assets/Resources/Commit.txt"
[INFO] [Unity] [Build] [Information] [11:14:00:658113] Refreshing assets for "<my-project bin=./bin/StandaloneLinux64/my-project BuildTarget=StandaloneLinux64 scenes=Assets/Scenes/Server.unity >"
[INFO] [Unity] [Build] [Information] [11:14:00:786332] Asset Refresh Complete.
[INFO] [Unity] [Build] [Information] [11:14:00:787405] Building "<my-project bin=./bin/StandaloneLinux64/my-project BuildTarget=StandaloneLinux64 scenes=Assets/Scenes/Server.unity >" to "./bin/StandaloneLinux64/my-project"
[INFO] [Unity] [Build] [Information] [11:14:00:789864] Checking pre-conditions for StandaloneLinux64.
[INFO] [Unity] [Build] [Information] [11:14:00:790539] BuildPipeline.BuildPlayer "Assets/Scenes/Server.unity" => "./bin/StandaloneLinux64/my-project/my-project"
[INFO] [Unity] [Build] [Information] [11:14:31:219072] Writing Succeeded to "./bin/StandaloneLinux64/build.json"
[INFO] [Unity] built 43889536b in 00:00:30.3046029
```

### Building on iOS

The build agent will automatically run `pod install`, generating the appropriate workspace file. The `ios` agent also has `xcbuild` and `ninja` installed. However, due to [various reasons](https://github.com/facebook/xcbuild/issues/37), a Linux machine cannot actually build for an iOS target (especially when assets are involved). The follownig command, for example, makes it to the `CompileAssetCatalog` step before failing:

```
xcbuild -workspace Unity-iPhone.xcworkspace -scheme Unity-iPhone -project Unity-iPhone -configuration ReleaseForRunning -destination 'Generic iOS Device'
```

To actually build the `.app`, you can download the resulting project artifact onto a Mac OSX build machine in order to build the project with Xcode. `xcbuild` may still be useful for running unit tests and the like.

### Versioning

Careful eyes will notice that the CI automatically writes a `Version.txt` and `Commit.txt` to the `Resources` directory, so that the runtime project can be aware of these values. You can use the `git tag -a v0.0.1` to specify the current SemVer. The CI will automatically determine the branch and build number (`master` and `59` in the example above), as well as the Git commit SHA.

### Headless Servers

In addition, this CI can build a docker container for a headless server:

```
/bin/ci/make.py docker build my-project StandaloneLinux64 inzania
```

This will take the output from the unity build step and package it into a docker container that can be deployed to a server.

### Advanced Configuration

Part of the "magic" is accomplished by the Unity build tool is to copy some build tools into `Editor/UnityCI` (within your project) to assist in the build process. If you overwrite the `--unity_func` flag to the build command, where the default value is `Editor.UnityCI.Build.Compile`, it will instead call your custom build function and not copy the pre-packaged build scripts.

### Running Locally

The build scripts should work on your host machine, instead of within the Docker container, if you prefer. Just run the `bin/ci/make.py` script from this repository.

### Sample Buildkite Pipeline

Here is my pipeline for one of the games I'm working on. It builds for Linux, then logs in to ECR and pushes the docker container to AWS, as well as Android and iOS. It assumes that the CI is deployed via the Kubernetes helm chart, below, which supplies the agent tags (`unity_module`).

```
steps:
  - command: '/bin/ci/agent.sh unity build sample-project StandaloneLinux64 "Assets/Scenes/Server.unity" && /bin/ci/make.py docker build cardgrid StandaloneLinux64 inzania/sample-project'
    label: ":linux: server :docker:"
    agents:
      unity_module: "true"
    artifact_paths:
      - "bin/StandaloneLinux64/**"

  - command: '/bin/ci/agent.sh unity build sample-project Android "Assets/Scenes/Client.unity"'
    label: ":android: android"
    agents:
      unity_module: "android"
    artifact_paths:
      - "bin/Android/**"

  - command: '/bin/ci/agent.sh unity build sample-project iOS "Assets/Scenes/Client.unity"'
    label: ":ios: iOS"
    agents:
      unity_module: "ios"
    artifact_paths:
      - "bin/iOS/**"
```

## Deployment

The easiest way to deploy is to use the Helm chart, below. But you could also just run the Docker container:

```
docker run --rm inzania/unity3d-buildkite:latest
```

However, you will need a Unity license. Once the image is running, open a shell in the container and run:

```
su -m - "buildkite-agent" -c "/bin/ci/make.py unity activate --unity_username=XXX --unity_password=YYY"
```

This will output the license file and instructions for activating it. Once done, you can set the license file either by mounting it to `/var/lib/buildkite-agent/.local/share/unity3d/Unity/Unity_lic.ulf` or with an enviroment variable. There are two special environment variables:

* `SSH_KEYS`: if set, the contents will be written to the `~/.ssh/id_rsa` file as a Buildkite pre-checkout hook.
* `UNITY_LICENSE`: if set, the contents will be written to the Unity license file location for activation.

### Kubernetes Helm Chart

Included in this repository is a Helm chart to make deployment easy. After checking out this repository, from the root folder:

```
helm upgrade --install builder helm/unity3d-buildkite \
  --set "env.UNITY_LICENSE=contents_of_license_file" \
  --set "env.BUILDKITE_AGENT_TOKEN=foo"
```

Anything you provide to `--set "env.XXX=YYY"` will be stored as a secret and passed as an environment value. This makes it useful for configuring Buildkite, passing in credentials, etc. Other relevant configuration values can be found in `helm/unity3d-buildkite/values.yaml` within this repository.


## Versions & Building

See the [Docker Hub page](https://hub.docker.com/r/inzania/unity3d-buildkite/tags) to determine which versions of Unity (and other tags) are currently available. If your version is not present, or to maximize security, you can build your own container.

Included in this repository is `build.py`. It has an interactive prompt to help build for new versions.
