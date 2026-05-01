/**
 * Structured output parsing with schema validation.
 * Similar to LangChain's StructuredOutputParser.
 */

export class OutputParser {
  constructor(schema) {
    this.schema = schema;
  }

  parse(text) {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      return this.validate(JSON.parse(jsonMatch[1]));
    }

    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return this.validate(JSON.parse(objectMatch[0]));
    }

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
