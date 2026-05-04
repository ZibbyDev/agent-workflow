/**
 * Structured output parsing with schema validation.
 * Similar to LangChain's StructuredOutputParser.
 */

export class OutputParser {
  constructor(schema) {
    this.schema = schema;
  }

  parse(text) {
    // 1. Prefer ```json fences when present — the most explicit signal.
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      return this.validate(JSON.parse(jsonMatch[1]));
    }

    // 2. Try non-greedy first, then greedy. Neither alone is right:
    //    - non-greedy fails on nested objects (`{a: {b: 1}}` → `{a: {b: 1}`)
    //    - greedy fails on multi-paragraph output that contains two `{...}`
    //      spans (grabs first `{` to LAST `}`, splicing them together)
    //    Trying both and returning the first JSON.parse-able match handles
    //    both shapes without a real bracket-balancer.
    const candidates = [
      text.match(/\{[\s\S]*?\}/),
      text.match(/\{[\s\S]*\}/),
    ].filter(Boolean).map(m => m[0]);

    for (const candidate of candidates) {
      try {
        return this.validate(JSON.parse(candidate));
      } catch (err) {
        // SyntaxError = JSON.parse failure → try the next candidate.
        // Anything else (validation failure on a parsed object) → real
        // schema mismatch, surface immediately.
        if (!(err instanceof SyntaxError)) throw err;
      }
    }

    // 3. Last resort: wrap the whole string. Preserves prior behavior.
    return this.validate({ result: text.trim() });
  }

  validate(data) {
    const errors = [];

    for (const [key, validator] of Object.entries(this.schema)) {
      if (validator.required && !(key in data)) {
        errors.push(`Missing required field: ${key}`);
      }
      if (key in data && validator.type) {
        const actualType = typeof data[key];
        if (actualType !== validator.type) {
          errors.push(`Field '${key}' expected ${validator.type}, got ${actualType}`);
        }
      }
      if (validator.validate && key in data) {
        const validationError = validator.validate(data[key]);
        if (validationError) errors.push(`Field '${key}': ${validationError}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Output validation failed:\n${errors.join('\n')}`);
    }

    return data;
  }
}

export const SchemaTypes = {
  string:  (required = true) => ({ type: 'string', required }),
  number:  (required = true) => ({ type: 'number', required }),
  boolean: (required = true) => ({ type: 'boolean', required }),
  array:   (required = true) => ({ type: 'object', required, validate: (v) => Array.isArray(v) ? null : 'must be an array' }),
  enum:    (values, required = true) => ({
    type: 'string',
    required,
    validate: (v) => values.includes(v) ? null : `must be one of: ${values.join(', ')}`
  }),
};
