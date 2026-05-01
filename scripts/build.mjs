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
import { join, extname } from 'path';

const cwd = process.cwd();

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
      extname(item.name) === '.js' &&
      !item.name.includes('.test.') &&
      !item.name.includes('.spec.')
    ) {
      entries.push(full);
    }
  }
  return entries;
}

await rm(join(cwd, 'dist'), { recursive: true, force: true });
await mkdir(join(cwd, 'dist'), { recursive: true });

const entryPoints = await collectSourceFiles(join(cwd, 'src'));
if (entryPoints.length === 0) {
  console.log('No source files found. Skipping build.');
  process.exit(0);
}

await build({
  entryPoints,
  outdir: join(cwd, 'dist'),
  outbase: join(cwd, 'src'),
  format: 'esm',
  platform: 'node',
  target: 'node18',
  bundle: true,
  minify: true,
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

console.log(`Built ${entryPoints.length} files → dist/ (esm, minified)`);
