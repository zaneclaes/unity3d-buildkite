const { readGitignoreFiles } = require('eslint-gitignore');

// const projDir = process.cwd();
// console.log('[MB]', 'configs@', projDir);

const lintIgnoreFilePatterns = (projDir) => {
  // const fp = path.join(projDir, '.gitignore');
  // const data = fs.readFileSync(fp, 'utf8');
  // const patterns = data.split('\n').map(s => s.trim()).filter(s => s.length > 0);
  // https://github.com/eslint/eslint/issues/13389#issuecomment-642593891
  const gitIgnorePatterns = readGitignoreFiles({ cwd: projDir });
  // fs.writefil
  // console.log(gitIgnorePatterns);/**/
  return gitIgnorePatterns.concat(['rollup.config.js']);
};

const jslint = (projDir) => {
  const ignorePatterns = lintIgnoreFilePatterns(projDir);
  return {
    root: true,
    extends: [
      'eslint:recommended',
    ],
    env: {
    },
    rules: {
      'linebreak-style': ['error', 'unix'],
      'quotes': ['error', 'single', { 'avoidEscape': true, 'allowTemplateLiterals': false }],
      'semi': ['error', 'always'],
    },
    ignorePatterns
  };
};

const nodelint = (projDir) => {
  const esl = jslint(projDir);
  return {
    ...esl,
    parser: '@babel/eslint-parser',
    env: {
      ...esl.env,
      es6: true,
      node: true,
    },
    plugins: ['@babel'],
    parserOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      requireConfigFile: false,
      babelOptions: {},
      // ecmaVersion: 6,
      // ecmaFeatures: {
      //   experimentalObjectRestSpread: true
      // }
    }
  };
};

const tslint = (projDir) => {
  const esl = jslint(projDir);
  return {
    ...esl,
    parser: '@typescript-eslint/parser',
    plugins: ['@typescript-eslint', 'unused-imports'],
    extends: [
      'plugin:@typescript-eslint/recommended',
      'plugin:@typescript-eslint/recommended-requiring-type-checking',
      'plugin:prettier/recommended',
    ],
    rules: {
      ...esl.rules,
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/restrict-plus-operands': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/no-empty-interface': 'warn',
      'prettier/prettier': 'warn',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        { 'vars': 'all', 'varsIgnorePattern': '^_', 'args': 'after-used', 'argsIgnorePattern': '^_' }
      ]
    },
    parserOptions: {
      project: ['./tsconfig.json'],
      tsconfigRootDir: projDir,
      // ecmaVersion: 2020,
      // sourceType: 'module',
    },
  };
};

const prettier = {
  'trailingComma': 'all',
  'tabWidth': 2,
  'semi': true,
  'singleQuote': true,
  'printWidth': 80,
  'jsxSingleQuote': true,
  // 'quoteProps': 'as-needed',
  'bracketSpacing': true,
  'bracketSameLine': true,
};

const craco = {
  webpack: {
    configure: (webpackConfig) => ({
      ...webpackConfig,
      module: {
        ...webpackConfig.module,
        rules: webpackConfig.module.rules.map((rule) => {
          if (!rule.oneOf) return rule;
          return {
            ...rule,
            oneOf: rule.oneOf.map((ruleObject) => {
              if (
                !new RegExp(ruleObject.test).test('.ts') ||
                !ruleObject.include
              )
                return ruleObject;
              return { ...ruleObject, include: undefined };
            }),
          };
        }),
      },
    }),
  },
  babel: {
    sourceType: 'unambiguous',
    presets: [
      ['@babel/preset-typescript', {allowDeclareFields: true}],
      // "@babel/preset-react",
      // "@babel/preset-env",
    ],
    plugins: [
      ['@babel/plugin-proposal-private-property-in-object', { 'loose': true }],
      ['@babel/plugin-proposal-class-properties', { 'loose': true }],
    ]
  },
};

module.exports = { jslint, prettier, tslint, nodelint, craco };
