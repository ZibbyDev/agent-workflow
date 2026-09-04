/**
 * Timeline UI — progressive CLI output with vertical-line connectors.
 *
 * When inside a node, ALL console output is automatically prefixed with │
 * and soft-wrapped at terminal width so the pipe stays visible on every
 * visual line, even when text wraps.
 *
 * Milestone dots (◆) sit ON the line, replacing │ at that point.
 *
 * ── Public protocol contract ──────────────────────────────────────────────
 * `timeline.nodeStart` / `nodeComplete` / `nodeFailed` emit machine-readable
 * lines on stdout prefixed with WORKFLOW_GRAPH_LOG_MARKER_PREFIX. External
 * consumers parse these lines to track node lifecycle:
 *   - `studio/src/utils/studioRunStreamLog.js` (Studio's run progress UI)
 *   - `packages/skills/src/test-runner.js` (test runner's per-node tracking)
 *
 * If you change the marker prefix or payload shape, you must update both
 * consumers in the same change. Markers are emitted only when a host opts
 * in via ZIBBY_EMIT_GRAPH_MARKERS=1 (or the legacy alias
 * ZIBBY_WORKFLOW_GRAPH_LOG_MARKERS=1), to keep regular CLI output clean.
 */

import chalk from 'chalk';

/**
 * Prefix for machine-readable stdout lines that bound graph-node execution.
 * Plain text (no styling) so external tools can split logs by node.
 * Line format: `${WORKFLOW_GRAPH_LOG_MARKER_PREFIX}${JSON.stringify(payload)}\n`
 * Payload: `{ phase: 'node_begin'|'node_end', node: string }`
 */
export const WORKFLOW_GRAPH_LOG_MARKER_PREFIX = '__WORKFLOW_GRAPH_LOG__';

const PIPE = chalk.gray('│');
const PIPE_START = chalk.gray('┌');
const PIPE_END = chalk.gray('└');
const DOT = chalk.green('◆');
const DOT_TOOL = chalk.hex('#c084fc')('◆');
const DOT_MEMORY = chalk.hex('#2dd4bf')('◆');
const DOT_FAIL = chalk.red('◆');

const PIPE_PREFIX = `${PIPE} `;
const PIPE_VISUAL_WIDTH = 2;

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function makeWrapWriter(orig, state) {
  return (chunk, encoding, callback) => {
    if (typeof chunk !== 'string') {
      return orig(chunk, encoding, callback);
    }

    const cols = process.stdout.columns || 120;
    let out = '';

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];

      if (state.lineStart) {
        out += PIPE_PREFIX;
        state.col = PIPE_VISUAL_WIDTH;
        state.lineStart = false;
      }

      if (ch === '\n') {
        out += ch;
        state.lineStart = true;
        state.col = 0;
        state.inEsc = false;
      } else if (ch === '\x1b') {
        state.inEsc = true;
        out += ch;
      } else if (state.inEsc) {
        out += ch;
        if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
          state.inEsc = false;
        }
      } else {
        state.col++;
        out += ch;
        if (state.col >= cols) {
          out += `\n${  PIPE_PREFIX}`;
          state.col = PIPE_VISUAL_WIDTH;
        }
      }
    }

    return orig(out, encoding, callback);
  };
}

class Timeline {
  _currentNode?: any;
  _emitWorkflowGraphMarkers?: any;
  _errState?: any;
  _origStderrWrite?: any;
  _origStdoutWrite?: any;
  _outState?: any;
  _prevStdoutWrite?: any;
  _prevStderrWrite?: any;
  constructor() {
    this._currentNode = null;
    this._origStdoutWrite = null;
    this._origStderrWrite = null;
    // Machine-readable node-lifecycle markers (consumed by the test runner
    // and any host that wants structured run-progress events). Off by
    // default so plain CLI runs stay clean; opt in with either env var.
    this._emitWorkflowGraphMarkers =
      String(process.env.ZIBBY_EMIT_GRAPH_MARKERS || '').trim() === '1' ||
      String(process.env.ZIBBY_WORKFLOW_GRAPH_LOG_MARKERS || '').trim() === '1';
  }

  get isInsideNode() {
    return this._currentNode !== null;
  }

  _startIntercepting() {
    // Keep the EXACT previous writers to put back (identity, not a bound copy):
    // the leak test pins `process.stdout.write` back to the very function it
    // was, and a host that installed its own tee (the self-host runtime's
    // turn-log capture) gets its own function back, not a wrapper of it.
    this._prevStdoutWrite = process.stdout.write;
    this._prevStderrWrite = process.stderr.write;
    this._origStdoutWrite = process.stdout.write.bind(process.stdout);
    this._origStderrWrite = process.stderr.write.bind(process.stderr);

    const outState: any = { lineStart: true, col: 0, inEsc: false };
    const errState: any = { lineStart: true, col: 0, inEsc: false };
    this._outState = outState;
    this._errState = errState;

    process.stdout.write = makeWrapWriter(this._origStdoutWrite, outState) as any;
    process.stderr.write = makeWrapWriter(this._origStderrWrite, errState) as any;
  }

  _stopIntercepting() {
    if (this._origStdoutWrite) {
      if (this._outState && !this._outState.lineStart) {
        this._origStdoutWrite('\n');
      }
      process.stdout.write = this._prevStdoutWrite || this._origStdoutWrite;
    }
    if (this._origStderrWrite) {
      if (this._errState && !this._errState.lineStart) {
        this._origStderrWrite('\n');
      }
      process.stderr.write = this._prevStderrWrite || this._origStderrWrite;
    }
    this._origStdoutWrite = null;
    this._origStderrWrite = null;
    this._prevStdoutWrite = null;
    this._prevStderrWrite = null;
  }

  _rawWrite(msg) {
    const write = this._origStdoutWrite || process.stdout.write.bind(process.stdout);
    write(`${msg  }\n`);
  }

  /** Emit a single-line graph log marker (never chalk). */
  _emitGraphLogMarker(payload) {
    if (!this._emitWorkflowGraphMarkers) return;
    const line = `${WORKFLOW_GRAPH_LOG_MARKER_PREFIX}${JSON.stringify(payload)}\n`;
    if (this._origStdoutWrite) {
      this._origStdoutWrite(line);
    } else {
      process.stdout.write(line);
    }
  }

  /**
   * Write a milestone dot ON the line. If interceptor is active and we're
   * mid-line, finish that line first so the dot starts on a fresh line.
   */
  _writeDot(dot, message) {
    if (this._origStdoutWrite) {
      if (this._outState && !this._outState.lineStart) {
        this._origStdoutWrite('\n');
        this._outState.lineStart = true;
        this._outState.col = 0;
      }
      this._origStdoutWrite(`${dot} ${message}\n`);
    } else {
      const write = process.stdout.write.bind(process.stdout);
      write(`${dot} ${message}\n`);
    }
  }

  /**
   * Milestone dot ON the line (inside a node) or with pipe prefix (outside).
   */
  step(message) {
    if (this._origStdoutWrite) {
      this._writeDot(DOT, message);
    } else {
      const write = process.stdout.write.bind(process.stdout);
      write(`${PIPE}  ${DOT} ${message}\n`);
    }
  }

  /** Lighter-weight informational step (no special styling). */
  stepInfo(message) {
    this.step(message);
  }

  stepTool(message) {
    if (this._origStdoutWrite) {
      this._writeDot(DOT_TOOL, message);
    } else {
      const write = process.stdout.write.bind(process.stdout);
      write(`${PIPE}  ${DOT_TOOL} ${message}\n`);
    }
  }

  stepMemory(message) {
    const colored = chalk.hex('#2dd4bf')(message);
    if (this._origStdoutWrite) {
      this._writeDot(DOT_MEMORY, colored);
    } else {
      const write = process.stdout.write.bind(process.stdout);
      write(`${PIPE}  ${DOT_MEMORY} ${colored}\n`);
    }
  }

  stepFail(message) {
    if (this._origStdoutWrite) {
      this._writeDot(DOT_FAIL, chalk.red(message));
    } else {
      const write = process.stdout.write.bind(process.stdout);
      write(`${PIPE}  ${DOT_FAIL} ${chalk.red(message)}\n`);
    }
  }

  nodeStart(name) {
    // ONE interceptor at a time — and a node that starts while the previous
    // one's interceptor is still installed has found a leak, not a nesting.
    // `_startIntercepting` saves whatever `process.stdout.write` currently is
    // as "original"; if that is already our wrapper, every later restore only
    // ever gets back to the wrapper, and the process prints `│ │ ` (then
    // `│ │ │ `) in front of every line for the rest of its life. The engine
    // never runs two nodes at once, so the only way here is a node that ended
    // without nodeComplete/nodeFailed/nodeStopped — say so, and unwrap first.
    if (this._origStdoutWrite || this._origStderrWrite) {
      // eslint-disable-next-line no-console
      console.warn(`[timeline] node '${name}' started while '${this._currentNode || '?'}' still had the stdout interceptor installed — a node ended without closing its box; unwrapping`);
      this._stopIntercepting();
    }
    this._currentNode = name;
    this._emitGraphLogMarker({ phase: 'node_begin', node: name });
    this._rawWrite(`${PIPE_START} ${name}`);
    this._startIntercepting();
  }

  nodeComplete(name, opts: any = {}) {
    this._stopIntercepting();
    this._currentNode = null;
    const { duration, details } = opts;
    if (details) {
      for (const d of details) {
        this._rawWrite(`${DOT} ${d}`);
      }
    }
    const durationStr = duration ? chalk.dim(` ${formatDuration(duration)}`) : '';
    this._rawWrite(`${PIPE_END} ${chalk.green('done')}${durationStr}`);
    this._emitGraphLogMarker({ phase: 'node_end', node: name });
    this._rawWrite('');
  }

  nodeFailed(name, error, opts: any = {}) {
    this._stopIntercepting();
    this._currentNode = null;
    const { duration } = opts;
    const durationStr = duration ? chalk.dim(` ${formatDuration(duration)}`) : '';
    this._rawWrite(`${DOT_FAIL} ${chalk.red(error)}`);
    this._rawWrite(`${PIPE_END} ${chalk.red('failed')}${durationStr}`);
    this._emitGraphLogMarker({ phase: 'node_end', node: name });
    this._rawWrite('');
  }

  /**
   * The node was cut short by a deliberate stop (external abort / stop file).
   * Not a failure — no red line — but the box MUST still close: this is the
   * third way out of a node, and the one that used to leave the stdout
   * interceptor installed (see nodeStart).
   */
  nodeStopped(name, opts: any = {}) {
    this._stopIntercepting();
    this._currentNode = null;
    const { duration } = opts;
    const durationStr = duration ? chalk.dim(` ${formatDuration(duration)}`) : '';
    this._rawWrite(`${PIPE_END} ${chalk.dim('stopped')}${durationStr}`);
    this._emitGraphLogMarker({ phase: 'node_end', node: name });
    this._rawWrite('');
  }

  route(from, to) {
    this._rawWrite(chalk.dim(`  ${from} → ${to}`));
    this._rawWrite('');
  }

  graphComplete() {
    // No-op. Callers (CLI run-local/run, cloud trigger handler) print
    // their own slug+timing summary after graph.run() returns; emitting
    // a generic "✓ Workflow completed" here just doubled it.
  }
}

export const timeline = new Timeline();
export { Timeline };
export default timeline;
