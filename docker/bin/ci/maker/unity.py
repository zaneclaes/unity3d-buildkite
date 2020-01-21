#!/usr/bin/env python3
import os, json, platform, subprocess, yaml, shutil
from .maker import Maker

class Unity(Maker):
    # Add arguments.
    def _parse_args(self, parser, method):
        if method == 'build' or method == 'activate':
            parser.add_argument('--unity_exe',
                default=self._get_default_unity_ci_path(), help='The Unity executable.')
        if method == 'build':
            parser.add_argument('name', help='The name of the project to build.')
            parser.add_argument('platform', help='The Unity BuildTarget.')
            parser.add_argument('scenes', help='Which scenes to build (comma-separated).')
            parser.add_argument('--unity_func',
                default='Editor.UnityCI.Build.Compile', help='The build function.')
            parser.add_argument('--unity_bin',
                default=os.path.join(os.getcwd(), 'bin'), help='The root output folder for Unity.')
        if method == 'activate':
            parser.add_argument('--unity_username',
                default=os.getenv('UNITY_USERNAME', ''), help='The Unity account username.')
            parser.add_argument('--unity_password',
                default=os.getenv('UNITY_PASSWORD', ''), help='The Unity account password.')
        return super()._parse_args(parser, method)

    # Activate a Unity license.
    def activate(self):
        un = self.make.opts.unity_username
        pw = self.make.opts.unity_password
        if len(un) <= 0:
            self.log.error(f'No unity_username provided as env. variable or argument.')
            exit(1)
        if len(pw) <= 0:
            self.log.error(f'No unity_password provided as env. variable or argument.')
            exit(1)

        lf = os.path.join(self.make.opts.work, 'unity-activation.log')
        if os.path.isfile(lf): os.remove(lf)

        self.log.info(f'Activating Unity (log file: {lf})...')
        flags = '-nographics -batchmode -quit'
        cmd = f'{self.make.opts.unity_exe} {flags} -logFile {lf} -username "{un}" -password "{pw}"'
        res = subprocess.run(cmd, shell=True, check=False, capture_output=True, text=True)

        # Get the activation key
        with open(lf) as f: txt = f.read()
        pk = '] Posting '
        if not pk in txt:
            self.log.info(res.stdout.strip())
            self.log.error(res.stderr.strip())
            exit(1)

        act = txt[txt.index(pk)+len(pk):]
        act = act[:act.index('\n')]

        self.log.warning(f'Your activation key is:\n-----\n{act}\n-----')
        self.log.info('Save the above XML as Unity.ilf and upload to https://license.unity3d.com/manual')
        self.log.info('Set the results to the environment variable $UNITY_LICENSE')
        # af = os.path.join(self.make.opts.work, 'unity-activation.alf')
        # with open(af, 'w+') as fp: fp.write(act)
        # self.log.info(f'Activating Unity with license...')
        # sess = requests.session()

        # headers = {
        #     'Accept': 'application/json, text/plain, */*',
        #     'Accept-Encoding': 'gzip, deflate, br',
        #     'Content-Type': 'text/xml',
        #     'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_2)'
        # }
        # url = 'https://license.unity3d.com/genesis/activation/create-transaction'
        # res = sess.post(url, data=act, headers=headers)

        # Look for '] Posting <?xml' in lf

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
            'Scenes': self.make.opts.scenes,
            'Version': self.make.semver,
            'Commit': self.make.opts.commit,
            'ReportFile': report_fp
        }
        if self.make.opts.platform == 'Android':
            build_flags['AndroidSdkRoot'] = '/opt/android-sdk-linux'
            build_flags['JdkPath'] = '/usr/lib/jvm/java-8-openjdk-amd64'
            if not build_flags['Name'].endswith('.apk'):
                build_flags['Name'] += '.apk'

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

        if self.make.opts.platform == 'iOS':
            ios_dir = os.path.join(output, name)
            podfile = os.path.join(ios_dir, 'Podfile')
            if os.path.isfile(podfile):
                self.log.info(f'Installing cocoapods...')
                podlog = os.path.join(bin_dir, 'pod.log')
                cmd = f'pod install --project-directory={ios_dir} > {podlog}'
                if not self._exe(cmd):
                    self.log.error(f'Failed to install {podfile}')
                    exit(1)
            else:
                self.log.info(f'No cocoapod installation required at {podfile}')

        zf = f'{name}-{self.make.opts.platform}-{self.make.semver}.zip'
        if not self._exe(f'cd {bin_dir} && zip -rq {zf} {name}'): exit(1)
        self.log.info(f'Buld completed: {zf}')

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
            if type(value) is list: value = ','.join(value)
            cmd += [f'-{key}', value]
        cmd = ' '.join(cmd)
        self.log.info(f'Running unity command: \n{cmd}')
        res = subprocess.run(cmd, shell=True, check=False, capture_output=True, text=True)
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