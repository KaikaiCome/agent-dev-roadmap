// 第 24 章：零依赖的 JSON Schema 校验器，只实现本项目用到的子集。
// 不认识的关键字直接报错，而不是悄悄忽略：一个“看起来有约束、其实没校验”的 schema 比没有 schema 更危险。
// 生产项目可以换成 Ajv 等完整实现，接口保持“返回错误列表”即可。

export type JsonSchema = Record<string, unknown>;

const SUPPORTED = new Set([
  'type', 'description', 'title', 'enum', 'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
]);

/** 返回所有校验错误（空数组 = 通过）。错误带 JSON 路径，可以原样发回给模型让它修正 */
export function validate(schema: JsonSchema, value: unknown, path = '$'): string[] {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new Error(`${path}: schema 关键字 ${key} 不在支持的子集里`);
  }
  const errors: string[] = [];
  const types = schema.type === undefined ? undefined : ([] as string[]).concat(schema.type as string | string[]);
  if (types && !types.some((type) => matchesType(type, value))) {
    return [`${path}: 应为 ${types.join(' 或 ')}，实际是 ${typeName(value)}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
    errors.push(`${path}: 只能是 ${schema.enum.map((option) => JSON.stringify(option)).join(' / ')} 之一，实际是 ${JSON.stringify(value)}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path}: 长度不能少于 ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path}: 长度不能超过 ${schema.maxLength}（实际 ${value.length}）`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: 不匹配 ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: 不能小于 ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: 不能大于 ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: 至少 ${schema.minItems} 项`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: 最多 ${schema.maxItems} 项（实际 ${value.length}）`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items as JsonSchema, item, `${path}[${i}]`)));
  }
  if (isObject(value)) {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in value)) errors.push(`${path}.${key}: 缺少必填字段`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) errors.push(...validate(properties[key], item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: 不允许的字段`);
    }
  }
  return errors;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: throw new Error(`不支持的类型 ${type}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
