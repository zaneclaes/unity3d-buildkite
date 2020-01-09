#!/usr/bin/env python3
import os, json, platform, subprocess, yaml, shutil
from .maker import Maker

class Unity(Maker):
    # Add arguments.
    def _parse_args(self, parser, method):
        if method == 'build':
            parser.add_argument('name', help='The name of the project to build.')
            parser.add_argument('platform', help='The Unity BuildTarget.')
            parser.add_argument('scenes', help='Which scenes to build (comma-separated).')
            parser.add_argument('--unity_func', default='Editor.UnityCI.Build.Compile', help='The build function.')
            parser.add_argument('--unity_exe', default=self._get_default_unity_ci_path(), help='The Unity executable.')
            parser.add_argument('--unity_bin', default=os.path.join(os.getcwd(), 'bin'), help='The root output folder for Unity.')
        return super()._parse_args(parser, method)

    # Main build function.
    def build(self):
        name = self.make.opts.name
        self.log.info(f'Building {name} for {self.make.opts.platform}...')

        # Clean bin
        bin_dir = os.path.join(self.make.opts.unity_bin, self.make.opts.platform)
        report_fp = os.path.join(bin_dir, 'build.json')
        self.log.info(f'Building scenes {self.make.opts.scenes} to {bin_dir}')
        if not os.path.exists(bin_dir): os.makedirs(bin_dir)
        subprocess.run(f'rm -rf {bin_dir}/**', shell=True, check=False)
        output = os.path.join(bin_dir, name)

        # Copy the CI
        if self.make.opts.unity_func.startswith('Editor.UnityCI'):
            uci_dest = os.path.join(self.make.opts.work, 'Assets/Editor/UnityCI')
            uci_src = os.path.join(os.path.dirname(self.make.bin), 'UnityCI')
            self.log.info(f'Installing UnityCI to {uci_dest}...')
            os.makedirs(uci_dest, exist_ok=True)
            for fn in os.listdir(uci_src):
                ffn = os.path.join(uci_src, fn)
                if os.path.isfile(ffn):
                    shutil.copy(ffn, uci_dest)

        build_flags = {
            'Name': name,
            'BuildTarget': self.make.opts.platform,
            'OutputDir': output,
            'Scenes': self.make.opts.scenes.split(','),
            'Version': self.make.semver,
            'Commit': self.make.opts.commit,
            'ReportFile': report_fp
        }
        if self.make.opts.platform == 'Android':
            build_flags['AndroidSdkRoot'] = '/opt/android-sdk-linux'
            build_flags['JdkPath'] = '/usr/lib/jvm/java-8-openjdk-amd64'

        # Build Unity game.
        self._unity_exec(self.make.opts.work, bin_dir, build_flags)

        success = False
        if os.path.isfile(report_fp):
            with open(report_fp) as file: report = json.load(file)
            size = report['totalSize']
            time = report['totalTime']
            self.log.info(f'built {size}b in {time}')
            if report["errors"]:
                for err in report["errors"].split('\n'):
                    if len(err) > 0:
                        self.log.error(err)
            if report["result"] == "Succeeded":
                success = True
        if not success: exit(1)
        if not self._exe(f'cd {bin_dir} && zip -rq {name}.zip {name}'): exit(1)
        self.log.info(f'Buld completed: {output}.zip')

    # Remove all build files.
    def clean(self):
        self._clean_unity('Library')
        self._clean_unity('Temp')
        self._clean_unity('bin/**')

    # Remove a directory within the Unity folder.
    def _clean_unity(self, directory):
        directory = f'{self.make.opts.work}/{directory}'
        self.log.info(f'cleaning unity directory at \'{directory}\'...')
        subprocess.run(f'rm -rf {directory}', shell=True, check=False)

    # Run a Unity command in CI mode.
    def _unity_exec(self, project_path, log_dir, flags = {}):
        log_file = os.path.join(log_dir, 'unity.log')
        out_file = os.path.join(log_dir, 'unity.out.log')
        err_file = os.path.join(log_dir, 'unity.err.log')
        args = {
            'nographics': '',
            'batchmode': '',
            'quit': '',
            'projectPath': project_path,
            'executeMethod': self.make.opts.unity_func,
            'logFile': log_file
        }
        args.update(flags)
        cmd = [self.make.opts.unity_exe]
        for (key, value) in args.items():
            if type(value) is list:
                for v in value:
                    cmd += [f'"-{key}[]"', v]
            else:
                cmd += [f'-{key}', value]
        self.log.info(f'Running unity command: \n{" ".join(cmd)}')
        res = subprocess.run(' '.join(cmd), shell=True, check=False, capture_output=True, text=True)
        with open(out_file, 'w+') as fp: fp.write(res.stdout.strip())
        with open(err_file, 'w+') as fp: fp.write(res.stderr.strip())
        if os.path.isfile(log_file):
            with open(log_file, 'r') as stream: logs = stream.read().split('\n')
            for line in logs:
                if line.startswith('[Build]'):
                    self.log.info(line)
        if res.returncode != 0:
            self.log.error(self._get_unity_exception(log_file, err_file, out_file))
            return False
        return True

    # Look at a Unity output file and throw any exception found therein.
    def _get_unity_exception(self, fp, fp_err, fp_out):
        if not os.path.isfile(fp):
            with open(fp_err) as file: ret = file.read()
            if ret and len(ret) > 0: return ret
            with open(fp_out) as file: return file.read()
        with open(fp) as file: contents = file.read()
        lines = contents.split('\n')
        while len(lines) > 0 and not 'Exception:' in lines[0]: del(lines[0])
        if len(lines) <= 0: return contents
        i = 0
        while i < len(lines) and len(lines[i].strip()) > 0: i += 1
        if i < len(lines): lines = lines[0:i]
        return '\n'.join(lines)


    # Use the OS to determine where Unity should be located.
    def _get_default_unity_ci_path(self):
      sys = platform.system()
      path = 'xvfb-run --auto-servernum --server-args=\'-screen 0 640x480x24\' /opt/Unity/Editor/Unity'
      if sys == 'Darwin':
        path = '/Applications/Unity/Unity.app/Contents/MacOS/Unity'
      return os.getenv('UNITY_CI', path)