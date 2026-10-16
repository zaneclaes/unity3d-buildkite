#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const templates = require('./doc-templates');
const utils = require('./utils');
const watch = require('node-watch');

const maker = new (require('./maker')).Maker();
const rename = { 'readme': 'index' };

function titleArr(str) {
  return str.split('-').map(s => s.charAt(0).toUpperCase() + s.substr(1));
}

function buildTemplate(fp, srcDir, dstDir) {
  const fn = path.basename(fp, '.md');
  const fnLwr = fn.toLowerCase();
  const name = rename[fnLwr] ?? fn;
  const relDir = fp.replace(srcDir, '').replace(path.basename(fp), '').trim('/');
  const relDirs = relDir.split('/').filter(p => p.length > 0);

  console.log('[DOCS]', fp);

  let md = fs.readFileSync(fp).toString().replaceAll('`', '\\`');
  const meta = { };
  if (md.startsWith('---')) {
    const lines = md.split('\n');
    lines.shift();
    const endLine = lines.findIndex(l => l.startsWith('---'));
    if (endLine >= 0) {
      const metaDataLines = lines.slice(1, endLine);
      metaDataLines.forEach(line => {
        const kvp = line.split(': ');
        meta[kvp[0].trim()] = kvp[1];
      });
      md = lines.slice(endLine + 1).join('\n');
    }
  }
  const isIndex = name === 'index';
  const dispName = isIndex ? relDirs[relDirs.length - 1] : name;
  const names = relDirs.concat(name.split('-')).map(s => s.charAt(0).toUpperCase() + s.substr(1));
  const componentName = names.join('');
  const preview = md.split('\n').map(s => s.trim()).find(s => s.match(/^[\w]+/i));

  meta['title'] = meta['title'] ?? titleArr(dispName ?? 'Documentation').join(' ');
  meta['filename'] = fn;
  meta['preview'] = fn;
  meta['path'] = relDirs;

  const txt = templates.reactMdComponent
    .trim()
    .replaceAll('[MARKDOWN]', md.trim())
    .replaceAll('[PREVIEW]', preview ?? '')
    .replaceAll('[MD_COMPONENT_NAME]', componentName)
    .replaceAll('[MD_META]', JSON.stringify(meta).replaceAll('"', "'"))
    .replaceAll('``', "''");

  const fd = path.join(dstDir, ...relDirs, (isIndex ? 'index' : componentName) + '.tsx');
  const isNew = !fs.existsSync(fd);
  fs.writeFileSync(fd, txt);
  return { componentName, name, txt, meta, fd, isNew };
}

function buildDocFolder(srcDir, dstDir, relDirs = [], manifest = {}) {
  utils.mkdir(path.join(dstDir, ...relDirs));
  fs.readdirSync(path.join(srcDir, ...relDirs), { withFileTypes: true }).forEach(ent => {
    if (ent.name.startsWith('.')) {
      return;
    }

    if (ent.isDirectory()) {
      buildDocFolder(srcDir, dstDir, [...relDirs, ent.name], manifest);
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      const fp = path.join(srcDir, ...relDirs, ent.name);
      const temp = buildTemplate(fp, srcDir, dstDir);
      manifest[path.join(...relDirs, temp.name)] = temp.componentName;
    }
  });

  return manifest;
}

async function buildDocs(args) {
  const manifest = buildDocFolder(args.src, args.dest);

  const imports = [
    'import React from \'react\';',
  ];
  const clauses = [];
  const previewClauses = [];
  const metaClauses = [];
  const components = [];
  const paths = Object.keys(manifest);
  const allPaths = [...paths];
  paths.forEach(p => {
    const n = manifest[p];
    const paths = p.split('/');
    const lp = paths.length - 1;
    if (paths[lp] !== 'index') paths[lp] = n;
    const previewName = `preview${n}`;
    const metaName = `meta${n}`;
    components.push(n);
    imports.push(`import ${n}, { ${previewName}, ${metaName} } from './${paths.join('/')}';`);
    clauses.push(`if (p === '${p}') return <${n} />;`);
    previewClauses.push(`if (p === '${p}') return ${previewName};`);
    metaClauses.push(`if (p === '${p}') return ${metaName};`);
    if (p.endsWith('index')) {
      const r = p.substr(0, p.length - 'index'.length)
        .split('/').filter(p => p.length > 0).join('/');
      clauses.push(`if (p === '${r}') return <${n} />;`);
      previewClauses.push(`if (p === '${r}') return ${previewName};`);
      metaClauses.push(`if (p === '${r}') return ${metaName};`);
      allPaths.push(r);
    }
  });

  const hooksCode = `${imports.join('\n')}
import { DocsPath } from './types';
import { IMarkdownMeta } from '../types';

export { ${components.join(', ')} };

export function getMarkdownComponent(p: DocsPath): React.ReactNode | undefined {
  ${clauses.join('\n  ')}
  return undefined;
};

export function getMarkdownPreview(p: DocsPath): string | undefined {
  ${previewClauses.join('\n  ')}
  return undefined;
};

export function getMarkdownMeta(p: DocsPath): IMarkdownMeta | undefined {
  ${metaClauses.join('\n  ')}
  return undefined;
};
`;
  fs.writeFileSync(path.join(args.dest, 'hooks.tsx'), hooksCode);

  const typesCode = `export type DocsPath = '${allPaths.join('\'\n  | \'')}';
`;
  fs.writeFileSync(path.join(args.dest, 'types.ts'), typesCode);

  // console.log(imports, clauses);
  console.log('generated documentation', Object.keys(manifest));

  await utils.execute(`eslint ${args.dest} --ext .ts,.tsx --fix`);
}

async function watchDocs(args) {
  await buildDocs(args);
  watch(args.src, { recursive: true }, async function(evt, name) {
    if (name.startsWith('.') || !name.endsWith('.md')) {
      return;
    }
    const temp = buildTemplate(name, args.src, args.dest);
    if (temp.isNew) {
      // Recreate manifests, etc. when the file is new
      await buildDocs(args);
    } else {
      await utils.execute(`eslint ${temp.fd} --fix`);
    }
  });
}

async function entrypoint() {
  await maker.startup();
  const makerHubRoot = path.join(maker.opts.srcDir, 'maker-hub');
  await utils.yargEntrypoint(maker, require('yargs')
    .option('s', {
      alias: 'src',
      default: path.join(maker.opts.rootDir, 'Documentation'),
    })
    .option('d', {
      alias: 'dest',
      default: path.join(makerHubRoot, 'src', 'docs', 'generated'),
    })
    .command('generate', 'Generate documentation from markdown', () => {},
      buildDocs)
    .command('watch', 'Develop docs in real-time by watching the folder', () => {},
      watchDocs)
  );
}

void entrypoint();
