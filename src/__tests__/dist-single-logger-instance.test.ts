/**
 * ARTIFACT-level tripwire for the `dist/logger.js` trap.
 *
 * `scripts/build.mjs` builds EVERY src file as its own esbuild bundle
 * (entryPoints = all of src/, `bundle: true`). That is deliberate and
 * load-bearing — `selfhosted/control-plane/Dockerfile` greps every
 * `@zibby/agent-workflow/dist/graph.js` it can find for a minify-proof
 * marker and hard-fails the image build when none is found, so "just
 * stop emitting the duplicates" is NOT an available fix.
 *
 * The consequence is that this package ships N physical copies of every
 * module's code. Anything with mutable module state must therefore be
 * anchored on globalThis, or a caller who reaches a different dist file
 * silently talks to dead state. The registries already do this; the
 * logger did not, and importing `dist/logger.js` got you a logger that
 * `setLogger()` could never reach — no error, just silence.
 *
 * The source-level twin of this test (logger-cross-instance.test.ts)
 * cannot catch a BUILD regression, because src is one file either way.
 * So this one builds the REAL artifacts with the REAL build script (into
 * a throwaway dir, via DIST_OUT, so it never races the shared dist/ that
 * other sessions may be running against) and asserts on those.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, rmSync, readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Inside node_modules so it is gitignored, never packed, and bare-specifier
// resolution from the built files still walks up to <pkg>/node_modules.
const OUT = join(PKG_ROOT, 'node_modules', `.dist-logger-tripwire-${process.pid}`);

beforeAll(() => {
  execFileSync(process.execPath, [join(PKG_ROOT, 'scripts', 'build.mjs')], {
    cwd: PKG_ROOT,
    env: { ...process.env, DIST_OUT: OUT },
    stdio: 'pipe',
  });
});

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

describe('freshly built dist artifacts share ONE logger state', () => {
  it('emits both dist/index.js and dist/logger.js as separate bundles', () => {
    // Not an aspiration — the self-host image build depends on the per-file
    // emit existing. If this ever stops being true, the fix below stops
    // being necessary AND that Dockerfile assert breaks; either way a human
    // must look.
    expect(existsSync(join(OUT, 'index.js'))).toBe(true);
    expect(existsSync(join(OUT, 'logger.js'))).toBe(true);
    expect(existsSync(join(OUT, 'graph.js'))).toBe(true);
  });

  it('inlines the logger into both bundles (i.e. they are genuinely distinct copies)', () => {
    // The marker is the default warn prefix, which survives minification as
    // a string literal. Its presence in BOTH files is what makes the
    // globalThis anchoring necessary rather than decorative.
    const idx = readFileSync(join(OUT, 'index.js'), 'utf-8');
    const lg = readFileSync(join(OUT, 'logger.js'), 'utf-8');
    expect(idx).toContain('[workflow]');
    expect(lg).toContain('[workflow]');
    expect(idx).not.toBe(lg);
  });

  it('setLogger() through the package entry reaches a logger taken from dist/logger.js', async () => {
    delete globalThis[Symbol.for('@zibby/agent-workflow.logger')];

    const idx = await import(pathToFileURL(join(OUT, 'index.js')).href);
    const lg = await import(pathToFileURL(join(OUT, 'logger.js')).href);
    expect(idx).not.toBe(lg);

    // Probe FIRST: prove the standalone logger object is live at all, by
    // observing the default warn it is supposed to emit. Without this, a
    // passing assertion below could not be distinguished from an inert stub.
    let warned = 0;
    const realWarn = console.warn;
    console.warn = () => { warned++; };
    try { lg.logger.warn('probe'); } finally { console.warn = realWarn; }
    expect(warned).toBe(1);

    const seen: string[] = [];
    idx.setLogger({ info: (m) => seen.push(m) });

    lg.logger.info('FROM-STANDALONE-DIST-LOGGER');
    expect(seen).toEqual(['FROM-STANDALONE-DIST-LOGGER']);
  });

  it('and the reverse: a reset through the entry bundle silences the standalone logger', async () => {
    delete globalThis[Symbol.for('@zibby/agent-workflow.logger')];

    const idx = await import(pathToFileURL(join(OUT, 'index.js')).href);
    const lg = await import(pathToFileURL(join(OUT, 'logger.js')).href);
    // The entry bundle does not re-export `logger` (only `setLogger`), so
    // the reverse direction is proven by having the ENTRY write the state
    // and the STANDALONE read it.
    expect(idx.logger).toBeUndefined();

    const seen: string[] = [];
    lg.setLogger({ info: (m) => seen.push(m) });
    lg.logger.info('installed');
    expect(seen).toEqual(['installed']);   // probe: the sink is wired

    idx.setLogger({});                     // `{}` merges over the defaults → info = noop
    lg.logger.info('should-be-silent');
    expect(seen).toEqual(['installed']);   // no growth ⇒ idx wrote the state lg reads
  });
});
