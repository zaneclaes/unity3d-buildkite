#!/usr/bin/env node
const yaml = require('js-yaml');
const envsub = require('envsub');
const fs = require('fs');
const utils = require('./utils');
const minimatch = require('minimatch');

const maker = new (require('./maker')).Maker();

function addSteps(steps, fn, defaults) {
  if (!fn) return steps;
  const [stepData] = utils.readYamlFile(fn);
  const newSteps = stepData.map(s => {
    if (s['block']) return s; // Don't modify block steps
    return {
      ...defaults,
      ...s,
      agents: { ...(defaults.agents || {}), ...(s.agents || {}) }
    };
  });
  return steps.concat(newSteps);
}

// Run a glob pattern and return which filePaths match it
function globPathMatches(globPattern, filePaths) {
  const res = minimatch.match(filePaths, globPattern);
  return res;
}

function checkGroup(diffs, group) {
  let matches = [];
  const includes = group.include || {};
  // const excludes = group.exclude || {};

  // Build the include match array
  (includes.paths || []).forEach(pattern => {
    matches = matches.concat(globPathMatches(pattern, diffs));
  });
  const filteredMatches = matches; //.filter(m => (excludes.paths || []).findIndex(gl => minimatch(m, gl)) < 0);

  console.log(group.name, 'matches', filteredMatches);
  return filteredMatches.length > 0;
}

async function buildPipeline(args) {
  const diffs = (await utils.execute(args.diff)).split('\n').map(s => s.trim()).filter(s => s.length > 0);
  let build = [], deploy = [];

  const defs = maker.builder.defaults || {};

  maker.builder.steps.forEach(group => {
    const included = checkGroup(diffs, group);
    if (included) {
      build = addSteps(build, group.build, defs);
      deploy = addSteps(deploy, group.deploy, defs);
    }
  });
  console.log('[STEPS]', 'build', build);
  console.log('[STEPS]', 'deploy', deploy);

  let steps = [...build];
  if (deploy.length > 0) {
    steps.push({ block: `${maker.opts.semver.pub}?` });
    steps = steps.concat(deploy);
  }
  if (steps.length === 0) {
    steps.push({ label: 'NO-OP :partyparrot:', command: 'echo "Nothing to do."' });
  }
  const pipelineYaml = { steps };
  console.log(yaml.dump(pipelineYaml));
  fs.writeFileSync(args.pipeline, yaml.dump(pipelineYaml));

  const templateFile = args.pipeline;
  const outputFile = args.pipeline;
  const options = {
    envFiles: [maker.opts.envFp],
  };
  envsub({ templateFile, outputFile, options });
}


async function entrypoint() {
  await maker.startup();
  await utils.yargEntrypoint(maker, require('yargs')
    .option('p', {
      alias: 'pipeline',
      default: './maker/pipeline.yml',
      describe: 'The output file that is read as the pipeline',
    })
    .option('d', {
      alias: 'diff',
      default: 'git diff --name-only HEAD~1',
      describe: 'The command which builds the file list',
    })
    .command('build', 'Build the pipeline', () => {}, buildPipeline)
  );
}

void entrypoint();
