// const nodeResolve = require('@rollup/plugin-node-resolve');
const generatePackageJson = require('rollup-plugin-generate-package-json');
// const commonjs = require('@rollup/plugin-commonjs');
const copy = require('rollup-plugin-copy');
const pkg = require('./package.json');

function generateBin(bin) {
  const ret = {};
  Object.keys(bin).forEach((k) => {
    ret[k] = bin[k].replace('src/', '');
  });
  return ret;
}

module.exports = [
  {
    input: 'src/index.js',
    output: [{ file: 'dist/index.js', format: 'cjs' }],
    plugins: [
      // externalDependencies.default(),
      // commonjs(),
      copy({
        targets: [
          { src: 'src/**/*.js', dest: 'dist' },
          { src: 'README.md', dest: 'dist' },
        ],
        flatten: false,
      }),
      generatePackageJson({
        outputFolder: 'dist',
        baseContents: (base) => ({
          ...pkg,
          ...base,
          main: pkg.main.replace('src/', ''),
          bin: generateBin(pkg.bin),
          scripts: undefined,
        }),
      }),
      // nodeResolve(),
    ],

    external: [
      // ...builtinModules,
      ...(pkg.dependencies == null ? [] : Object.keys(pkg.dependencies)),
      ...(pkg.devDependencies == null ? [] : Object.keys(pkg.devDependencies)),
      ...(pkg.peerDependencies == null ? [] : Object.keys(pkg.peerDependencies))
    ]

    // exclude externalDependencies' flags
    // external: (id) => id.includes('fp-ts'),
  },
];
