const fs = require('fs');
const yaml = require('js-yaml');

const childProcess = require('child_process');
const os = require('os');
const rr = require('rimraf');
const commandExistsSync = require('command-exists').sync;

async function rimraf(dir) {
  return new Promise(resolve => rr(dir, resolve));
}

function readJsonFile(fileName) {
  if (!fs.existsSync(fileName)) throw new Error(`Missing JSON file: ${fileName} in ${process.cwd()}`);
  const data = fs.readFileSync(fileName, 'utf8');
  const obj = (data.length) ? JSON.parse(data): undefined;
  if (!obj) throw new Error(`Failed to parse ${fileName}`);
  return [obj, data];
}

function readYamlFile(fileName) {
  if (!fs.existsSync(fileName)) throw new Error(`Missing YAML file: ${fileName} in ${process.cwd()}`);
  const data = fs.readFileSync(fileName, 'utf8');
  const obj = yaml.load(data);
  if (!obj) throw new Error(`Failed to parse ${fileName}`);
  return [obj, data];
}

function fileReplace(fileName, search, replace) {
  if (!fs.existsSync(fileName)) throw new Error(`Missing file: ${fileName} in ${process.cwd()}`);
  const data = fs.readFileSync(fileName, 'utf8');
  const rep = data.replaceAll(search, replace);
  if (data === rep) return false;
  console.log('[WRITE]', fileName);
  fs.writeFileSync(fileName, rep);
  return true;
}

function updateJsonFile(fileName, updater) {
  const [obj, data] = readJsonFile(fileName);

  updater(obj);
  const json = JSON.stringify(obj, null, '  ');
  if (json === data) return [false, obj, data];

  fs.writeFileSync(fileName, JSON.stringify(obj, null, '  '));
  console.log('[WRITE]', fileName);
  return [true, obj, data];
}

function saveDotEnv(fp, keyMap) {
  const existing = fs.existsSync(fp) ? fs.readFileSync(fp) : '';
  if (existing.length === 0) {
    console.log('[CI] building the .env from scratch');
  }

  const keys = Object.keys(keyMap); //.sort();
  const lines = keys.map(k => `${k}="${keyMap[k]}"`);
  const str = lines.join('\n');
  if (existing === str) return false;

  console.log('[ENV]', fp, '\n', str);
  fs.writeFileSync(fp, str);
  return true;
}

function setTsConfigPathAlias(fileName, pathAlias, path) {
  const alias = `${pathAlias}/*`;
  return updateJsonFile(fileName, (json) => {
    if (path) {
      json.compilerOptions.paths[alias] = [`${path}/*`];
    } else {
      delete json.compilerOptions.paths[alias];
    }
  });
}

async function execute(command, suppressErrors) {
  console.log('[EXE]', command);
  return new Promise(function(resolve, reject) {
    try {
      const cp = childProcess.exec(command, function (error, standardOutput) {
        if (error) {
          if (!suppressErrors) {
            console.log('[ERR]', error);
            reject(error);
            return;
          }
          // console.log('[FYI]', error.name, error.message.trim());
        }
        resolve(standardOutput);
      });
      cp.stdout.pipe(process.stdout);
      cp.stderr.pipe(process.stderr);
    } catch (e) {
      console.log('[EX]', e);
      if (!suppressErrors) {
        reject(e.toString());
      } else {
        resolve(undefined);
      }
    }
  });
}

function ciEnvVar(name, def) {
  // From the agent metadata
  const bk = process.env[`BUILDKITE_AGENT_META_DATA_${name}`];
  if (bk) return bk;
  // From the docker container
  return process.env[`BUILDER_${name}`] ?? def;
}

function getCommand(opts) {
  const tried = [];
  while (opts.length > 0) {
    const cmd = opts.shift();
    if (commandExistsSync(cmd)) {
      return cmd;
    }
    tried.push(cmd);
  }
  return tried[0];
  // throw new Error(`No compatible command found; searched for: ${tried}`);
}

const archRe = /^((?<os>[a-zA-Z]+)-)?(?<arch>[a-zA-Z]+)(?<cpu>\d+)(?<arch_variant>[\w\d]+)?$/;

function parseArch(arch) {
  const m = archRe.exec(arch);
  if (!m) throw new Error(`Invalid arch: ${arch}`);
  return m;
}

// convert metadataYargs to a full arch as commonly used (amd64, arm32v7, arm64v8, etc.)
function commonArchStringFromYargs(args) {
  if (args.arch === 'amd') return `${args.arch}${args.cpu}`;
  return `${args.arch}${args.cpu}${args.arch_variant}`;
}

function getBuildId() {
  return process.env['BUILDKITE_BUILD_NUMBER'] ?? '0';
}

function rmdir(dirName) {
  if (!fs.existsSync(dirName)) return;
  console.log('[DIR]', 'removing', dirName, '...');
  fs.rmSync(dirName, { recursive: true });
}

function mkdir(dirName) {
  if (fs.existsSync(dirName)) return;
  console.log('[DIR]', 'creating', dirName, '...');
  fs.mkdirSync(dirName, { recursive: true });
}

const operatingSystems = ['linux', 'mac', 'win'];

function metadataYargs(yargs) {
  const osType = os.type();
  let osDefault = 'linux';
  if (osType === 'Darwin') osDefault = 'mac';
  if (osType.startsWith('Win')) osDefault = 'win';
  return yargs
    .option('bin', {
      default: process.env['BUILD_ARTIFACTS_PATH'] ?? 'bin',
    })
    .option('os', {
      default: ciEnvVar('OS', osDefault),
      choices: operatingSystems,
      describe: 'Operating system',
    })
    .option('arch', {
      default: ciEnvVar('ARCH', 'amd'),
      choices: ['amd', 'arm'],
      describe: 'CPU architecture',
    })
    .option('cpu', {
      default: ciEnvVar('CPU', '64'),
      choices: ['32', '64'],
      describe: 'CPU bytes',
      type: 'string',
    })
    .option('arch_variant', {
      default: ciEnvVar('ARCH_VARIANT', 'x64'),
      choices: ['x64', 'v7', 'v8'],
      describe: 'CPU architecture variant',
    });
}

async function yargEntrypoint(maker, yargParser) {
  process.on('beforeExit', (code) => {
    console.log('[MB]', 'beforeExit', code);
  });
  process.on('exit', (code) => {
    const res = code === 0 ? '[SUCCESS]' : '[ERROR]';
    console.log('[MB]', 'exit', code, res);
  });
  return yargParser.help().parse();
  // process.exit(0);
}

module.exports = {
  yargEntrypoint, readJsonFile, updateJsonFile, rimraf, execute, saveDotEnv, fileReplace,
  ciEnvVar, getCommand, getBuildId, metadataYargs, parseArch, rmdir, mkdir, readYamlFile,
  setTsConfigPathAlias, commonArchStringFromYargs, operatingSystems,
};
