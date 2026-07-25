/**
 * Runtime initial-state validation must work for BOTH input-schema shapes:
 *
 *   - z.object input  → composed with the context schema via `.merge` (the
 *     original behaviour; a flat object exposes `.merge`).
 *   - z.discriminatedUnion / z.union input → has NO `.merge` (a union exposes
 *     `.options`, `_def.type === 'union'`). It must instead be composed via
 *     `z.intersection(input, context)` (`inputSchema.and(contextSchema)`) so
 *     the payload is validated against the matched union VARIANT *and* the
 *     context object — per-variant required fields are enforced, and context
 *     defaults still apply to the parsed result.
 *
 * Before the fix, `_runtimeSchema()` unconditionally called
 * `this.inputSchema.merge(...)`. For a discriminated union `.merge` is
 * undefined → it threw → composition fell through to the (usually absent)
 * legacy `stateSchema`, so a union input's runtime validation was SKIPPED
 * entirely. This pins down that unions are now validated, the object path is
 * unchanged, and a non-schema/throwing input falls back gracefully.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { WorkflowGraph } from '../graph.js';

// ── A faithful replica of sentry-triage's input schema (the real shape that
//    exposed the bug): a discriminated union on `trigger`, where the `fix`
//    variant REQUIRES `instruction` and the `triage` variant does not. ──────
const triageVariant = z.object({
  trigger: z.literal('triage'),
  sinceMinutes: z.number().default(60),
});
const fixVariant = z.object({
  trigger: z.literal('fix'),
  instruction: z.string().min(1), // REQUIRED only on the fix path
  issueId: z.string().optional(),
});
const unionInputSchema = z.discriminatedUnion('trigger', [triageVariant, fixVariant]);

// A context (base-state) object with a default we can assert flows through.
const contextSchema = z.object({
  workspace: z.string().optional(),
  agentType: z.string().default('cursor'),
});

function makeGraph() {
  return new WorkflowGraph({ name: 'runtime-schema-union-test' });
}

describe('_runtimeSchema() — discriminated-union input', () => {
  it('composes union + context into a single validating schema', () => {
    const g = makeGraph().setInputSchema(unionInputSchema).setContextSchema(contextSchema);
    const schema = g._runtimeSchema();
    expect(schema).toBeTruthy();
    // Must NOT silently fall back to the legacy stateSchema (which is null here).
    expect(schema).not.toBe(null);
    expect(typeof schema.safeParse).toBe('function');
  });

  it('VALIDATES the matched union variant — valid triage passes', () => {
    const g = makeGraph().setInputSchema(unionInputSchema).setContextSchema(contextSchema);
    const r = g._runtimeSchema().safeParse({ trigger: 'triage' });
    expect(r.success).toBe(true);
  });

  it('VALIDATES the matched union variant — valid fix passes', () => {
    const g = makeGraph().setInputSchema(unionInputSchema).setContextSchema(contextSchema);
    const r = g._runtimeSchema().safeParse({ trigger: 'fix', instruction: 'fix issue ABC-1' });
    expect(r.success).toBe(true);
  });

  it('REJECTS a fix payload missing the variant-required `instruction`', () => {
    const g = makeGraph().setInputSchema(unionInputSchema).setContextSchema(contextSchema);
    const r = g._runtimeSchema().safeParse({ trigger: 'fix' });
    expect(r.success).toBe(false);
    const paths = r.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('instruction');
  });

  it('REJECTS an unknown discriminator value', () => {
    const g = makeGraph().setInputSchema(unionInputSchema).setContextSchema(contextSchema);
    const r = g._runtimeSchema().safeParse({ trigger: 'nope' });
    expect(r.success).toBe(false);
  });

  it('applies the CONTEXT (base-state) defaults in the parsed result', () => {
    const g = makeGraph().setInputSchema(unionInputSchema).setContextSchema(contextSchema);
    const r = g._runtimeSchema().safeParse({ trigger: 'triage' });
    expect(r.success).toBe(true);
    // Context default flows through…
    expect(r.data.agentType).toBe('cursor');
    // …and the variant's own default too.
    expect(r.data.sinceMinutes).toBe(60);
  });

  it('end-to-end: graph.run() REJECTS an invalid union payload', async () => {
    let executed = false;
    const g = makeGraph().setInputSchema(unionInputSchema).setContextSchema(contextSchema);
    g.addNode('probe', { _isCustomCode: true, execute: async () => { executed = true; return { ok: true }; } });
    g.setEntryPoint('probe');
    const fakeAgent = { name: 'fake', async run() { return { raw: '{}', structured: {} }; } };

    // fix variant WITHOUT instruction → must throw before the node runs.
    await expect(g.run(fakeAgent, { trigger: 'fix' })).rejects.toThrow(/State validation failed/i);
    expect(executed).toBe(false);
  });

  it('end-to-end: graph.run() ACCEPTS a valid union payload', async () => {
    let executed = false;
    const g = makeGraph().setInputSchema(unionInputSchema).setContextSchema(contextSchema);
    g.addNode('probe', { _isCustomCode: true, execute: async () => { executed = true; return { ok: true }; } });
    g.setEntryPoint('probe');
    const fakeAgent = { name: 'fake', async run() { return { raw: '{}', structured: {} }; } };

    await g.run(fakeAgent, { trigger: 'triage' });
    expect(executed).toBe(true);
  });
});

describe('_runtimeSchema() — z.object input (regression: original path unchanged)', () => {
  const objInput = z.object({ specPath: z.string(), label: z.string().optional() });
  const objCtx = z.object({ workspace: z.string().optional(), agentType: z.string().default('cursor') });

  it('still composes via .merge into a validating object schema', () => {
    const g = makeGraph().setInputSchema(objInput).setContextSchema(objCtx);
    const schema = g._runtimeSchema();
    expect(typeof schema.safeParse).toBe('function');
    const ok = schema.safeParse({ specPath: '/x', workspace: '/w' });
    expect(ok.success).toBe(true);
    expect(ok.data.agentType).toBe('cursor'); // context default applied
  });

  it('rejects when a required object field is missing', () => {
    const g = makeGraph().setInputSchema(objInput).setContextSchema(objCtx);
    const r = g._runtimeSchema().safeParse({ workspace: '/w' }); // no specPath
    expect(r.success).toBe(false);
  });

  it('input-only (no context) returns the bare input schema', () => {
    const g = makeGraph().setInputSchema(objInput);
    expect(g._runtimeSchema()).toBe(objInput);
  });
});

describe('_runtimeSchema() — graceful fallback (tolerant)', () => {
  it('a non-zod input that lacks .merge AND .and falls back to stateSchema, no throw', () => {
    const legacyState = z.object({ foo: z.string() });
    const bogusInput = { notASchema: true }; // no .merge, no .and
    const ctx = z.object({ a: z.string().optional() });
    const g = makeGraph();
    g.inputSchema = bogusInput;
    g.contextSchema = ctx;
    g.stateSchema = legacyState;
    let schema;
    expect(() => { schema = g._runtimeSchema(); }).not.toThrow();
    expect(schema).toBe(legacyState);
  });

  it('an input whose composition THROWS falls back to stateSchema, no crash', () => {
    const legacyState = z.object({ foo: z.string() });
    const ctx = z.object({ a: z.string().optional() });
    const throwingInput = {
      and() { throw new Error('boom'); }, // looks composable, but blows up
    };
    const g = makeGraph();
    g.inputSchema = throwingInput;
    g.contextSchema = ctx;
    g.stateSchema = legacyState;
    let schema;
    expect(() => { schema = g._runtimeSchema(); }).not.toThrow();
    expect(schema).toBe(legacyState);
  });

  it('no input and no context returns the legacy stateSchema', () => {
    const legacyState = z.object({ foo: z.string() });
    const g = makeGraph().setStateSchema(legacyState);
    expect(g._runtimeSchema()).toBe(legacyState);
  });
});
