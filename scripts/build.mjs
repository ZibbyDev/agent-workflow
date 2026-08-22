#!/usr/bin/env node
/**
 * Minimal esbuild build for @zibby/agent-workflow.
 *
 * Walks src/, emits one bundled .js per source file to dist/, externalising
 * runtime deps so consumers' node_modules wins. Types are emitted in a
 * separate `tsc` step (see package.json `build` script).
 */
import { build } from 'esbuild';
import { readdir, rm, mkdir } from 'fs/promises';
import { join, extname, isAbsolute } from 'path';

const cwd = process.cwd();

// Where to emit. Defaults to `<cwd>/dist` — the ONLY value any build script,
// Dockerfile or publish path uses. The override exists so a test can build the
// real artifacts into a throwaway directory and assert on them without
// racing (or destroying, note the rm -rf below) the shared dist/ that other
// sessions in this tree may be running against. Brand-neutral by rule.
const outDir = process.env.DIST_OUT
  ? (isAbsolute(process.env.DIST_OUT) ? process.env.DIST_OUT : join(cwd, process.env.DIST_OUT))
  : join(cwd, 'dist');

async function collectSourceFiles(dir) {
  const entries = [];
  let items;
  try { items = await readdir(dir, { withFileTypes: true }); } catch { return entries; }
  for (const item of items) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === '__tests__' || item.name === 'node_modules') continue;
      entries.push(...(await collectSourceFiles(full)));
    } else if (
      item.isFile() &&
      (extname(item.name) === '.ts' || extname(item.name) === '.js') &&
      !item.name.endsWith('.d.ts') &&
      !item.name.includes('.test.') &&
      !item.name.includes('.spec.')
    ) {
      entries.push(full);
    }
  }
  return entries;
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const entryPoints = await collectSourceFiles(join(cwd, 'src'));
if (entryPoints.length === 0) {
  console.log('No source files found. Skipping build.');
  process.exit(0);
}

await build({
  entryPoints,
  outdir: outDir,
  outbase: join(cwd, 'src'),
  format: 'esm',
  platform: 'node',
  target: 'node18',
  // esbuild reads the project tsconfig.json (useDefineForClassFields:false) per
  // input, so a bare `x?: any;` class-field declaration the TS migration added
  // emits ZERO runtime code (no `this.x = void 0`) — dist/*.js stays behaviorally
  // identical to the pre-migration JS.
  bundle: true,
  minify: !process.env.NO_MINIFY,
  sourcemap: false,
  logLevel: 'warning',
  external: [
    // Node built-ins (any subpath like node:fs/promises)
    'node:*',
    'fs', 'path', 'os', 'url', 'util', 'crypto',
    'stream', 'events', 'buffer', 'child_process',
    'http', 'https', 'zlib',
    // @zibby/* — graph.js does an optional `import('@zibby/skills')` for skill
    // auto-registration. Don't bundle anything from the @zibby scope.
    '@zibby/*',
    // Runtime deps — keep external so consumer's node_modules supplies them
    'chalk',
    'dotenv',
    'handlebars',
    'zod',
    'zod-to-json-schema',
  ],
});

console.log(`Built ${entryPoints.length} files → ${outDir} (esm, minified)`);
