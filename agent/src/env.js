#!/usr/bin/env node
const fs = require('fs');
const utils = require('./utils');
const path = require('path');
const { Maker, channels } = require('./maker');
const maker = new Maker();

async function generateEnv(semverStr, backend = undefined) {
  let aspEnv;
  // If no semver was provided in the CLI, it is generated.
  const sv = semverStr ? await maker.getSemver(semverStr) : await maker.generateSemver();
  const channel = sv.channel ?? maker.opts.defaultChannel;

  const productionChannels = [undefined, '', 'master', channels.latest];
  const betaChannels = [channels.beta];

  if (backend) {
    aspEnv = backend;
  } else if (productionChannels.includes(channel)) {
    aspEnv = 'Production';
  } else if (betaChannels.includes(channel)) {
    aspEnv = 'Staging';
  } else {
    // CI cannot build development
    aspEnv = maker.opts.isCi ? 'Staging' : 'Development';
  }

  console.log('-------------------------------');
  console.log('[GENERATE]', aspEnv, 'from channel', channel);
  console.log('-------------------------------');

  return await setVersion(sv, aspEnv);
}

async function setVersion(semver, aspEnvOverride = undefined) {
  const sv = typeof semver === 'string' ? (await maker.getSemver(semver)) : semver;
  // falls back on env. var or package.json from root
  console.log('-------------------------------');
  console.log(maker.package.productName ?? maker.package.name);
  console.log('-------------------------------');
  console.log('[VERSION]', sv.long);
  console.log('-------------------------------');
  const env = await maker.saveEnv(aspEnvOverride, sv);
  return [sv, env];
}

async function generate(args) {
  return await generateEnv(args.semver, args.backend);
}

async function setPackageVersion(semverStr = null) {
  semverStr = semverStr ?? maker.package.version;
  console.log('[VERSION]', 'set to', semverStr, 'in', maker.opts.packages);
  if (!semverStr) {
    process.exit(1);
  }
  utils.updateJsonFile(maker.opts.pkgFp, (pkg) => {
    pkg.version = semverStr;
  });
  maker.opts.packages.forEach((pkgName) => {
    const appPkgFn = path.join(maker.opts.srcDir, pkgName, 'package.json');
    utils.updateJsonFile(appPkgFn, (pkg) => {
      pkg.version = semverStr;
    });
  });

  let [sv, env] = await generateEnv(semverStr);

  if (maker.opts.deployments.length === 0) return;
  const version = sv.branch === 'dev' ? sv.short : sv.medium;
  console.log('[DEP]', 'applying v', version, 'to deployments...');
  maker.opts.deployments.forEach((deployment) => {
    // undefined: Version of the @openworkshop packages are not bumped in the deployment until sync().
    updateDeploymentPackage(maker.deployments[deployment].opts.pkgFp, undefined);
  });

  console.log('[DEP] done');

  return [sv, env];
}

async function bumpVersion(args) {
  let sv = await maker.getSemver(args.semver);
  let maj = parseInt(sv.major);
  let min = parseInt(sv.minor);
  let pat = parseInt(sv.patch);
  if (!args.semver && !args.lock) {
    // If not explicitly provided, do an auto bump
    console.log('[BUMP]', 'from', maj, min, pat);
    pat = pat+1;
  }

  const parts = [`${maj}.${min}.${pat}`];
  if (sv.suffix) parts.push(sv.suffix);
  return await setPackageVersion(parts.join('-'));
}

// When updating deployments (sub-projects), the MakerHub (./package.json) is may have newer version numbers.
function updateDeploymentPackage(pkgFp, version) {
  console.log('[DEP]', 'scan', pkgFp);
  utils.updateJsonFile(pkgFp, (deploymentPackageJson) => {
    const deps = { ...maker.package.dependencies }; //, ...maker.package.resolutions
    if (deploymentPackageJson.dependencies) updateDeps(deploymentPackageJson.dependencies, deps, version);
    if (deploymentPackageJson.peerDependencies) updateDeps(deploymentPackageJson.peerDependencies, deps, version);
    updateDeps(deploymentPackageJson.devDependencies, maker.package.devDependencies, version);
  });
}

// For speed in CI, allow runtime changing of yarn.lock, etc. to point to local mirrors.
function updateLockFilesRegistry(registry, p = null) {
  if (!p) console.log('[NPM]', 'use', registry);
  const dir = p ?? maker.opts.rootDir;
  const registries = ['https://registry.yarnpkg.com', 'https://registry.npmjs.org', 'https://npm.oodalolly.camp']
    .filter(r => r !== registry);

  fs.readdirSync(dir, { withFileTypes: true }).forEach(ent => {
    const fp = path.join(dir, ent.name);
    if (ent.isDirectory() && ent.name !== 'node_modules') updateLockFilesRegistry(registry, fp);
    else if (ent.isFile() && (ent.name === 'yarn.lock' || ent.name === 'package.lock.json')) {
      console.log('[NPM]', 'scan', fp);
      registries.forEach(r => {
        utils.fileReplace(fp, r, registry);
      });
    }
  });
}

async function prep(args) {
  updateLockFilesRegistry(args.npm);
  return await generate(args);
}

function updateDeps(toDeps, fromDeps, internalVersion = null, internalPrefix = '@openworkshop') {
  if (internalVersion) {
    // Bump the internal packages...
    Object.keys(toDeps).forEach((d) => {
      if (d.startsWith(internalPrefix) && toDeps[d] !== internalVersion) {
        console.log('[BUMP]', d, internalVersion);
        toDeps[d] = internalVersion;
      }
    });
  }
  if (!fromDeps) return;
  const extraDeps = Object.keys(toDeps).filter(d => !d.startsWith(internalPrefix));
  Object.keys(fromDeps).forEach((d) => {
    if (!d.startsWith(internalPrefix)) {
      const srcVersion = fromDeps[d];
      // console.log('[CHK]', d, srcVersion, toDeps[d]);
      // if (!toDeps[d]) return; // Don't add packages!
      if (toDeps[d] !== srcVersion) console.log('[COPY]', d, srcVersion);
      toDeps[d] = srcVersion;
      const i = extraDeps.indexOf(d);
      if (i >= 0) extraDeps.splice(i, 1);
    }
  });
  console.log('[PKG] updated', );
  if (extraDeps.length) console.warn('[PKG]', 'extra deps', extraDeps);
}

async function doSync(args) {
  const newSemver = args.semver ? (await maker.getSemver(args.semver)) : undefined;
  if (newSemver) {
    // Write the semver to the main package...
    await setPackageVersion(newSemver.pub);
  }

  const semver = newSemver ?? (await maker.getSemver(maker.package.version));
  console.log('[SYNC]', semver.long);

  // Copy the root dependencies right into the peerDependencies for MakerHub
  updateDeploymentPackage('src/maker-hub/package.json', semver.pub);
  // utils.updateJsonFile('src/maker-hub/package.json', (mhPackageJson) => {
  //   updateDeps(mhPackageJson.dependencies, maker.package.dependencies, semver.pub);
  //   updateDeps(mhPackageJson.devDependencies, maker.package.devDependencies, semver.pub);
  // });

  // Set this deployment's package.json to use the latest packages
  const deploymentMaker = maker.deployments[args.deployment];
  // if (newSemver) {
  // }
  console.log('[SYNC] update semver for pkgs', newSemver ? semver.pub : undefined, args.semver);
  updateDeploymentPackage(deploymentMaker.opts.pkgFp, newSemver ? semver.pub : undefined);

  // If there is a desktop app, point it at the correct maker-app
  const desktopPkgFp = path.join(deploymentMaker.opts.rootDir, 'DesktopApp', 'package.json');
  if (fs.existsSync(desktopPkgFp)) {
    const makerAppVersion = args.dev ? './src/maker-app' : semver.pub;
    utils.updateJsonFile(desktopPkgFp, (dskPkgJson) => {
      dskPkgJson.dependencies['@openworkshop/maker-app'] = makerAppVersion;
    });
  }

  // Update root hub.env to show correct product name
  await maker.saveEnv(args.dev ? 'Development' : 'Production', null, {
    MAKER_HUB_PROJECT: deploymentMaker.package.productName
  });

  // Update the .csproj to use the latest packages
  const csProjFn = `${args.deployment}.csproj`;
  const csProjFp = path.join(deploymentMaker.opts.backendDir, csProjFn);
  utils.fileReplace(csProjFp, /MakerHub" Version="(.*)"/g, `MakerHub" Version="${semver.pub}"`);
  process.chdir(deploymentMaker.opts.backendDir);

  // Install packages & set environment.
  await utils.execute('dotnet restore');
  await launchPrep(args.dev, deploymentMaker);
}

async function sync(args) {
  // Use the "latest" when no argument is provided
  await doSync(args);
}

async function dev(args) {
  await doSync({ ...args, dev: true });
}

async function launchPrep(dev, deployment) {
  const pkgTsCfgPath = path.join(deployment.opts.frontendDir, 'tsconfig.json');
  const rootTsCfgPath = path.join(maker.opts.frontendDir, 'tsconfig.base.json');

  // Alias typescript paths
  utils.setTsConfigPathAlias(rootTsCfgPath,
    '@openworkshop/current-app',
    `projects/${deployment.name}/WebApp/src`);
  utils.updateJsonFile(pkgTsCfgPath, (json) => {
    json.extends = `./tsconfig.${dev ? 'dev' : 'base'}.json`;
  });

  if (dev) {
    // Clean the nested project so that the root-level install will use local aliases properly
    utils.rmdir(path.join(deployment.opts.frontendDir, 'node_modules'));
  } else {
    // Install from within the nested project so install will use public packages
    process.chdir(deployment.opts.frontendDir);
  }
  await utils.execute('yarn install');

  const launchEnv = fs.readFileSync(deployment.opts.envFp, 'utf-8');
  console.log('[LAUNCH-ENV]', launchEnv);
}

async function entrypoint() {
  await maker.startup();
  const svLong = maker.opts.semver.long;
  await utils.yargEntrypoint(maker, require('yargs')
    .command('generate', 'Generate the .env file from the settings', (yargs) => {
      yargs.option('sv', {
        alias: 'semver',
        describe: 'Set the version of the root package',
        default: svLong.length > 0 && !svLong.includes('0.0.0') ? svLong : undefined,
      });
      yargs.option('be', {
        alias: 'backend',
        describe: 'Which ASP.NET (server hostname/port configurations) to use for the cloud backend',
        choices: ['Production', 'Staging', 'Development', undefined],
      });
    }, generate)
    .command('bump-version', 'Update all internal packages to use a new version. External must be upgraded.', (yargs) => {
      yargs.option('sv', {
        alias: 'semver',
        describe: 'Explicitly set the version of the packages',
      });
    }, bumpVersion)
    .command('sync [deployment]', 'Update and install the packages for the deployment, ensuring prod mode', (yargs) => {
      yargs.option('sv', {
        alias: 'semver',
        describe: 'Instead of inferring version from root, use a specific version',
      });
      yargs.positional('deployment', {
        describe: 'The deployment project',
        choices: maker.opts.deployments,
      });
    }, sync)
    .command('dev [deployment]', 'Switch to path aliases ', (yargs) => {
      yargs.positional('deployment', {
        describe: 'The deployment project',
        choices: maker.opts.deployments,
      });
    }, dev)
    .command('prep', 'On CI, performs a bump-version based upon the environment (otherwise NO-OP)', (yargs) => {
      yargs.option('n', {
        alias: 'npm',
        default: process.env['NPM_LOCAL_REGISTRY'] ?? 'https://registry.yarnpkg.com',
        describe: 'Local NPM registry for intermediate builds',
      });
    }, prep));
}

void entrypoint();
