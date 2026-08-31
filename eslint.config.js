const js = require('@eslint/js');

/**
 * Three environments live in this repo and they do not share globals:
 * Node (src, scripts), Jest (tests), and the browser (public/js). One flat
 * block covering all three meant `npm run lint` reported ~180 no-undef errors
 * for globals that genuinely exist at runtime, which buried the handful of real
 * findings and made the gate not worth running.
 */
module.exports = [
  {
    // Not project source. `.claude/worktrees/` holds abandoned checkouts with
    // stale copies of files since deleted from the repo, and graphify-out/ is a
    // generated artifact — linting either reports on code nobody maintains.
    ignores: ['.claude/**', 'graphify-out/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        console: 'readonly',
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      // `^_` already marked "deliberately unused" for args; the codebase uses the
      // same convention for destructured discards (`_omit`, `_discard`) and
      // caught-but-ignored errors, so honour it in all three positions.
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    // Jest injects these; nothing declares them.
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        jest: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
        setImmediate: 'readonly',
      },
    },
  },
  {
    // Plain browser scripts: IIFEs on window, no bundler, no module system.
    // `marked` is the CDN markdown renderer dashboard.html loads.
    files: ['public/js/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        crypto: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        requestAnimationFrame: 'readonly',
        AbortController: 'readonly',
        TextDecoder: 'readonly',
        marked: 'readonly',
      },
    },
  },
];
