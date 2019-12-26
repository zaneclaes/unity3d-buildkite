#!/usr/bin/env python3
import subprocess
from .maker import Maker

class Docker(Maker):
    # container_dir = 'containers/'
    # containers = [f for f in listdir(container_dir) if isdir(join(container_dir, f))] if isdir(container_dir) else []
    # env_tags = {'dev': 'dev','house': 'test', 'van': 'test'}

    # Add arguments.
    def _parse_args(self, parser, method):
        if method == 'build':
            parser.add_argument('name', help='The name of the container to build.')
            parser.add_argument('platform', help='The Unity BuiltTarget.')
            parser.add_argument('registry', default='', help='The docker registry.')
            parser.add_argument('--tag', default='', help='The docker tag.')
            parser.add_argument('--tar', default='', help='The docker registry.')
            # parser.add_argument('scenes', help='Which scenes to build (comma-separated).')
            # parser.add_argument('--unity_func', default='DataSculptUnityEditor.CI.Build.Compile', help='The build function.')
            # parser.add_argument('--unity_exe', default=self._get_default_unity_ci_path(), help='The Unity executable.')
            # # parser.add_argument('--unity_log', default='/dev/stdout', help='Where Unity should log.')
            # parser.add_argument('--unity_bin', default=os.path.join(os.getcwd(), 'bin'), help='The root output folder for Unity.')
        return super()._parse_args(parser, method)

    # Remove all build files.
    def clean(self):
        self._clean_docker('network prune --force')
        self._clean_docker('system prune --force')
        self._clean_docker('rmi $(docker images --filter "dangling=true" -q --no-trunc)')
        self._clean_docker('rmi $(docker images | grep "none" | awk \'/ / { print $3 }\')')
        self._clean_docker('rm $(docker ps -qa --no-trunc --filter "status=exited")')

    def build(self):
        # opts = tools.add_env().add_push().add_tar().add_semver().add_sha().add_container().parse()
        t = self.make.opts.tag if len(self.make.opts.tag) > 0 else f'v{self.make.release}'
        tag = f'{self.make.opts.registry}/{self.make.opts.name}:{t}'
        src = f'bin/{self.make.opts.platform}'
        df = os.path.join(os.path.dirname(self.make.bin), 'ci/Dockerfile')
        args = f'--build-arg PROJECT_NAME={self.make.opts.name}'
        cmd = f'docker build {args} {src} -f {df} -t "{tag}"'
        self.log.info(f'builing {tag} from {src} using {df}')
        res = subprocess.run(cmd, shell=True, check=False, capture_output=True, text=True)
        if res.returncode != 0:
            self.log.error(res.stderr.strip())
            exit(1)
        self.log.info(f'pushing {tag}')
        if not self._exe(f'docker push {tag}'): exit(1)

    def _build_bazel(self):
        stamp = self.make.opts.tag
        container = self.make.opts.container
        self.log.info(f'build {container}:{stamp}')
        # Build & Tag
        if stamp == 'dev':
            # if opts.container in tools.unity.smith_targets: _prepare_unity(opts)
            _bazel_run(container)
            # Bazel's assumed repository+tag is not correct. Retag it as 'dev'
            _docker_retag(container, stamp, from_repo="%s/containers" % tools.ecr.repo)
        elif stamp == 'test':
            # upgrade 'dev' to 'test':
            _docker_retag(container, stamp, from_tag='dev')
        elif stamp == 'latest':
            # upgrade 'test' to 'latest'
            _docker_retag(container, stamp, from_tag='test')
        else:
            raise Exception("%s is not a known stamp" % stamp)
        # Export TAR
        if self.make.opts.tar: self._docker_save(container, stamp, self.make.opts.tar)
        # Push to repository
        if opts.push:
            tools.ecr._login(False)
            _docker_push(opts.container, stamp)

    def _clean_docker(self, cmd):
        subprocess.run(f'docker {cmd}', shell=True, check=False)

    # Build & then make sure the Unity target exists before continuing.
    def _prepare_unity(self, opts):
        tools.unity._compile(opts.container, opts.semver, opts.sha)
        fp = tools.unity._get_bin_path(opts.container)
        if not tools.os.path.isfile(fp):
            pwd = tools.shq('pwd').strip()
            print("The server binary was not at %s/%s" % (pwd, fp))
            exit(-1)

    # Save a container to a .tar file
    def _docker_save(self, container, tag, fn): # bin/{container}_{tag}.tar
        tools.sh(f"docker save {tools.ecr.repo}/{container}:{tag} -o {fn}")

    # Tag a bazel-built container with an appropriate tag.
    def _docker_retag(self, container, to_tag, to_repo="", from_repo="", from_tag = "latest"):
        if len(from_repo) <= 0: from_repo = tools.ecr.repo
        if len(to_repo) <= 0: to_repo = tools.ecr.repo
        tools.sh(f"docker tag {from_repo}/{container}:{from_tag} {to_repo}/{container}:{to_tag}")

    # Push the tagged image
    def _docker_push(self, container, tag):
        tools.sh(f"docker push '{tools.ecr.repo}/{container}:{tag}'")

    # bazel run == build a container
    def _bazel_run(self, container):
        #  --incompatible_remove_native_git_repository=false
        flags = "--symlink_prefix=/ --incompatible_disallow_data_transition=false" # --define tag=$tag"
        tools.sh(f"bazel run {flags} //containers/{container}:latest -- --norun")

