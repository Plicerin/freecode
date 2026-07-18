// Minimal Zod -> JSON Schema conversion for tool parameters, shared by the
// providers. Only covers the shapes our built-in tools use; MCP tools bypass
// this by supplying their own JSON Schema via ToolDefinition.parameters.
//
// Fidelity matters more than it looks: a frontier model infers a tool's shape
// from param names and prose, but a weak local model only has what this emits.
// So we carry constraints (min/max, formats, enums, required, nested shape) and
// descriptions through — and we UNWRAP the wrappers (.refine()/.optional()/
// .default()/.nullable()) that would otherwise hide the schema entirely.

interface ZodCheck {
  kind: string; // "min" | "max" | "int" | "length" | "url" | "email" | "uuid" | "regex" | …
  value?: number;
  inclusive?: boolean;
  regex?: RegExp;
}

interface ZodLengthBound { value: number }

interface ZodDef {
  typeName?: string;
  innerType?: ZodLike;   // ZodOptional / ZodDefault / ZodNullable
  schema?: ZodLike;      // ZodEffects (.refine()/.transform())
  type?: ZodLike;        // ZodArray element
  valueType?: ZodLike;   // ZodRecord value
  values?: unknown[];    // ZodEnum
  value?: unknown;       // ZodLiteral
  options?: ZodLike[];   // ZodUnion
  checks?: ZodCheck[];
  description?: string;
  minLength?: ZodLengthBound | null; // ZodArray
  maxLength?: ZodLengthBound | null; // ZodArray
  exactLength?: ZodLengthBound | null; // ZodArray .length()
  shape?: () => Record<string, unknown>;
}

interface ZodLike {
  _def?: ZodDef;
  description?: string;
}

/** Walk wrapper types (.refine()/.optional()/.default()/.nullable()) to the
 *  object shape underneath. Returns null when there's no object at the core. */
function objectShape(schema: ZodLike): (() => Record<string, unknown>) | null {
  let cur: ZodLike | undefined = schema;
  for (let i = 0; i < 16; i++) {
    const def: ZodDef | undefined = cur?._def;
    if (!def) break;
    if (typeof def.shape === "function") return def.shape;
    if (def.schema) { cur = def.schema; continue; }      // ZodEffects
    if (def.innerType) { cur = def.innerType; continue; } // Optional/Default/Nullable
    break;
  }
  return null;
}

/** Build the JSON Schema for an object from its Zod shape: properties, the
 *  required list (everything not optional/defaulted), and closed extras. */
function objectToJsonSchema(shapeFn: () => Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, v] of Object.entries(shapeFn())) {
    const field = v as ZodLike;
    properties[k] = describeZod(field);
    if (!isOptionalField(field)) required.push(k);
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/** Convert a Zod object schema into a JSON Schema object for tool `parameters`.
 *  Unwraps a top-level ZodEffects (a `.refine()`-wrapped object) so a tool like
 *  FileEdit — whose schema is `z.object({…}).refine().refine()` — still
 *  advertises its fields instead of an empty `{}`. */
export function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  const s = schema as ZodLike;
  const shapeFn = s && typeof s === "object" ? objectShape(s) : null;
  return shapeFn ? objectToJsonSchema(shapeFn) : { type: "object", properties: {} };
}

/** A field is optional to the caller when it's `.optional()` or has a
 *  `.default()` — a `.nullable()` field is still required (value present, may be
 *  null). `.refine()` on a field is transparent. */
function isOptionalField(z: ZodLike): boolean {
  const tn = z._def?.typeName;
  if (tn === "ZodOptional" || tn === "ZodDefault") return true;
  if (tn === "ZodEffects" && z._def?.schema) return isOptionalField(z._def.schema);
  return false;
}

// Carry a string's length bounds (.min()/.max()/.length()) and its recognized
// formats (.url()/.email()/.uuid()/.regex()) into JSON Schema. Without these a
// required `z.string().min(1)` or `z.string().url()` reads to the model as "any
// string" — so it sends "" or "example.com" and only the runtime Zod check
// objects (the empty-Grep-pattern / bare-host-WebFetch failures).
function stringConstraints(checks: ZodCheck[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of checks ?? []) {
    if (c.kind === "min" && typeof c.value === "number") out.minLength = c.value;
    else if (c.kind === "max" && typeof c.value === "number") out.maxLength = c.value;
    else if (c.kind === "length" && typeof c.value === "number") { out.minLength = c.value; out.maxLength = c.value; }
    else if (c.kind === "url") out.format = "uri";
    else if (c.kind === "email") out.format = "email";
    else if (c.kind === "uuid") out.format = "uuid";
    else if (c.kind === "regex" && c.regex instanceof RegExp) out.pattern = c.regex.source;
  }
  return out;
}

// Carry a number's bounds and integer-ness. `.int()` becomes type "integer";
// `.positive()` arrives as an exclusive min of 0, so honor `inclusive`.
function numberConstraints(checks: ZodCheck[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of checks ?? []) {
    if (c.kind === "int") out.type = "integer";
    else if (c.kind === "min" && typeof c.value === "number") out[c.inclusive === false ? "exclusiveMinimum" : "minimum"] = c.value;
    else if (c.kind === "max" && typeof c.value === "number") out[c.inclusive === false ? "exclusiveMaximum" : "maximum"] = c.value;
  }
  return out;
}

// Array item-count bounds (.min()/.max()/.length()) live on the ZodArray _def,
// not in `checks`. Emit minItems/maxItems so a must-be-non-empty array can't be
// advertised as accepting [].
function arrayConstraints(def: ZodDef): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof def.exactLength?.value === "number") { out.minItems = def.exactLength.value; out.maxItems = def.exactLength.value; }
  if (typeof def.minLength?.value === "number") out.minItems = def.minLength.value;
  if (typeof def.maxLength?.value === "number") out.maxItems = def.maxLength.value;
  return out;
}

/** The single recursion point: describe a Zod node, then attach this node's
 *  `.describe()` text if the inner schema didn't already carry one. This is what
 *  makes `.optional().describe(…)` work — the description sits on the ZodOptional
 *  wrapper, and this restores it after unwrapping. */
function describeZod(z: ZodLike): Record<string, unknown> {
  const out = describeZodInner(z);
  const desc = z._def?.description;
  if (desc && out.description === undefined) out.description = desc;
  return out;
}

function literalType(value: unknown): "string" | "number" | "boolean" {
  return typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";
}

function describeZodInner(z: ZodLike): Record<string, unknown> {
  const def = z._def;
  if (!def) return {};
  switch (def.typeName) {
    // Spread constraints AFTER `type` so `.int()`'s "integer" overrides "number".
    case "ZodString": return { type: "string", ...stringConstraints(def.checks) };
    case "ZodNumber": return { type: "number", ...numberConstraints(def.checks) };
    case "ZodBoolean": return { type: "boolean" };
    case "ZodArray": return { type: "array", items: describeZod(def.type ?? {}), ...arrayConstraints(def) };
    case "ZodObject":
      return typeof def.shape === "function" ? objectToJsonSchema(def.shape) : { type: "object" };
    case "ZodEnum": return { type: "string", enum: def.values ?? [] };
    case "ZodLiteral": return { type: literalType(def.value), enum: [def.value] };
    case "ZodRecord": return { type: "object", additionalProperties: describeZod(def.valueType ?? {}) };
    case "ZodUnion": return { anyOf: (def.options ?? []).map((o) => describeZod(o)) };
    case "ZodNullable": return { ...describeZod(def.innerType ?? {}), nullable: true };
    // Transparent wrappers — the value the caller sends is the inner type's.
    case "ZodOptional":
    case "ZodDefault": return describeZod(def.innerType ?? {});
    case "ZodEffects": return describeZod(def.schema ?? {});
    default: return {}; // unknown construct → permissive (was mislabeled "string")
  }
}
