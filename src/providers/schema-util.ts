// Minimal Zod -> JSON Schema conversion for tool parameters, shared by the
// providers. Only covers the shapes our built-in tools use; MCP tools bypass
// this by supplying their own JSON Schema via ToolDefinition.parameters.

interface ZodLike {
  _def?: {
    typeName?: string;
    innerType?: ZodLike;
    valueType?: ZodLike;
    values?: unknown[];
    description?: string;
    shape?: () => Record<string, unknown>;
  };
  description?: string;
}

/** Convert a Zod object schema into a JSON Schema object for tool `parameters`. */
export function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object" && "_def" in (schema as object)) {
    const def = (schema as { _def?: { shape?: () => Record<string, unknown> } })._def;
    if (def && typeof def.shape === "function") {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const shape = def.shape();
      for (const [k, v] of Object.entries(shape)) {
        const field = v as ZodLike;
        properties[k] = describeZod(field);
        if (field._def?.typeName !== "ZodOptional") required.push(k);
      }
      return {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      };
    }
  }
  return { type: "object", properties: {} };
}

function describeZod(z: ZodLike): Record<string, unknown> {
  const def = z._def;
  if (!def) return { type: "string" };
  switch (def.typeName) {
    case "ZodString": return { type: "string", description: z.description };
    case "ZodNumber": return { type: "number", description: z.description };
    case "ZodBoolean": return { type: "boolean", description: z.description };
    case "ZodArray": return { type: "array", items: describeZod(def.innerType ?? {}) };
    case "ZodObject": {
      if (typeof def.shape === "function") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(def.shape())) {
          out[k] = describeZod(v as ZodLike);
        }
        return { type: "object", properties: out };
      }
      return { type: "object" };
    }
    case "ZodEnum": return { type: "string", enum: def.values ?? [] };
    case "ZodRecord": return { type: "object", additionalProperties: describeZod(def.valueType ?? {}) };
    case "ZodOptional": return describeZod(def.innerType ?? {});
    default: return { type: "string" };
  }
}
