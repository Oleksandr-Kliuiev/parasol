import { AtlasError } from '../core/contracts.ts';

/**
 * Runtime schemas of tool parameters (task 1.9). Strict: a parameter object is a plain object whose keys are all declared,
 * each value has the declared type and bounds, and required ones are present. A violation is INVALID_TOOL_PARAMETERS
 * naming the declared parameter — never the value, and never an undeclared key, which may itself be hostile.
 */
export type ParameterField =
  | { type: 'string'; pattern: RegExp; required?: boolean; description: string }
  | { type: 'integer'; min: number; max: number; required?: boolean; description: string }
  | { type: 'list'; values: readonly string[]; maxItems: number; required?: boolean; description: string };
export type ParameterSchema = Readonly<Record<string, ParameterField>>;
export type Parameters = Record<string, string | number | string[]>;

const invalid = (parameter: string) => new AtlasError('INVALID_TOOL_PARAMETERS', 'VALIDATION', { parameter });
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function validateParameters(schema: ParameterSchema, input: unknown): Parameters {
  if (input === undefined) input = {};
  if (!isPlainObject(input)) throw invalid('parameters');
  if (Object.keys(input).some(key => !Object.hasOwn(schema, key))) throw invalid('unexpected');
  const out: Parameters = {};
  for (const [name, field] of Object.entries(schema)) {
    const value = input[name];
    if (value === undefined) { if (field.required) throw invalid(name); continue; }
    if (field.type === 'string') {
      if (typeof value !== 'string' || !field.pattern.test(value)) throw invalid(name);
      out[name] = value;
    } else if (field.type === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < field.min || value > field.max) throw invalid(name);
      out[name] = value;
    } else {
      if (!Array.isArray(value) || value.length === 0 || value.length > field.maxItems || new Set(value).size !== value.length
        || !value.every(v => typeof v === 'string' && field.values.includes(v))) throw invalid(name);
      out[name] = [...value] as string[];
    }
  }
  return out;
}

/** JSON description of a schema for GET /tools: types, bounds and patterns, nothing executable. */
export function describeParameters(schema: ParameterSchema): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(schema).map(([name, field]) => [name, {
    type: field.type, required: field.required === true, description: field.description,
    ...(field.type === 'string' ? { pattern: field.pattern.source } : field.type === 'integer' ? { min: field.min, max: field.max }
      : { values: [...field.values], maxItems: field.maxItems }) }]));
}
