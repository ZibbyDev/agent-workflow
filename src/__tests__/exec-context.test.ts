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
import { getExecContext, runInContext, withRootContext, withAgentContext } from '../exec-context.js';

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

describe('exec-context — agent/signal (withAgentContext)', () => {
  it('getExecContext exposes null agent/signal with no scope', () => {
    const ctx = getExecContext();
    expect(ctx.agent).toBe(null);
    expect(ctx.signal).toBe(null);
  });

  it('withAgentContext publishes agent + signal without bumping depth or changing ids', async () => {
    const agent = { id: 'parent-agent' };
    const signal = new AbortController().signal;
    await runInContext({ executionId: 'exec-1' }, async () => {
      expect(getExecContext().depth).toBe(1);
      await withAgentContext(agent, signal, async () => {
        const ctx = getExecContext();
        expect(ctx.agent).toBe(agent);
        expect(ctx.signal).toBe(signal);
        // identity/lineage preserved — only agent/signal were added.
        expect(ctx.executionId).toBe('exec-1');
        expect(ctx.depth).toBe(1);
      });
    });
  });

  it('a nested runInContext child INHERITS the parent agent/signal', async () => {
    const agent = { id: 'a' };
    const signal = new AbortController().signal;
    await withAgentContext(agent, signal, async () => {
      // e.g. an in-process child scope minted mid-run
      await runInContext({ executionId: 'child' }, async () => {
        const ctx = getExecContext();
        expect(ctx.agent).toBe(agent);
        expect(ctx.signal).toBe(signal);
      });
    });
  });

  it('withAgentContext(null, null) keeps the inherited agent/signal', async () => {
    const agent = { id: 'keep' };
    await withAgentContext(agent, null, async () => {
      await withAgentContext(null, null, async () => {
        expect(getExecContext().agent).toBe(agent);
      });
    });
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

// ── WHICH NODE THIS RUN IS ON ────────────────────────────────────────────────
// `parentExecutionId` says WHICH RUN started a child; `nodeId` says WHICH LINE
// it went out on. Without it, a graph that starts the same member from two
// nodes (magnum → Product Owner, from "Hand off the PRD" AND from "Project
// Manager") cannot tell which of the two tiles a run belongs to — one run lit
// both (founder, 2026-09-16). The engine publishes it around every node's
// execute(); dispatchSubgraph reads it and the backend records it as
// `parentNodeId`.
describe('exec-context — nodeId, the line a dispatch leaves by', () => {
  it('is published by the per-node scope and read back verbatim', async () => {
    let seen;
    await withAgentContext(null, null, async () => { seen = getExecContext().nodeId; }, 'Hand off the PRD');
    expect(seen).toBe('Hand off the PRD');
  });

  it('is null when nobody published one — never guessed from env', () => {
    process.env.EXECUTION_ID = 'e1';
    expect(getExecContext().nodeId).toBeNull();
    withRootContext({ executionId: 'root' }, () => {
      // The root scope is entered before the first node starts.
      expect(getExecContext().nodeId).toBeNull();
    });
  });

  it('an omitted nodeId keeps the surrounding one; an empty one clears it', async () => {
    await withAgentContext(null, null, async () => {
      await withAgentContext(null, null, async () => {
        expect(getExecContext().nodeId).toBe('outer');      // agent/signal-only publish
      });
      await withAgentContext(null, null, async () => {
        expect(getExecContext().nodeId).toBeNull();
      }, '');
    }, 'outer');
  });

  it('A CHILD RUN DOES NOT INHERIT ITS PARENT`S NODE', async () => {
    // Otherwise every dispatch the child itself makes would claim the PARENT's
    // node as its origin — the parent's line would light for work that never
    // travelled it. The child's own engine republishes its own node.
    await withAgentContext(null, null, async () => {
      await runInContext({ executionId: 'child-1' }, async () => {
        expect(getExecContext().nodeId).toBeNull();
        await withAgentContext(null, null, async () => {
          expect(getExecContext().nodeId).toBe('child-node');
        }, 'child-node');
      });
      // …and the parent scope is untouched by the child having run.
      expect(getExecContext().nodeId).toBe('parent-node');
    }, 'parent-node');
  });

  it('a scope that keeps the SAME executionId keeps the node (it is the same run)', async () => {
    await withRootContext({ executionId: 'same' }, async () => {
      await withAgentContext(null, null, async () => {
        // Not a new run — depth does not move, and neither does the node.
        await runInContext({ executionId: 'same' }, () => {
          expect(getExecContext().nodeId).toBe('n1');
        });
      }, 'n1');
    });
  });
});
