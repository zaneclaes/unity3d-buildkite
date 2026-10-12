#!/usr/bin/env node
const fs = require('fs');
const utils = require('./utils');
const path = require('path');

const Mak = require('./maker');
const maker = new Mak.Maker();

// Helper for what goes into the channel / artifact for auto-updates
// https://gist.github.com/iffy/0ff845e8e3f59dbe7eaf2bf24443f104
function isReleaseFile(fn) {
  const releaseFileExtensions = ['json', 'yml', 'zip', 'dmg', 'AppImage', 'exe'];
  return releaseFileExtensions.findIndex(e => fn.endsWith(`.${e}`)) >= 0;
}


function getDeploymentBuildPaths(type, rootDir, pkgName, bin, fn) {
  const parts = [pkgName];
  const buildId = utils.getBuildId();
  if (buildId.length > 0 && buildId !== '0') parts.push(buildId);
  const binDir = path.isAbsolute(bin) ? bin : path.join(rootDir, bin);
  const fileName = parts.join('.');
  const tarFn = `${fileName}.tar.gz`;
  const artifactDir = path.join(binDir, type, fn);
  utils.mkdir(artifactDir);
  const tarFp = path.join(artifactDir, tarFn);
  return { pkgName, binDir, fileName, tarFn, artifactDir, tarFp, buildId };
}

async function inferBuildArgs(args) {
  const semver = Mak.parseSemver(args.newVersion);

  const spaPath = path.join(maker.opts.rootDir, args.spa);
  const serverPath = path.join(maker.opts.rootDir, args.server);

  const pkgRelPath = path.join(args.spa, 'package.json');
  const pkgPath = path.join(maker.opts.rootDir, pkgRelPath);
  const [pkg] = utils.readJsonFile(pkgPath);
  const productName = pkg.productName;
  if (!productName) throw new Error(`Failed to read productName from ${pkgPath}`);
  const productGroup = args.os;

  const build = getDeploymentBuildPaths(
    'electron', maker.opts.rootDir, `${productName}-${semver.pub}`, args.bin, productGroup);
  const rid = inferRid(args);
  const localBin = path.join('bin', args.config);
  // const releasePath = path.join(maker.opts.rootDir, localBin);
  const desktopRelPath = path.join('bin', 'Desktop');
  const desktopPath = path.join(maker.opts.rootDir, desktopRelPath);
  const distPath = path.join(maker.opts.rootDir, 'bin', 'Dist');

  // const fullArch = utils.commonArchStringFromYargs(args);
  const artifactChannelDir = path.join(build.artifactDir, semver.channel);
  utils.mkdir(artifactChannelDir);
  const artifactVersionDir = path.join(build.artifactDir, semver.medium);
  const artifactOsDir = path.join(artifactVersionDir, args.os ?? 'linux');

  return {
    ...build, rid, localBin, desktopPath, desktopRelPath, distPath,
    productName, productGroup, spaPath, serverPath,
    semver, artifactChannelDir, artifactVersionDir, artifactOsDir
  };
}

async function rebuild(args) {
  const dep = await inferBuildArgs(args);
  utils.rmdir(dep.distPath);
  process.chdir(dep.serverPath);

  console.log('[REBUILD]', dep.rid, args.config);
  const flags = [
    `-r ${dep.rid}`,
    `-c ${args.config}`,
    // '-p:PublishReadyToRun=true', -- AOT; emits warnings...
    // '-p:PublishSingleFile=true',
    // '-p:PublishTrimmed=true',
    `--output ${dep.distPath}`,
    '--self-contained',
  ];
  if (!args.restore) flags.push('--no-restore');
  await utils.execute('dotnet nuget locals http-cache --clear');
  await utils.execute(`dotnet publish ${flags.join(' ')}`);

  if (args.os !== 'win') {
    const zipFp = path.join(dep.artifactOsDir, `dist-${dep.rid}.tar.gz`);
    console.log('[ZIP]', zipFp, 'from dist in', dep.distPath);
    await utils.execute(`tar -czf "${zipFp}" "${dep.distPath}"`);
  }
}

async function build(args) {
  // Dotnet publish is actually the core build...
  const dep = await inferBuildArgs(args);
  utils.rmdir(dep.artifactOsDir);
  utils.mkdir(dep.artifactOsDir);

  // Rebuilding the underlying app...
  if (args.rebuild) {
    // await utils.execute('yarn run build'); // done by csproj
    await rebuild(args);
  }
  process.chdir(dep.spaPath);

  // Configure package.json, copied from main app
  utils.updateJsonFile('package.json', (pkg) => {
    pkg.version = dep.semver.medium;
    pkg.dependencies['@openworkshop/maker-builder'] = maker.package.dependencies['@openworkshop/maker-builder'];
  });

  const deploymentJson = fs.readFileSync(path.join( maker.opts.frontendDir, 'src', 'deployment.json'), 'utf-8');
  console.log('[DEPLOYMENT]', deploymentJson);

  // Update packages for the desktop app...
  if (args.install) {
    await utils.execute(`yarn install --network-timeout ${args.timeout}`);
  }

  // Prepare build directory
  console.log('[BUILD]', dep.fileName);
  utils.rmdir(dep.desktopPath);
  utils.mkdir(dep.desktopPath);

  const publish = maker.opts.isCi ? 'always' : 'always';

  // Electron build
  // https://www.electron.build/cli
  const electronFlags = [
    `--${args.os}`,
    `--publish=${publish}`,
    `-c.directories.output=${dep.desktopPath}`,
    `-c.publish.channel=${dep.semver.channel}`
  ];
  // if (!maker.opts.isCi && args.os === 'mac') electronFlags.push('-c.mac.identity=null'); // do not codesign mac osx dev
  if (args.os === 'win') electronFlags.push('-c.nsis.unicode=false');

  // if (args.arch === 'arm') electronFlags.push(args.cpu.toString() === '64' ? '--arm64' : '--armv7l');
  // else if (!args.arch || args.arch_variant === 'x64') electronFlags.push('--x64');
  // console.log('[ELECTRON]', electronFlags);
  await utils.execute(`yarn run electron-builder ${electronFlags.join(' ')}`);
  // --{platformInfo.ElectronPackerPlatform} --{electronArch} {electronParams}",

  const results = fs.readdirSync(dep.desktopPath, { withFileTypes: true });
  if (results.length < 2) throw new Error(`Missing build results: ${results} in ${dep.desktopPath}`);
  console.log('[RESULTS]', results);

  // Enumerate the Electron output path for files
  const excludedExtensions = ['.DS_Store', '@eaDir', '.Icon?'];
  const files = results.filter(ent => ent.isFile() && excludedExtensions.findIndex(e => ent.name.endsWith(e)) < 0);
  // console.log('[FILES]', files);

  // Copy files to artifact directory
  // https://gist.github.com/iffy/0ff845e8e3f59dbe7eaf2bf24443f104
  process.chdir(dep.desktopPath);
  files.forEach(ent => {
    const fp = path.join(dep.artifactOsDir, ent.name);
    console.log('[FILE]', fp);
    fs.copyFileSync(ent.name, fp);
  });
}
//
// async function s3obj(bucket, key) {
//   const obj = await utils.execute(`aws s3api head-object --bucket ${bucket} --key ${key}`, true);
//   console.log('s3', obj);
//   if (!obj || !obj.startsWith('{')) return {};
//   try {
//     return JSON.parse(obj);
//   } catch (e) {
//     console.log('[S3]', bucket, key, e);
//     return {};
//   }
// }

async function deploy(args) {
  const dep = await inferBuildArgs(args);

  console.log('[COPY]', 'scanning', dep.artifactVersionDir);
  const osDirs = fs.readdirSync(dep.artifactVersionDir, { withFileTypes: true });
  const files = [];
  utils.rmdir(dep.artifactChannelDir);
  utils.mkdir(dep.artifactChannelDir);
  osDirs.forEach(ent => {
    const os = ent.name;
    if (!ent.isDirectory || !utils.operatingSystems.includes(os)) {
      if (ent.isDirectory) console.log('[COPY]', 'not an os', os);
      return;
    }
    const osDir = path.join(dep.artifactVersionDir, os);
    fs.readdirSync(osDir).forEach(fn => {
      const fp = path.join(osDir, fn);
      if (!isReleaseFile(fp)) return;
      files.push(fn);
      const fd = path.join(dep.artifactChannelDir, fn);
      console.log('[COPY]', os, '=>', fd);
      fs.copyFileSync(fp, fd);
    });
  });

  const downloads = files.filter(f => !f.endsWith('.yml') && !f.endsWith('.json'));
  const links = downloads.map(f => `<a href="${f}">${f}</a>`);
  const html = '<html>' + links.join('<br>') + '</html>';
  fs.writeFileSync(path.join(dep.artifactChannelDir, 'index.html'), html);
  
  const s3p = `${args.bucket}/${dep.productName}`;

  const sv = Mak.parseSemver(args.newVersion);
  console.log(sv);
  const build = sv.build ?? 0;
  const md = `build=${build}`;
  console.log('[DEPLOY]', 'bucket', args.bucket);

  const flags = `--metadata ${md} --acl public-read`;
  await utils.execute(`aws s3 sync ${dep.artifactChannelDir} s3://${s3p} ${flags}`);

  // for (let i=0; i < files.length; i++) {
  //   const fn = files[i];
  //   const fp = path.join(dep.artifactChannelDir, fn);
  //   const s3key = path.join(dep.productName, dep.semver.channel, fn);
  //   const fd = path.join(args.bucket, s3key);
  //
  //   // const objData = await s3obj(args.bucket, s3key);
  //   console.log('[DEPLOY]', fd, fp);
  //
  //   await utils.execute(`aws s3 cp ${fp} s3://${fd}`);
  // }
}

// https://docs.microsoft.com/en-us/dotnet/core/rid-catalog
function inferRid(args) {
  let os = args.os;
  if (os === 'mac') os = 'osx';
  let variant = args.arch_variant;
  if (args.arch === 'arm') variant = args.cpu.toString() === '32' ? 'arm' : `arm${args.cpu}`;
  return `${os}-${variant}`;
}

function yargsDir(yargs) {
  yargs.positional('server', {
    type: 'string',
    default: 'Server',
    describe: 'Where the .csproj resides'
  });
  yargs.positional('spa', {
    type: 'string',
    default: 'DesktopApp',
    describe: 'Where the package.json resides'
  });
  return yargs;
}

async function entrypoint() {
  await maker.startup();
  await utils.yargEntrypoint(maker, utils.metadataYargs(require('yargs'))
    .option('c', {
      alias: 'config',
      default: 'Release',
      describe: 'Which configuration',
      choices: ['Debug', 'Release'],
    })
    .option('nv', {
      alias: 'new-version',
      default: maker.opts.semver.pub,
    })
    .option('rebuild', {
      default: true,
      type: 'boolean',
    })
    .option('restore', {
      default: true,
      type: 'boolean',
    })
    .option('install', {
      default: true,
      type: 'boolean',
    })
    .option('publish', {
      default: false,
      type: 'boolean',
    })
    .option('timeout', {
      default: 1000000000,
    })
    .command('build [server] [spa]', 'Build the electron project', yargsDir, build)
    .command('deploy [server] [spa]', 'Build the electron project', (y) => {
      yargsDir(y);
      y.option('bucket', {
        default: 'openworkshop-downloads',
      });
    }, deploy)
  );
}

void entrypoint();
