# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript ESM Node project. Core exports start at `src/index.ts`. CLI logic lives in `src/cli`, with executable wrappers in `bin/` that load built files from `dist/`. Download behavior is in `src/downloaders`, parsing in `src/parsers`, domain models in `src/entities`, and shared helpers in `src/utils`. Browse/server code is under `src/browse`: API and DB mixins, Express handlers, and the Vite React UI in `src/browse/web`. Docs and examples live in `docs/`, `README.md`, `example.conf`, and `example-embed.conf`.

## Build, Test, and Development Commands

Use Node.js `>=20.19.0`.

- `npm ci`: install dependencies exactly from `package-lock.json`.
- `npm run lint`: run ESLint over `src`.
- `npm run lint:fix`: apply safe lint fixes.
- `npm run build:core`: clean `dist/` and compile TypeScript declarations and JS.
- `npm run build:web`: build the Vite React browse UI into `dist/browse/web`.
- `npm run build`: run both core and web builds; this is the CI build gate.
- `npm run doc`: generate TypeDoc documentation.

After building, use `node bin/patreon-dl.js -h` or `node bin/patreon-dl-server.js -h` for CLI smoke checks.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, semicolons, ESM imports with `.js` extensions for local TypeScript modules, and type-only imports where required. Use `PascalCase` for classes, React components, entity files, and mixins such as `CampaignAPIMixin.ts`. Use descriptive helper names in `camelCase`. Do not add broad lint relaxations without a narrow reason.

## Testing Guidelines

There is currently no automated test suite or `npm test` script. Treat `npm run lint` and `npm run build` as mandatory verification. For downloader or CLI behavior, add targeted manual checks using safe public/help commands first, then document any network-dependent verification in the PR. If adding tests, use a clear `test/` or colocated `*.test.ts` structure and add the npm script.

## Commit & Pull Request Guidelines

Recent history uses release commits like `v3.8.1`, prefixes such as `fix:` and `chore:`, and concise feature subjects, sometimes with PR numbers. Prefer focused commits such as `fix: handle missing media URL`. PRs should summarize behavior changes, list validation commands, link issues, and include screenshots only for `src/browse/web` UI changes.

## Security & Configuration Notes

Do not commit cookies, Patreon credentials, YouTube credentials, downloaded content, or local config files. Keep examples generic and update `example.conf` only when documenting supported options.
