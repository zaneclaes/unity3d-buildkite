#!/usr/bin/env python3.7
import os, sys, logging, argparse, subprocess, maker
from maker.maker import Maker

class Make():
    def __init__(self):
        try:                self.fp = os.readlink(__file__)
        except OSError:     self.fp = __file__
        self.bin = os.path.join(os.path.dirname(self.fp), '../')

        # Iterate module directory to load classes.
        self.makers = Maker(make = self)._load_subclasses()

        if len(sys.argv) < 2 or not sys.argv[1] in self.makers:
            print(f'Syntax: {self.fp} {list(self.makers)}')
            exit(1)
        self.maker_name = sys.argv[1]
        self.maker = self.makers[self.maker_name]
        if len(sys.argv) < 3 or not sys.argv[2] in self.maker.methods:
            print(f'Syntax: {self.fp} {self.maker_name} {list(self.maker.methods)}')
            exit(1)
        self.method_name = sys.argv[2]
        self.maker.method = self.maker.methods[self.method_name]
        args = sys.argv[3:]

        log_levels = ['CRITICAL', 'ERROR', 'WARNING', 'INFO', 'DEBUG']
        sha = self._git('rev-parse HEAD') # Git SHA will be the default commit
        tag = self._git('tag -l "v*" | tail -1') # vX.X.X tag will be used as default version
        vers = tag[1:] if len(tag) > 1 else '0.0.1' # Without a version tag, 0.0.1 is used

        parser = argparse.ArgumentParser(f'{self.fp} {self.maker_name} {self.method_name}')
        self.maker._parse_args(parser, self.method_name)
        parser.add_argument('--work', '-w', default=os.getcwd(), help='Work directory (where code lives)')
        parser.add_argument('--version', '-v', default=vers, help='SemVer version')
        parser.add_argument('--prerelease', '-p',
          default=os.getenv('BUILDKITE_BRANCH', ''), help='SemVer prerelease field')
        parser.add_argument('--build', '-b',
          default=os.getenv('BUILDKITE_BUILD_NUMBER', ''), help='SemVer build number')
        parser.add_argument('--commit', '-s',
          default=os.getenv('BUILDKITE_COMMIT', sha), help='SemVer SHA')
        parser.add_argument('--log-level', '-l', choices=log_levels, default='INFO', help='logging level')
        parser.add_argument('--log-format', '-f', default='[%(levelname)s] [%(name)s] %(message)s')
        self.opts = parser.parse_args(args)

        self.release = self.opts.version
        self.semver = self.opts.version
        if self.opts.prerelease and len(self.opts.prerelease) > 0:
            if self.opts.prerelease != 'master':
                self.release += '-' + self.opts.prerelease
            self.semver += '-' + self.opts.prerelease
        if self.opts.build and len(self.opts.build) > 0:
            self.semver += '+' + self.opts.build

        logging.basicConfig(format=self.opts.log_format, level=self.opts.log_level)
        self.log = logging.getLogger('make')
        self.maker.method()

    # Run a git command and return the output (or an empty string)
    def _git(self, cmd):
        res = subprocess.run(f'git {cmd}', shell=True, check=False, capture_output=True, text=True)
        return res.stdout.strip()

if __name__ == "__main__":
    cluster = Make()
