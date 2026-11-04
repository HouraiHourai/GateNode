import { Value } from "typebox/value";
import type { JsonObject, JsonSchema, JsonValue } from "./types.ts";
import { isJsonObject, toJsonValue } from "./utils.ts";

const SCHEMA_KEYWORDS = new Set([
	"$defs",
	"$ref",
	"additionalItems",
	"additionalProperties",
	"allOf",
	"anyOf",
	"const",
	"contains",
	"dependencies",
	"dependentRequired",
	"dependentSchemas",
	"definitions",
	"else",
	"enum",
	"exclusiveMaximum",
	"exclusiveMinimum",
	"format",
	"if",
	"items",
	"maximum",
	"maxContains",
	"maxItems",
	"maxLength",
	"maxProperties",
	"minimum",
	"minContains",
	"minItems",
	"minLength",
	"minProperties",
	"multipleOf",
	"not",
	"oneOf",
	"pattern",
	"patternProperties",
	"prefixItems",
	"properties",
	"propertyNames",
	"required",
	"then",
	"type",
	"unevaluatedItems",
	"unevaluatedProperties",
	"uniqueItems",
]);

const JSON_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

/**
 * Validate the parts of a JSON Schema that can otherwise silently become an
 * accept-all schema when misspelled or malformed. Annotation-only schemas are
 * rejected because node handoffs are expected to carry an actual contract.
 */
export function jsonSchemaProblems(schema: unknown, path = "schema"): string[] {
	if (typeof schema === "boolean") return [];
	if (!isJsonObject(schema)) return [`${path} must be a JSON Schema object or boolean`];
	const problems: string[] = [];
	validateSchemaObject(schema, path, problems);
	return problems;
}

export function assertJsonSchema(schema: unknown, source = "schema"): asserts schema is JsonSchema {
	const problems = jsonSchemaProblems(schema, source);
	if (problems.length > 0) throw new Error(`Invalid JSON Schema: ${problems.join("; ")}`);
}

export function validateSchemaOutput(schema: JsonSchema, value: unknown, source = "agent response"): JsonValue {
	const json = toJsonValue(value, source);
	let valid: boolean;
	try {
		valid = Value.Check(schema, json);
	} catch (error) {
		throw new Error(`Invalid or unsupported JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (valid) return json;

	let messages: string[] = [];
	try {
		const errors = [...Value.Errors(schema, json)];
		messages = errors.slice(0, 8).map((error) => {
			const location = error.instancePath || "/";
			return `${location} ${error.message}`;
		});
	} catch (error) {
		throw new Error(`Invalid or unsupported JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
	}
	throw new Error(`Schema validation failed: ${messages.join("; ") || "value does not match the schema"}`);
}

function validateSchemaObject(schema: JsonObject, path: string, problems: string[]): void {
	if (![...SCHEMA_KEYWORDS].some((keyword) => keyword in schema)) {
		problems.push(`${path} has no recognized validation keyword (type/properties/items/enum/...)`);
		return;
	}

	validateType(schema.type, `${path}.type`, problems);
	validateSchemaMap(schema.properties, `${path}.properties`, problems);
	validateSchemaMap(schema.patternProperties, `${path}.patternProperties`, problems);
	validateSchemaMap(schema.definitions, `${path}.definitions`, problems);
	validateSchemaMap(schema.$defs, `${path}.$defs`, problems);
	validateSchemaMap(schema.dependentSchemas, `${path}.dependentSchemas`, problems);

	for (const keyword of [
		"additionalItems",
		"additionalProperties",
		"contains",
		"else",
		"if",
		"not",
		"propertyNames",
		"then",
		"unevaluatedItems",
		"unevaluatedProperties",
	] as const) {
		validateNestedSchema(schema[keyword], `${path}.${keyword}`, problems);
	}

	if (schema.items !== undefined) {
		if (Array.isArray(schema.items)) validateSchemaArray(schema.items, `${path}.items`, problems);
		else validateNestedSchema(schema.items, `${path}.items`, problems);
	}
	for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
		const value = schema[keyword];
		if (value === undefined) continue;
		if (!Array.isArray(value) || value.length === 0) problems.push(`${path}.${keyword} must be a non-empty schema array`);
		else validateSchemaArray(value, `${path}.${keyword}`, problems);
	}

	if (schema.required !== undefined && !isUniqueStringArray(schema.required)) {
		problems.push(`${path}.required must be an array of unique strings`);
	}
	validateDependencies(schema.dependencies, `${path}.dependencies`, problems);
	validateStringArrayMap(schema.dependentRequired, `${path}.dependentRequired`, problems);
	if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
		problems.push(`${path}.enum must be a non-empty array`);
	}
	for (const keyword of ["$ref", "$id", "$schema", "format", "pattern"] as const) {
		if (schema[keyword] !== undefined && typeof schema[keyword] !== "string") {
			problems.push(`${path}.${keyword} must be a string`);
		}
	}
	if (typeof schema.pattern === "string") {
		try {
			new RegExp(schema.pattern);
		} catch {
			problems.push(`${path}.pattern must be a valid regular expression`);
		}
	}
	for (const keyword of [
		"maxContains",
		"maxItems",
		"maxLength",
		"maxProperties",
		"minContains",
		"minItems",
		"minLength",
		"minProperties",
	] as const) {
		const value = schema[keyword];
		if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
			problems.push(`${path}.${keyword} must be a non-negative integer`);
		}
	}
	for (const keyword of ["exclusiveMaximum", "exclusiveMinimum", "maximum", "minimum", "multipleOf"] as const) {
		const value = schema[keyword];
		if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
			problems.push(`${path}.${keyword} must be a finite number`);
		}
	}
	if (typeof schema.multipleOf === "number" && schema.multipleOf <= 0) {
		problems.push(`${path}.multipleOf must be greater than 0`);
	}
	if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
		problems.push(`${path}.uniqueItems must be boolean`);
	}
}

function validateType(value: JsonValue | undefined, path: string, problems: string[]): void {
	if (value === undefined) return;
	const values = Array.isArray(value) ? value : [value];
	if (values.length === 0 || values.some((item) => typeof item !== "string" || !JSON_TYPES.has(item))) {
		problems.push(`${path} must be a JSON type name or a non-empty array of JSON type names`);
	} else if (new Set(values).size !== values.length) {
		problems.push(`${path} must not contain duplicate JSON type names`);
	}
}

function validateSchemaMap(value: JsonValue | undefined, path: string, problems: string[]): void {
	if (value === undefined) return;
	if (!isJsonObject(value)) {
		problems.push(`${path} must be an object whose values are schemas`);
		return;
	}
	for (const [key, child] of Object.entries(value)) validateNestedSchema(child, `${path}.${key}`, problems);
}

function validateSchemaArray(value: JsonValue[], path: string, problems: string[]): void {
	value.forEach((child, index) => validateNestedSchema(child, `${path}.${index}`, problems));
}

function validateNestedSchema(value: JsonValue | undefined, path: string, problems: string[]): void {
	if (value === undefined) return;
	if (typeof value === "boolean") return;
	if (!isJsonObject(value)) {
		problems.push(`${path} must be a schema object or boolean`);
		return;
	}
	validateSchemaObject(value, path, problems);
}

function isUniqueStringArray(value: JsonValue): boolean {
	return Array.isArray(value) && value.every((item) => typeof item === "string") && new Set(value).size === value.length;
}

function validateDependencies(value: JsonValue | undefined, path: string, problems: string[]): void {
	if (value === undefined) return;
	if (!isJsonObject(value)) {
		problems.push(`${path} must be an object`);
		return;
	}
	for (const [key, dependency] of Object.entries(value)) {
		if (Array.isArray(dependency)) {
			if (!isUniqueStringArray(dependency)) problems.push(`${path}.${key} must be an array of unique strings or a schema`);
		} else {
			validateNestedSchema(dependency, `${path}.${key}`, problems);
		}
	}
}

function validateStringArrayMap(value: JsonValue | undefined, path: string, problems: string[]): void {
	if (value === undefined) return;
	if (!isJsonObject(value)) {
		problems.push(`${path} must be an object whose values are arrays of unique strings`);
		return;
	}
	for (const [key, dependency] of Object.entries(value)) {
		if (!isUniqueStringArray(dependency)) problems.push(`${path}.${key} must be an array of unique strings`);
	}
}
