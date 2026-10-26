/**
 * Safe JSON Parser Utility
 *
 * Provides protection against prototype pollution attacks when parsing JSON.
 * CWE-1321: Improperly Controlled Modification of Object Prototype Attributes
 *
 * Usage:
 *   import { safeJSONParse, sanitizeObject } from '../utils/safe-json';
 *   const data = safeJSONParse<MyType>(jsonString);
 */

/**
 * Dangerous property names that can lead to prototype pollution
 */
const DANGEROUS_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
];

/**
 * Recursively remove dangerous properties from an object
 */
export function sanitizeObject<T>(obj: unknown): T {
  if (obj === null || typeof obj !== 'object') {
    return obj as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item)) as T;
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    // Skip dangerous keys
    if (DANGEROUS_KEYS.includes(key)) {
      console.warn(`[Security] Removed dangerous key from JSON: ${key}`);
      continue;
    }

    // Recursively sanitize nested objects
    sanitized[key] = sanitizeObject(value);
  }

  return sanitized as T;
}

/**
 * Safely parse JSON with prototype pollution protection
 *
 * @param jsonString - The JSON string to parse
 * @param reviver - Optional reviver function (same as JSON.parse)
 * @returns Parsed and sanitized object, or null if parsing fails
 */
export function safeJSONParse<T = unknown>(
  jsonString: string,
  reviver?: (key: string, value: unknown) => unknown
): T | null {
  try {
    const parsed = JSON.parse(jsonString, reviver);
    return sanitizeObject<T>(parsed);
  } catch (error) {
    console.error('[Security] JSON parse error:', error);
    return null;
  }
}

/**
 * Safely parse JSON with strict validation
 * Throws an error instead of returning null
 *
 * @param jsonString - The JSON string to parse
 * @param context - Context string for error messages
 * @returns Parsed and sanitized object
 * @throws Error if parsing fails
 */
export function safeJSONParseStrict<T = unknown>(
  jsonString: string,
  context: string = 'unknown'
): T {
  try {
    const parsed = JSON.parse(jsonString);
    return sanitizeObject<T>(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`[Security] JSON parse failed in ${context}: ${message}`, { cause: error });
  }
}

/**
 * Check if an object contains dangerous prototype pollution keys
 */
export function hasDangerousKeys(obj: unknown): boolean {
  if (obj === null || typeof obj !== 'object') {
    return false;
  }

  if (Array.isArray(obj)) {
    return obj.some((item) => hasDangerousKeys(item));
  }

  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.includes(key)) {
      return true;
    }

    const value = (obj as Record<string, unknown>)[key];
    if (hasDangerousKeys(value)) {
      return true;
    }
  }

  return false;
}

/**
 * Type guard for validating parsed JSON against a schema
 *
 * Usage:
 *   const data = safeJSONParse<Config>(json);
 *   if (data && isValidConfig(data)) {
 *     // data is now typed as Config
 *   }
 */
export type TypeGuard<T> = (value: unknown) => value is T;

/**
 * Safely parse JSON with type validation
 *
 * @param jsonString - The JSON string to parse
 * @param validator - Type guard function to validate the parsed object
 * @returns Validated and typed object, or null if validation fails
 */
export function safeJSONParseWithValidation<T>(
  jsonString: string,
  validator: TypeGuard<T>
): T | null {
  const parsed = safeJSONParse(jsonString);

  if (parsed === null) {
    return null;
  }

  if (!validator(parsed)) {
    console.error('[Security] JSON validation failed: object did not match expected type');
    return null;
  }

  return parsed;
}
