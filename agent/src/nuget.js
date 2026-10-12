#!/usr/bin/env node
const fs = require('fs');
const utils = require('./utils');
const path = require('path');

const maker = new (require('./maker')).Maker();

async function clean(args) {
  console.log('[CLEAN]');
  process.chdir(path.join(maker.opts.rootDir, args.pkg));
  await utils.execute('dotnet clean');
}

async function build(args) {
  if (args.clean) await clean(args);
  const dep = getDeployment(args);
  process.chdir(path.join(maker.opts.rootDir, args.pkg));

  if (args.restore) {
    console.log('[RESTORE]');
    await utils.execute('dotnet restore');
  }

  const pubVer = maker.opts.semver.pub;
  console.log('[BUILD]', args.pkg, 'version', pubVer, 'deployment', args.config);
  await utils.rimraf(dep.releasePath);

  const envFlags = [`MAKER_HUB_SEMVER_PUB=${pubVer}`];
  const buildFlags = [];
  buildFlags.push(`--configuration ${args.config}`);
  // buildFlags.push(`/p:Version=${maker.opts.semver.pub}`);
  await utils.execute(`${envFlags.join(' ')} dotnet build ${buildFlags.join(' ')}`);

  console.log('[CHECK]', dep.nugetFp);
  if (!fs.existsSync(dep.nugetFp)) {
    console.log('expected', dep.nugetFp, 'to be built but got:');
    await utils.execute(`ls -la ${dep.releasePath}`);
    process.exit(1);
  }

  console.log('[ZIP]', dep.tarFn);
  await utils.execute(`tar -czf "${dep.tarFp}" ${dep.localBin}`);
}

function getDeployment(args) {
  const bundleParts = [args.org, args.pkg].filter(s => !!s);
  const fn = args.productName ?? bundleParts.join('.');
  const nugetFn = `${fn}.${maker.opts.semver.pub}.nupkg`;
  const localBin = path.join('bin', args.config);
  const releasePath = path.join(maker.opts.rootDir, args.pkg, localBin);
  const nugetFp = path.join(releasePath, nugetFn);
  const artifactDir = maker.prepareArtifactDir(args.bin, 'nuget', maker.opts.semver.pub);
  const tarFp = path.join(artifactDir, `${fn}.tar`);
  return { nugetFn, localBin, releasePath, nugetFp, artifactDir, tarFp };
}

async function deploy(args) {
  const dep = getDeployment(args);
  process.chdir(path.join(maker.opts.rootDir, args.pkg));

  await utils.execute(`tar -xf "${dep.tarFp}"`);
  process.chdir(dep.releasePath);

  const flags = ['-s https://api.nuget.org/v3/index.json'];
  const key = process.env['NUGET_API_KEY'];
  if (key) flags.push(`-k ${key}`);

  console.log('[DEPLOY]', dep.nugetFn);
  await utils.execute(`dotnet nuget push "${dep.nugetFn}" ${flags.join(' ')}`);
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
    .option('clean', {
      default: true,
      type: 'boolean',
    })
    .option('restore', {
      default: true,
      type: 'boolean',
    })
    .option('org', {
      default: 'OpenWorkShop',
    })
    .command('build', 'Build the NPM package', () => {}, build)
    .command('deploy', 'Deploy the NPM package', () => {}, deploy)
    .positional('pkg', {
      default: 'MakerHub',
      describe: 'The NPM package root within ./src/'
    })
  );
}

void entrypoint();
