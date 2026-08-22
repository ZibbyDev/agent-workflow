/**
 * Level discipline for engine diagnostics.
 *
 * `packages/cli` now installs a real logger into the engine (every
 * agent-workflow copy in a run bundle), so `logger.info` is no longer a
 * no-op: it reaches stdout, the per-node progress middleware captures it
 * into `nodes[].logs`, and the middleware re-ships the WHOLE buffer on
 * every 500ms flush. That makes info a metered channel — a large payload
 * logged there is paid for repeatedly, per node, for the life of the run.
 *
 * Two rules, both encoded below:
 *
 *   1. NO `logger.info` may carry a JSON.stringify payload. Two did —
 *      node.ts's "output validated" and "parsed output" dumps, each
 *      printing the node's ENTIRE output as pretty JSON, duplicating what
 *      the agent already streamed on stdout and what is written to
 *      <sessionPath>/<node>/raw_stream_output.txt. Both are now `debug`.
 *      This test is what stops a third one appearing.
 *
 *   2. The sub-graph dispatch-path lines MUST stay at info. They are the
 *      whole reason info was turned on: before it, a run log could not
 *      say whether a sub-graph ran in-process or fell back to HTTP, and
 *      establishing it needed shell access to the box plus a DynamoDB
 *      query. Demoting one of them would silently undo that.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|js)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Every `logger.<level>(...)` call in src, with its file + line. */
function loggerCalls() {
  const calls: { file: string; line: number; level: string; text: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((text, i) => {
      const m = text.match(/logger\.(debug|info|warn|error)\(/);
      if (m) calls.push({ file: file.slice(SRC.length + 1), line: i + 1, level: m[1], text: text.trim() });
    });
  }
  return calls;
}

describe('engine logger level discipline', () => {
  const calls = loggerCalls();

  it('the scanner actually finds logger calls (probe)', () => {
    // A source scan that matches nothing would make every "no violations"
    // assertion below vacuously true.
    expect(calls.length).toBeGreaterThan(20);
    expect(calls.some(c => c.level === 'info')).toBe(true);
    expect(calls.some(c => c.level === 'debug')).toBe(true);
    expect(calls.some(c => c.file === 'node.ts')).toBe(true);
  });

  it('no logger.info dumps a JSON.stringify payload', () => {
    const offenders = calls
      .filter(c => c.level === 'info' && c.text.includes('JSON.stringify'))
      .map(c => `${c.file}:${c.line}  ${c.text}`);
    expect(offenders, 'logger.info must not carry a JSON.stringify payload — '
      + 'info is captured into nodes[].logs and re-shipped on every 500ms '
      + 'progress flush. Use logger.debug for bulk dumps.').toEqual([]);
  });

  it('the node output dumps are at debug, not info', () => {
    const nodeCalls = calls.filter(c => c.file === 'node.ts');
    const validated = nodeCalls.find(c => c.text.includes('output validated:'));
    const parsed = nodeCalls.find(c => c.text.includes('parsed output:'));
    expect(validated, 'the "output validated" dump vanished — if it moved, move this guard').toBeTruthy();
    expect(parsed, 'the "parsed output" dump vanished — if it moved, move this guard').toBeTruthy();
    expect(validated!.level).toBe('debug');
    expect(parsed!.level).toBe('debug');
  });

  it('the sub-graph dispatch-path lines stay at info (the acceptance guarantee)', () => {
    const sg = calls.filter(c => c.file === 'sub-graph-executor.ts');
    const mustBeInfo = ['completed in-process', 'in-process fallback for', 'dispatching '];
    for (const needle of mustBeInfo) {
      const hit = sg.find(c => c.text.includes(needle));
      expect(hit, `sub-graph line "${needle}" is gone — a run log can no longer name the dispatch path`).toBeTruthy();
      expect(hit!.level, `"${needle}" must stay at info: it is how a run log names the dispatch path without docker logs`).toBe('info');
    }
  });
});
