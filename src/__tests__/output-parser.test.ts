/**
 * Tests for OutputParser and SchemaTypes
 */
import { describe, it, expect } from 'vitest';
import { OutputParser, SchemaTypes } from '../output-parser.js';

describe('OutputParser', () => {
  describe('parse', () => {
    it('extracts JSON from a fenced ```json block', () => {
      const parser = new OutputParser({ name: SchemaTypes.string() });
      const text = 'Here is the answer:\n```json\n{"name": "ada"}\n```\nthanks';

      expect(parser.parse(text)).toEqual({ name: 'ada' });
    });

    it('extracts JSON object from raw text without code fence', () => {
      const parser = new OutputParser({ name: SchemaTypes.string() });
      const text = 'preamble {"name": "grace"} trailing';

      expect(parser.parse(text)).toEqual({ name: 'grace' });
    });

    it('falls back to wrapping plain text in {result}', () => {
      const parser = new OutputParser({ result: SchemaTypes.string() });

      expect(parser.parse('  hello world  ')).toEqual({ result: 'hello world' });
    });

    it('prefers fenced block when both fence and bare object are present', () => {
      const parser = new OutputParser({ name: SchemaTypes.string() });
      const text = '```json\n{"name": "fenced"}\n```\n{"name": "bare"}';

      expect(parser.parse(text)).toEqual({ name: 'fenced' });
    });

    it('parses multi-line JSON objects', () => {
      const parser = new OutputParser({
        name: SchemaTypes.string(),
        count: SchemaTypes.number(),
      });
      const text = '```json\n{\n  "name": "x",\n  "count": 3\n}\n```';

      expect(parser.parse(text)).toEqual({ name: 'x', count: 3 });
    });

    it('handles two `{...}` spans without splicing them together', () => {
      // Greedy regex would capture `{"name": "first"}. Note: {"name": "second"}`
      // and fail JSON.parse. Non-greedy fallback picks the first object.
      const parser = new OutputParser({ name: SchemaTypes.string() });
      const text = 'Here you go: {"name": "first"}. Note: {"name": "second"}';

      expect(parser.parse(text)).toEqual({ name: 'first' });
    });

    it('handles nested objects (greedy fallback wins)', () => {
      // Non-greedy regex matches `{"outer": {"inner": 1}` (truncated, fails parse).
      // Greedy fallback matches the whole thing and parses correctly.
      const parser = new OutputParser({
        outer: { type: 'object', required: true, validate: (v) => v && typeof v === 'object' ? null : 'must be object' },
      });
      const text = 'Result: {"outer": {"inner": 1}}';

      expect(parser.parse(text)).toEqual({ outer: { inner: 1 } });
    });

    it('schema validation errors are NOT swallowed by parse-strategy fallback', () => {
      // If JSON parses cleanly but FAILS validation, we should see the
      // validation error — not silently fall through to the next candidate
      // and end up wrapping the whole thing in {result}.
      const parser = new OutputParser({
        status: SchemaTypes.enum(['ok', 'fail']),
      });
      const text = '{"status": "wrong-value"}';

      expect(() => parser.parse(text)).toThrow(/must be one of: ok, fail/);
    });
  });

  describe('validate — required fields', () => {
    it('throws when a required field is missing', () => {
      const parser = new OutputParser({ name: SchemaTypes.string() });

      expect(() => parser.validate({})).toThrow(/Missing required field: name/);
    });

    it('does not throw when an optional field is missing', () => {
      const parser = new OutputParser({ name: SchemaTypes.string(false) });

      expect(parser.validate({})).toEqual({});
    });
  });

  describe('validate — type checking', () => {
    it('rejects wrong primitive types', () => {
      const parser = new OutputParser({ count: SchemaTypes.number() });

      expect(() => parser.validate({ count: 'not a number' })).toThrow(
        /Field 'count' expected number, got string/
      );
    });

    it('accepts correct primitive types', () => {
      const parser = new OutputParser({
        name: SchemaTypes.string(),
        count: SchemaTypes.number(),
        active: SchemaTypes.boolean(),
      });

      expect(parser.validate({ name: 'x', count: 1, active: true })).toEqual({
        name: 'x', count: 1, active: true,
      });
    });

    it('aggregates multiple errors into a single throw', () => {
      const parser = new OutputParser({
        name: SchemaTypes.string(),
        count: SchemaTypes.number(),
      });

      expect(() => parser.validate({ count: 'no' })).toThrow(
        /Missing required field: name[\s\S]*Field 'count' expected number/
      );
    });
  });

  describe('SchemaTypes.array', () => {
    it('accepts arrays', () => {
      const parser = new OutputParser({ items: SchemaTypes.array() });

      expect(parser.validate({ items: [1, 2, 3] })).toEqual({ items: [1, 2, 3] });
    });

    it('rejects non-arrays', () => {
      const parser = new OutputParser({ items: SchemaTypes.array() });

      expect(() => parser.validate({ items: 'nope' })).toThrow(/must be an array/);
    });
  });

  describe('SchemaTypes.enum', () => {
    it('accepts allowed enum values', () => {
      const parser = new OutputParser({
        status: SchemaTypes.enum(['pending', 'done']),
      });

      expect(parser.validate({ status: 'done' })).toEqual({ status: 'done' });
    });

    it('rejects values outside the enum', () => {
      const parser = new OutputParser({
        status: SchemaTypes.enum(['pending', 'done']),
      });

      expect(() => parser.validate({ status: 'wat' })).toThrow(
        /must be one of: pending, done/
      );
    });
  });

  describe('end-to-end', () => {
    it('parses a fenced response and validates it in one shot', () => {
      const parser = new OutputParser({
        name: SchemaTypes.string(),
        count: SchemaTypes.number(),
        status: SchemaTypes.enum(['ok', 'fail']),
      });

      const text = '```json\n{"name": "x", "count": 2, "status": "ok"}\n```';
      expect(parser.parse(text)).toEqual({ name: 'x', count: 2, status: 'ok' });
    });

    it('throws when fenced response fails validation', () => {
      const parser = new OutputParser({
        status: SchemaTypes.enum(['ok', 'fail']),
      });

      const text = '```json\n{"status": "weird"}\n```';
      expect(() => parser.parse(text)).toThrow(/must be one of: ok, fail/);
    });
  });
});
