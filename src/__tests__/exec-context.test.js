/**
 * exec-context.js — AsyncLocalStorage scope for the active execution.
 *
 * The contract these tests pin down:
 *   - Without a scope, `getExecContext()` falls back to env vars (so any
 *     legacy code path that reads `process.env.EXECUTION_ID` keeps working).
 *   - Inside `runInContext({ executionId })`, the context reflects the
 *     child's id and depth is incremented.
 *   - Async/await chains preserve the scope across `await` boundaries.
 *   - Sibling scopes don't bleed: when scope A finishes, scope B (started
 *     concurrently) still sees its own values.
 *   - Top-level `withRootContext` is depth=0 even if env has noise.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getExecContext, runInContext, withRootContext } from '../exec-context.js';

const ORIG = {};
const ENV_KEYS = ['EXECUTION_ID', 'PARENT_EXECUTION_ID', 'ZIBBY_CONVERSATION_ID', 'DISPATCH_MODE'];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    ORIG[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});

describe('exec-context — env fallback', () => {
  it('returns nulls when no env and no scope', () => {
    const ctx = getExecContext();
    expect(ctx.executionId).toBe(null);
    expect(ctx.parentExecutionId).toBe(null);
    expect(ctx.depth).toBe(0);
    expect(ctx.conversationId).toBe(null);
  });

  it('falls back to env vars when no scope', () => {
    process.env.EXECUTION_ID = 'env-exec-1';
    process.env.PARENT_EXECUTION_ID = 'env-parent-1';
    process.env.ZIBBY_CONVERSATION_ID = 'env-conv-1';
    process.env.DISPATCH_MODE = 'cold';
    const ctx = getExecContext();
    expect(ctx.executionId).toBe('env-exec-1');
    expect(ctx.parentExecutionId).toBe('env-parent-1');
    expect(ctx.conversationId).toBe('env-conv-1');
    expect(ctx.dispatchMode).toBe('cold');
  });
});

describe('exec-context — scoping', () => {
  it('runInContext sets values for the call chain', async () => {
    await runInContext({ executionId: 'child-1', dispatchMode: 'inprocess' }, async () => {
      const ctx = getExecContext();
      expect(ctx.executionId).toBe('child-1');
      expect(ctx.dispatchMode).toBe('inprocess');
    });
  });

  it('depth increments for nested scopes', async () => {
    await runInContext({ executionId: 'a' }, async () => {
      expect(getExecContext().depth).toBe(1);
      await runInContext({ executionId: 'b' }, async () => {
        expect(getExecContext().depth).toBe(2);
        await runInContext({ executionId: 'c' }, async () => {
          expect(getExecContext().depth).toBe(3);
        });
      });
    });
  });

  it('depth does NOT increment when executionId is the same', async () => {
    // Useful for wrapping with extra metadata mid-run without polluting
    // the depth gauge (depth is meant to count distinct executions).
    await runInContext({ executionId: 'a' }, async () => {
      expect(getExecContext().depth).toBe(1);
      await runInContext({ executionId: 'a' }, async () => {
        expect(getExecContext().depth).toBe(1);
      });
    });
  });

  it('parentExecutionId is auto-set from the enclosing scope', async () => {
    await runInContext({ executionId: 'top' }, async () => {
      await runInContext({ executionId: 'mid' }, async () => {
        const ctx = getExecContext();
        expect(ctx.executionId).toBe('mid');
        expect(ctx.parentExecutionId).toBe('top');
        await runInContext({ executionId: 'leaf' }, async () => {
          expect(getExecContext().parentExecutionId).toBe('mid');
        });
      });
    });
  });

  it('conversationId inherits unless explicitly overridden', async () => {
    await runInContext({ executionId: 'a', conversationId: 'conv-x' }, async () => {
      await runInContext({ executionId: 'b' }, async () => {
        expect(getExecContext().conversationId).toBe('conv-x');
      });
      await runInContext({ executionId: 'c', conversationId: null }, async () => {
        expect(getExecContext().conversationId).toBe(null);
      });
    });
  });

  it('sibling scopes do not bleed', async () => {
    let leftSawAtEnd, rightSawAtEnd;
    await Promise.all([
      runInContext({ executionId: 'left' }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        leftSawAtEnd = getExecContext().executionId;
      }),
      runInContext({ executionId: 'right' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        rightSawAtEnd = getExecContext().executionId;
      }),
    ]);
    expect(leftSawAtEnd).toBe('left');
    expect(rightSawAtEnd).toBe('right');
  });

  it('after scope ends, env fallback kicks back in', async () => {
    process.env.EXECUTION_ID = 'env-baseline';
    await runInContext({ executionId: 'scoped' }, async () => {
      expect(getExecContext().executionId).toBe('scoped');
    });
    expect(getExecContext().executionId).toBe('env-baseline');
  });
});

describe('exec-context — withRootContext', () => {
  it('starts at depth=0 regardless of nesting outside', () => {
    let depth;
    withRootContext({ executionId: 'root-1', dispatchMode: 'cold' }, () => {
      depth = getExecContext().depth;
    });
    expect(depth).toBe(0);
  });

  it('defaults dispatchMode=cold when not given', () => {
    let mode;
    withRootContext({ executionId: 'root-1' }, () => {
      mode = getExecContext().dispatchMode;
    });
    expect(mode).toBe('cold');
  });
});
