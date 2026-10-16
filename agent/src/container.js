#!/usr/bin/env node
const utils = require('./utils');
const imgRe = /^((?<registry>[\w.\d-]+)\/)?(?<org>[\w.\d-]+)\/(?<product>[\w.\d-]+)(:(?<tag>[\w.\d-]+))?$/;
const dockerUser = process.env['DOCKER_USER'] ?? 'inzania';
const dockerCredsFlag = process.env['DOCKER_PASS'] ? `"--creds=${dockerUser}:$DOCKER_PASS"` : '';

const maker = new (require('./maker')).Maker();

const buildahNoTlsFlag = '--tls-verify=false';
const buildahIsolationFlag = '--isolation chroot';

function matchDockerImage(str, re) {
  const r = re ?? imgRe;
  if (!str || str.length <= 0) {
    throw new Error('No docker image name provided.');
  }
  const match = r.exec(str);
  if (!match) {
    throw new Error(`Could not convert ${str} to docker format`);
  }
  return match;
}

async function build(args) {
  console.log('[BUILD]', args);
  await freeSpace(args);
  process.chdir(args.cwd);

  const fullArch = utils.commonArchStringFromYargs(args);
  const tagOs = args.os === 'mac' ? 'linux' : args.os; // Mac & Linux use same OS flavor, whereas Windows is unique.
  const arch = args.arch;
  const archVariant = args.arch_variant;
  const tag = `${tagOs}-${fullArch}-${utils.getBuildId()}`;
  const match = matchDockerImage(args.img);
  const imgName = `${match.groups.org}/${match.groups.product}`;

  const buildArgs = {
    'NPM_YARN_REGISTRY': args.npm,
    'DOCKER_REGISTRY': args.localRegistry,
    'MAKER_BUILDER_ARCH': fullArch,
    BUILDAH_ARCH_VARIANT: process.env['BUILDAH_ARCH_VARIANT'] ?? archVariant,
    BUILDAH_CPU: process.env['BUILDAH_CPU'] ?? args.cpu,
    BUILDAH_ARCH: process.env['BUILDAH_ARCH'] ?? arch,
    BUILDAH_OS: process.env['BUILDAH_OS'] ?? args.os,
  };
  const cmd = args.builder === 'buildah' ? 'bud' : 'build';
  const buildFlags = [`--file ${args.file}`];
  const registryFlags = [];//build goes internal
  if (args.builder === 'docker') {
    delete process.env['DOCKER_TLS_VERIFY'];
    delete process.env['DOCKER_CERT_PATH'];
  } else if (args.builder === 'buildah') {
    registryFlags.push(buildahNoTlsFlag);
    buildFlags.push(buildahIsolationFlag);
  }
  const flags = buildFlags.concat(registryFlags);

  console.log('[BUILD]', arch, args.cpu, archVariant, '=>', fullArch);
  if (arch === 'arm') {
    flags.push('--arch arm');
    flags.push(`--variant "${archVariant}"`);

    const targ = `bullseye-slim-${fullArch}`;
    buildArgs['DOTNET_RUNTIME'] = targ;
    buildArgs['DOTNET_SDK'] = `6.0-${targ}`;
    buildArgs['DOTNET_ARCH'] = 'arm';
    buildArgs['BUILDKITE_ARCH'] = 'armhf';
  }
  if (process.env['DOTNET_ARCH']) buildArgs['DOTNET_ARCH'] = process.env['DOTNET_ARCH'];
  Object.keys(buildArgs).forEach((a) => {
    flags.push(`--build-arg ${a}="${buildArgs[a]}"`);
  });

  const registryImgTagged = `${args.localRegistry}/${imgName}:${tag}`;
  console.log('[BUILD]', registryImgTagged);
  await container(`${cmd} ${flags.join(' ')} -t "${registryImgTagged}" .`, args);

  console.log('[PUSH]', registryImgTagged);
  // Alwas done to inter
  await container(`push ${registryFlags.join(' ')} "${registryImgTagged}"`, args);
}

async function addToManifest(registry, imgName, tag, arch, args) {
  const m = utils.parseArch(arch);
  const os = m.groups.os ?? 'linux';
  const cpu = m.groups.cpu ?? '';
  const archVariant = m.groups.arch_variant ?? '';
  const osArchTag = `${os}-${m.groups.arch}${cpu}${archVariant}`;
  const buildId = utils.getBuildId();
  const manifest = `${registry}/${imgName}:${tag}`;
  const srcImg = `${args.localRegistry}/${imgName}:${osArchTag}-${buildId}`; // source is always contained in this registry
  // const dstImg = `${registry}/${imgName}:${tag}-${osArchTag}`;// dest is the target registry with the final tag.

  // Mirror the concrete source image to the concrete dest image.
  console.log('[MANIFEST]', srcImg, arch, m.groups);
  // await container(`pull -q ${buildahNoTlsFlag} ${srcImg}`, args);
  // await container(`tag ${srcImg} ${dstImg}`, args);
  // await container(`push -q ${dockerCredsFlag} ${dstImg}`, args);

  // Put the dest image into the manifest.
  const flags = [buildahNoTlsFlag];
  if (m.groups.arch !== 'amd') {
    flags.push(`--arch ${m.groups.arch}`);
    flags.push(`--variant ${m.groups.arch_variant}`);
  }
  if (os !== 'linux') {
    const realOs = os.startsWith('win') ? 'windows' : os;
    flags.push(`--os ${realOs}`);
  }

  await container(`manifest add ${flags.join(' ')} ${manifest} ${srcImg}`, args);
}

async function deploy(args) {
  console.log('[DEPLOY]', args);
  process.chdir(args.cwd);

  const pub = args.publicRegistry;
  const tag = (args.tag && args.tag.length > 0) ? args.tag : 'dev';
  const match = matchDockerImage(args.img);
  const imgName = `${match.groups.org}/${match.groups.product}`;
  const archs = (args.archs ?? '').split(',').filter(s => s.length > 0);
  if (archs.length <= 0) throw new Error('No architectures');

  const registry = args.localRegistry;
  console.log('[DEPLOY]', registry, imgName, tag, 'for', archs);

  const manifest = `${registry}/${imgName}:${tag}`;

  // Create
  await removeImage(manifest, args);
  await container(`manifest create ${manifest}`, args);

  // Add images
  for(let i=0; i<archs.length; i++) {
    await addToManifest(registry, imgName, tag, archs[i], args);
  }

  // Print results
  await container(`inspect ${manifest}`, args);

  // Push
  const isPub = registry === pub;
  const flags = [];
  if (isPub) flags.push(dockerCredsFlag);
  else flags.push(buildahNoTlsFlag); // No TLS verify on internal pushes
  await container(`manifest push ${manifest} ${flags.join(' ')} "docker://${manifest}"`, args);
  // await removeImage(manifest, args);

  // Copy the image/manifest to the public docker repo
  if (registry !== pub) {
    await utils.execute(`regctl registry set ${args.localRegistry} --tls disabled`);
    await utils.execute(`regctl registry login ${pub} -u "$DOCKER_USER" -p "$DOCKER_PASS"`);
    await utils.execute(`regctl image copy -v debug ${manifest} ${pub}/${imgName}:${tag}`);
  }
}

async function removeImage(img, args) {
  console.log('[RMI]', img);
  await container(`rmi --force ${img} 2> /dev/null`, args, true);
}

async function getImages(args) {
  const lines = (await container('images', args, true)).split('\n');
  lines.shift();
  const map = {};
  lines.forEach(l => {
    const parts = l.split(' ').filter(s => s.length > 0);
    // const i = l.split(' ')[0];
    if (parts.length < 3) return;
    const [img, tag, id] = parts;
    if (!map[img]) map[img] = {};
    map[img][id] = tag;
  });
  return map;
}

async function freeSpace(args) {
  if (args.builder === 'docker') {
    await container('system prune --force', args);
    return;
  }

  if (!args.img || args.img.length <= 0) throw new Error('no img');
  console.log('[FREE]', args.img);
  const images = await getImages(args);
  const imgNames = Object.keys(images);
  for(let i=0; i<imgNames.length; i++) {
    const img = imgNames[i];
    if (!img.endsWith(args.img)) continue;
    const idMap = images[img];
    const ids = Object.keys(idMap);
    for (let j=0; j<ids.length; j++) {
      const id = ids[j];
      const tag = idMap[id];
      console.log('[FREE]', tag);
      await removeImage(id, args);
    }
  }

  // await container('rmi --prune', args, true);
  // await container('images', args, true);
  // await container('rm --all', args, true);
  // await container('containers', args, true);
}

async function mirror(args) {
  process.chdir(args.cwd);

  const mirrorRe = /^((?<org>[\w.\d-]+)\/)?(?<product>[\w.\d-]+)(:(?<tag>[\w.\d-]+))?$/;
  const match = matchDockerImage(args.from, mirrorRe);
  const img = match.groups.org ? `${match.groups.org}/${match.groups.product}` : match.groups.product;
  const tag = (args.tag ?? match.groups.tag) ?? 'latest';
  const img_to = `${args.localRegistry}/${img}:${tag}`;
  console.log('[MIRROR]', args.from, '=>', img_to);
  await container(`pull -q ${buildahNoTlsFlag} ${args.from}`, args);
  await container(`tag ${args.from} ${img_to}`, args);
  await container(`push -q ${buildahNoTlsFlag} ${img_to}`, args);
}

async function container(cmd, args, suppressErrors) {
  if (args.dryRun) {
    console.log(`${args.builder} ${cmd}`);
    return '';
  }
  return await utils.execute(`${args.builder} ${cmd}`, suppressErrors);
}

//
// function inferTag() {
//   const pr = process.env['BUILDKITE_PULL_REQUEST'];
//   const branch = process.env['BUILDKITE_BRANCH'];
//   if (branch === undefined) {
//     // Not in CI
//     return 'dev';
//   }
//   if (pr !== 'false') {
//     // PRs are always beta
//     return 'beta';
//   }
//   if (branch !== 'master') {
//     // Non-master, non-PR; just a branch build.
//     return 'alpha';
//   }
//   return 'latest';
// }

async function entrypoint() {
  await maker.startup();
  await utils.yargEntrypoint(maker, utils.metadataYargs(require('yargs'))
    .option('b', {
      alias: 'builder',
      default: utils.getCommand(['buildah', 'docker']),
      describe: 'The tool used for building containers',
    })
    .option('l', {
      alias: 'local-registry',
      default: process.env['DOCKER_LOCAL_REGISTRY'] ?? 'docker.io',
      describe: 'Local container registry for intermediate builds',
    })
    .option('r', {
      alias: 'public-registry',
      default: process.env['DOCKER_PUBLIC_REGISTRY'] ?? 'docker.io',
      describe: 'Public container registry for final builds',
    })
    .option('n', {
      alias: 'npm',
      default: process.env['NPM_LOCAL_REGISTRY'] ?? 'https://registry.yarnpkg.com',
      describe: 'Local NPM registry for intermediate builds',
    })
    .option('t', {
      alias: 'tag',
      describe: 'Tag to use for this docker image',
      default: process.env['MAKER_HUB_CHANNEL'] ?? 'latest',
    })
    .option('f', {
      alias: 'file',
      default: 'Dockerfile',
      describe: 'Name of the dockerfile',
    })
    .option('d', {
      alias: 'cwd',
      default: maker.opts.rootDir,
      describe: 'Directory in which to find the dockerfile',
    })
    .option('dry-run', {
      default: false,
      describe: 'Skip running commands',
    })
    .command('mirror [from]', 'Mirror the docker image to a different repo', (yargs) => {
      yargs.positional('from', { describe: 'The docker repository to pull from' });
    }, mirror)
    .command('build [img]', 'Build the docker image', (yargs) => {
      yargs.positional('img', { describe: 'The name of the image to build' });
    }, build)
    .command('deploy [img] [archs]', 'Deploy the docker image', (yargs) => {
      yargs.positional('img', { describe: 'The name of the image to deploy' });
      yargs.positional('archs', {
        describe: 'All architectures to include',
        default: 'amd64,arm32v7,arm64v8'
      });
    }, deploy)
    .command('free [img]', 'Free up disk space by removing all tags for an image', (yargs) => {
      yargs.positional('img', { describe: 'The name of the image to clean' });
    }, freeSpace)
  );
}

void entrypoint();
