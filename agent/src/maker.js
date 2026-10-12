const fs = require('fs');
const path = require('path');
const utils = require('./utils');
const dotenv = require('dotenv');
const isReachable = require('is-reachable');
const simpleGit = require('simple-git');

const semverRe = /^((?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+))?-?(?<pre>[\w\d\\.]+)?$/;
const channels = {
  latest: 'latest', // Default, protected GitHub branch
  beta: 'beta', // Protected GitHub branch
  alpha: 'alpha', // A PR-less CI build, or a dev build
};

const parseSemver = (semverStr, oldSemver, defaultChannel = undefined) => {
  const match = semverRe.exec(semverStr);
  if (!match) {
    throw new Error(`Could not convert ${semverStr} to semver`);
  }

  const isNew = !!oldSemver;
  const prereleases = (match.groups.pre ?? '').split('.').filter(s => s.length > 0);

  // Attempt to parse a build number off the end of the prereleases.
  // Any number at the end will get matched and popped off the prereleases array.
  const buildNum = prereleases.length > 0 ?
    Number.parseInt(prereleases[prereleases.length - 1].toString()) : undefined;
  const build = buildNum ? buildNum : undefined;
  if (build) {
    prereleases.pop();
    if (isNew) console.log('[BUILD]', '#', build, 'CI?', process.env['CI']);
  }

  // If there are any strings remaining in the prereleases, they must be the branch name.
  let channel = prereleases.length > 0 ? prereleases.join('.') : defaultChannel;
  const allChannels = Object.keys(channels); // Everyone can build beta
  if (!allChannels.includes(channel)) {
    console.log(`Channel '${channel}' is not valid. Choose from: ${allChannels}`);
    channel = defaultChannel;
    if (!channel) {
      throw new Error('Invalid channel.');
    }
  }
  if (isNew) console.log('[CI]', 'selected channel', channel, 'from', allChannels);

  const branchOrBuild = channel ?? build;
  const suffix = channel && build ? `${channel}.${build}` : branchOrBuild;

  const major = parseInt(match.groups.major ?? oldSemver.major);
  const minor = parseInt(match.groups.minor ?? oldSemver.minor);
  const patch = parseInt(match.groups.patch ?? oldSemver.patch);

  const short = `${major}.${minor}.${patch}`;
  const inv = [major, minor, patch].filter(n => !n && n !== 0);
  if (inv.length > 0) {
    throw new Error(`invalid ${short}`);
  }

  const medium = channel ? `${short}-${channel}` : short;
  const long = suffix ? `${short}-${suffix}` : short;
  const pub = channel === channels.latest ? short : long;

  return {
    short, medium, long, pub, major, minor, patch, channel,
    suffix: suffix ?? null, build: build ?? null
  };
};

class Maker {
  constructor(rootDir = null, name = null) {
    rootDir = rootDir ?? process.cwd();
    this.name = name;
    const [envFp, makerEnvFp] = this.loadEnv(rootDir);

    const frontendPath = process.env['MAKER_FRONTEND'];
    const backendPath = process.env['MAKER_BACKEND'];
    const srcPath = process.env['MAKER_SRC'] ?? 'src';

    const frontendDir = frontendPath ? path.join(rootDir, frontendPath) : rootDir;
    const backendDir = backendPath ? path.join(rootDir, backendPath) : rootDir;
    const ymlFp = process.env['MAKER_BUILDER_YML'] ?? path.join(rootDir, 'maker', 'builder.yml');
    const pkgFp = path.join(frontendDir, 'package.json');

    const [yml] = utils.readYamlFile(ymlFp);
    this.builder = yml;

    const [pkg] = utils.readJsonFile(pkgFp);
    this.package = pkg;

    // Enumerate packages & deployments
    const srcDir = path.join(rootDir, srcPath);
    const projDir = path.join(srcDir, 'projects');
    const packages = !fs.existsSync(srcDir) ? [] : fs.readdirSync(srcDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory() && dirent.name !== 'projects').map(dirent => dirent.name);
    const deployments = !fs.existsSync(projDir) ? [] : fs.readdirSync(projDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);

    // Infer Github information
    this.git = simpleGit({ baseDir: process.cwd() });

    // Load the deployments as their own Maker instance.
    this.deployments = {};
    deployments.forEach(d => {
      this.deployments[d] = new Maker(path.join(projDir, d), d);
    });

    // After loading deployments, re-load the current env. which may have been clobbered.
    this.loadEnv(rootDir);

    // Buildkite sets the CI env var.
    const isCi = !!process.env['CI'];
    const allowedChannels = [channels.alpha, channels.beta]; // Everyone can build.
    let defaultChannel = channels.latest;
    if (isCi) {
      // Only CI can build these
      allowedChannels.push(channels.latest);
      if (process.env['BUILDKITE_BRANCH'] !== channels.latest) defaultChannel = channels.beta;
    } else {
      // Development machine defaults to alpha.
      defaultChannel = channels.alpha;
    }

    this.opts = {
      rootDir, envFp, makerEnvFp, srcDir, frontendDir, backendDir, ymlFp, pkgFp,
      isCi, allowedChannels, defaultChannel, deployments, packages, projDir
    };

    console.log('[MB]', this.opts);
  }

  // eslint-disable-next-line
  loadEnv = (rootDir) => {
    const envFp = path.join(rootDir, 'hub.env');
    if (fs.existsSync(envFp) && (!this.env || process.env['MAKER_HUB_ENV'] !== envFp)) {
      this.env = dotenv.config({ path: envFp })?.parsed ?? {};
      process.env['MAKER_HUB_ENV'] = envFp;
      console.log('[ENV]', 'loaded', envFp);
    } else if (!this.env) {
      this.env = {};
    }

    const makerEnvFp = path.join(rootDir, 'maker.env');
    if (fs.existsSync(makerEnvFp) && (!this.makerEnv || process.env['MAKER_ENV'] !== makerEnvFp)) {
      this.makerEnv = dotenv.config({ path: makerEnvFp })?.parsed ?? {};
      process.env['MAKER_ENV'] = makerEnvFp;
      console.log('[ENV]', 'maker', makerEnvFp);
    } else {
      // Unset the vars when the file is not present, so defaults are applied
      delete process.env['MAKER_FRONTEND'];
      delete process.env['MAKER_BACKEND'];
      delete process.env['MAKER_SRC'];
      console.log('[ENV]', 'maker defaults');
    }

    return [envFp, makerEnvFp];
  };

  startup = async () => {
    // Github -- branch?
    const isCwdRoot = await this.git.checkIsRepo('root');
    const status = await this.git.status();
    const branch = process.env['BUILDKITE_BRANCH'] ?? status.current;
    const releaseBranches = ['beta', 'latest'];
    const isReleaseBranch = releaseBranches.includes(branch);
    this.gitHub = { isCwdRoot, branch, releaseBranches, isReleaseBranch, status };
    console.log('[GITHUB]', this.gitHub);

    // Semver (load/generate) to use as a default later
    this.opts.semver = await this.getSemver();
  };

  saveEnv = async (appEnv = 'Production', sv = null, overrides = {}) => {
    sv = sv ?? this.opts.semver;
    let channel = sv.channel;
    if (!this.opts.allowedChannels.includes(channel)) {
      console.log('[CI] channel', channel, 'is not in',
        this.opts.allowedChannels, '; using', this.opts.defaultChannel);
      channel = this.opts.defaultChannel;
      if (!this.opts.allowedChannels.includes(channel)) {
        throw new Error('invalid channel ' + channel);
      }
    }
    
    const defProductName = this.env['MAKER_HUB_PROJECT'] ?? this.package.name;
    const defAppEnv = this.env['MAKER_HUB_APP_ENVIRONMENT'] ?? 'Production';
    const defBackEnv = appEnv === 'Development' ? appEnv : (this.env['MAKER_HUB_BACKEND_ENVIRONMENT'] ?? defAppEnv);
    const productName = this.package.productName ?? defProductName;
    const isOws = productName === 'OpenWorkShop';
    let beEnv = appEnv ?? defBackEnv;
    const hostDomainName = this.makerEnv['MAKER_HUB_HOST_DOMAIN_NAME'] ?? '';
    const isWeb = hostDomainName.length > 0; // Presence of an explicit domain means we are online.
    let hubSubdomain = undefined;
    let hubScheme = 'http';
    let hubName = 'localhost';
    const listenPort = parseInt(this.makerEnv['MAKER_HUB_LISTEN_PORT'] ?? 8000) ?? 8000;
    let hubPort = listenPort; // Will get changed in isWeb mode.
    let hubLocal = true;

    if (beEnv === 'Development') {
      const devUrl = 'http://dev.openwork.shop:5000';
      const canReachDev = await isReachable(devUrl);
      const canUseDev = isOws || canReachDev;
      if (!canUseDev) {
        console.log('[BE]', 'using Staging backend because', devUrl, 'is not reachable.');
        beEnv = 'Staging';
      }
    }

    let appEnvName = appEnv ?? defAppEnv;
    const allowedAppEnvs = ['Production', 'Staging'];
    if (!this.opts.isCi) allowedAppEnvs.push('Development');
    if (!allowedAppEnvs.includes(appEnvName)) {
      console.log('[CI]', 'cannot use', appEnvName, 'app; enforcing production');
      appEnvName = 'Production';
    }

    if (isWeb) {
      if (appEnvName === 'Development') {
        hubSubdomain = 'dev';
      } else if (appEnvName === 'Staging') {
        hubSubdomain = 'staging';
        hubScheme = 'https';
        hubPort = 0;
        hubLocal = false;
      } else {
        appEnvName = 'Production';
        hubScheme = 'https';
        hubPort = 0;
        hubLocal = false;
      }

      if(hubSubdomain) {
        hubName = [hubSubdomain, hostDomainName].join('.');
      } else {
        hubName = hostDomainName;
      }
    }

    const allowedBeEnvs = ['Production', 'Staging'];
    if (!this.opts.isCi) {
      allowedBeEnvs.push('Development');
    }

    if (!allowedBeEnvs.includes(beEnv)) {
      console.log('[CI]', 'cannot use', beEnv, 'backend; enforcing Production.');
      beEnv = 'Production';
    }

    const portStr = hubPort > 0 ? `:${hubPort}` : '';
    const hubUrl = `${hubScheme}://${hubName}${portStr}`;

    const hubEnv = {
      ASPNETCORE_ENVIRONMENT: appEnvName,
      MAKER_HUB_APP_ENVIRONMENT: appEnvName,
      MAKER_HUB_PROJECT: productName,
      MAKER_HUB_SEMVER_SHORT: sv.short,
      MAKER_HUB_SEMVER_MEDIUM: sv.medium,
      MAKER_HUB_SEMVER_LONG: sv.long,
      MAKER_HUB_SEMVER_PUB: sv.pub,
      MAKER_HUB_BUILD_NUMBER: sv.build ?? 0,
      MAKER_HUB_BACKEND_ENVIRONMENT: beEnv,
      MAKER_HUB_CHANNEL: channel,
      MAKER_HUB_SUBDOMAIN: hubSubdomain ?? '',
      MAKER_HUB_SCHEME: hubScheme,
      MAKER_HUB_HOSTNAME: hubName,
      MAKER_HUB_PORT: hubPort,
      MAKER_HUB_LOCAL: hubLocal,
      MAKER_HUB_URL: hubUrl,
      ...overrides,
    };
    utils.saveDotEnv(this.opts.envFp, hubEnv);

    const makerEnv = {
      ...this.makerEnv,
      MAKER_HUB_HOST_DOMAIN_NAME: hostDomainName,
      MAKER_HUB_LISTEN_PORT: listenPort,
      MAKER_HUB_FRONTEND_PORT: parseInt(this.makerEnv['MAKER_HUB_FRONTEND_PORT'] ?? 3000) ?? 3000,
    };
    utils.saveDotEnv(this.opts.makerEnvFp, makerEnv);

    const makerHubProject = hubEnv['MAKER_HUB_PROJECT'];

    const dep1 = path.join(this.opts.rootDir, 'WebApp', 'src', 'deployment.json');
    let depJson = dep1;
    if (!fs.existsSync(depJson)) {
      depJson = path.join(this.opts.frontendDir, 'src', 'projects', makerHubProject, 'WebApp', 'src', 'deployment.json');
    }

    console.log('[PUB]', depJson);
    if (fs.existsSync(depJson)) {
      const version = sv.medium;
      const { name, productName, description, homepage, author, license, repository } = this.package;
      console.log('[PUB] updating deployment.json', version);
      utils.updateJsonFile(depJson, d => {
        d.package = { name, productName, version, description, homepage, author, license, repository };
        d.semver = sv;
        d.env = hubEnv;
        d.makerEnv = makerEnv;
      });
    } else {
      console.log(`Missing both ${dep1} and ${depJson}`);
    }

    return hubEnv;
  };

  // Use environment to get a string representing the presumed semver
  generateSemver = async () => {
    const pr = process.env['BUILDKITE_PULL_REQUEST'];
    const build = process.env['BUILDKITE_BUILD_NUMBER'];
    // const baseBranch = process.env['BUILDKITE_PULL_REQUEST_BASE_BRANCH'];
    const envSemver = process.env['MAKER_HUB_SEMVER_LONG'];
    const pkgSemver = await this.getSemver(this.package.version ?? `0.0.0-${channels.alpha}`);
    const curVersion = this.opts.semver ?? pkgSemver;
    const branch = this.gitHub.branch;
    // const targetBranch = baseBranch ?? branch;

    if (this.opts.isCi) {
      let channel = this.opts.defaultChannel;
      const buildNum = build ?? '0';
      if (pr && pr !== 'false') {
        // pull request...
        channel = channels.alpha;
      } else if (Object.keys(channels).includes(branch)) {
        // building a channel deployment
        channel = branch;
      } else {
        // building non-pr, non-channel branch (something random)
        channel = channels.alpha;
      }
      return `${curVersion.short}-${channel}.${buildNum}`;
    } else if (this.opts.semver) {
      // Something was previously loaded by dotenv
      return this.opts.semver.long;
    } else if (pkgSemver) {
      // load package.json verion
      return pkgSemver.long;
    }
    return envSemver ?? `0.0.0-${channels.alpha}`;
  };

  // Get an object representing a MakerHub compliant semantic version.
  // If no string is passed, the semver is inferred from the environment.
  getSemver = async (semverStr = null) => {
    const isNew = !!semverStr;
    const oldSemver = isNew ? this.opts.semver : undefined;
    const newSemver = parseSemver(semverStr ?? (await this.generateSemver()), oldSemver,
      this.opts.defaultChannel);
    if (isNew && oldSemver) console.log('[SV]', 'old', oldSemver.long, 'new', semverStr, '=>', newSemver);
    return newSemver;
  };

  prepareArtifactDir = (bin, type, newVersion) => {
    const binDir = path.isAbsolute(bin) ? bin : path.join(this.opts.rootDir, bin);
    const artifactDir = path.join(binDir, type, newVersion);
    utils.mkdir(artifactDir);
    return artifactDir;
  };
}

module.exports = { Maker, parseSemver, channels };
