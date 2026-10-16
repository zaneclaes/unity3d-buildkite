#!/usr/bin/env node
const utils = require('./utils');
const path = require('path');

const maker = new (require('./maker')).Maker();

async function clean(args) {
  const dep = getDeployment(args);

  console.log('[CLEAN]', dep.pkgRoot);
  await utils.rimraf(path.join(dep.pkgRoot, 'node_modules'));

  return dep.pkgRoot;
}

async function build(args) {
  const dep = getDeployment(args);

  if (args.clean) {
    await clean(args);
  }

  await utils.execute('npm install -g eslint rollup typescript');

  console.log('[INSTALL]', 'dependencies for', args.pkg, 'version', args.newVersion);
  process.chdir(maker.opts.rootDir);
  // await utils.execute(`yarn install --network-timeout ${args.timeout}`);
  process.chdir(dep.pkgRoot);

  await utils.rimraf(dep.pkgBuild);

  if (args.rollup) {
    console.log('[ROLLUP]', args.pkg);
    await utils.rimraf(dep.pkgDist);
    await utils.execute(`yarn install --network-timeout ${args.timeout}`);

    await utils.mkdir(dep.pkgBuild);
    console.log('[BUILD]', args.pkg, 'version', args.newVersion);
    await utils.execute('yarn run build');

    await utils.execute(`rollup -c > ${dep.pkgBuild}/rollup.log`);
  }

  console.log('[ZIP]', 'from dist in', process.cwd());
  await utils.execute(`tar -czf "${dep.tarFp}" dist`);
}

async function deploy(args) {
  const dep = getDeployment(args);
  process.chdir(dep.pkgRoot);

  await utils.execute(`tar -xf "${dep.tarFp}"`);
  process.chdir(dep.pkgDist); // was extracted in last line.
  const flags = [
    '-f',
    '--access public',
    `--new-version ${args.newVersion}`,
    '--no-git-tag-version',
    '--verbose',
  ];

  console.log('[DEPLOY] from', dep.pkgDist);
  await utils.execute(`yarn publish ${flags.join(' ')}`);
}

function getDeployment(args) {
  const artifactDir = maker.prepareArtifactDir(args.bin, 'npm', maker.opts.semver.pub);
  const tarFp = path.join(artifactDir, `${args.pkg}-${maker.opts.semver.pub}.tar.gz`);
  const pkgRoot = path.join(maker.opts.srcDir, args.pkg);
  const pkgBuild = path.join(pkgRoot, 'build');
  const pkgRollup = path.join(pkgRoot, 'rollup');
  const pkgDist = path.join(pkgRoot, 'dist');
  return { artifactDir, tarFp, pkgRoot, pkgBuild, pkgRollup, pkgDist };
}

async function entrypoint() {
  await maker.startup();
  await utils.yargEntrypoint(maker, utils.metadataYargs(require('yargs'))
    .option('clean', {
      default: true,
      type: 'boolean',
    })
    .option('compile', {
      default: true,
      type: 'boolean',
    })
    .option('rollup', {
      default: true,
      type: 'boolean',
    })
    .option('nv', {
      alias: 'new-version',
      default: maker.opts.semver.pub,
    })
    .option('timeout', {
      default: 1000000000,
    })
    .command('build [pkg]', 'Build the NPM package', (yargs) => {
      yargs.positional('pkg', {
        default: 'maker-hub',
        describe: 'The NPM package root',
        choices: maker.opts.packages,
      });
    }, build)
    .command('deploy [pkg]', 'Deploy the NPM package', (yargs) => {
      yargs.positional('pkg', {
        default: 'maker-hub',
        describe: 'The NPM package root',
        choices: maker.opts.packages,
      });
    }, deploy)
  );
}

void entrypoint();
