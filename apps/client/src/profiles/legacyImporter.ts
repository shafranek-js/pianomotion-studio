import {
  type PianistProfile,
  PianistProfileSchema,
  SCHEMA_VERSION,
} from "@handthesia/contracts";
import { DEFAULT_ANATOMY, DEFAULT_BEHAVIOR } from "./types.ts";

const PROHIBITED_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function sanitizeSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 200);
}

/**
 * Imports a pianist profile JSON string.
 *
 * Requirements:
 * - Parses profile JSON string
 * - Validates and sanitizes name (disallowing empty, __proto__, or prototype pollution)
 * - Fills defaults for missing anatomy or behavior properties
 * - Ensures all bone lengths are positive numbers (> 0)
 * - Sets valid schemaVersion: 1, profileId, revision: 0, and timestamps
 * - Validates against PianistProfileSchema
 */
export function importLegacyPianistJson(rawJsonText: string): PianistProfile {
  if (typeof rawJsonText !== "string" || rawJsonText.trim().length === 0) {
    throw new Error("Failed to parse legacy profile JSON: input is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJsonText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse legacy profile JSON: ${message}`, { cause: err });
  }

  if (!isObject(parsed)) {
    throw new Error("Invalid legacy profile JSON: root must be a JSON object");
  }

  // 1. Validate name
  const rawName = parsed.name;
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    throw new Error(
      "Invalid legacy profile: 'name' is required and must be a non-empty string"
    );
  }

  const trimmedName = rawName.trim();
  if (PROHIBITED_KEYS.has(trimmedName) || PROHIBITED_KEYS.has(rawName)) {
    throw new Error(`Invalid legacy profile: prohibited name '${rawName}'`);
  }

  // 2. Profile ID
  let profileId = "";
  if (typeof parsed.profileId === "string" && parsed.profileId.trim().length > 0) {
    profileId = sanitizeSlug(parsed.profileId);
  } else if (typeof parsed.id === "string" && parsed.id.trim().length > 0) {
    profileId = sanitizeSlug(parsed.id);
  }
  if (!profileId) {
    profileId = sanitizeSlug(trimmedName);
  }
  if (!profileId) {
    profileId = "imported-profile";
  }

  // 3. Color
  let colorRgb: [number, number, number] = [12, 12, 14];
  const rawColor = parsed.colorRgb ?? parsed.color;
  if (Array.isArray(rawColor) && rawColor.length >= 3) {
    const r = Math.max(0, Math.min(255, Math.round(Number(rawColor[0]) || 0)));
    const g = Math.max(0, Math.min(255, Math.round(Number(rawColor[1]) || 0)));
    const b = Math.max(0, Math.min(255, Math.round(Number(rawColor[2]) || 0)));
    colorRgb = [r, g, b];
  }

  // 4. Anatomy
  const anatomy: Record<string, number> = {
    ...DEFAULT_ANATOMY,
    wrist: 1.0,
  };

  if (parsed.anatomy !== undefined) {
    if (!isObject(parsed.anatomy)) {
      throw new Error(
        "Invalid legacy profile: 'anatomy' must be a key-value object"
      );
    }

    for (const [key, val] of Object.entries(parsed.anatomy)) {
      if (PROHIBITED_KEYS.has(key)) {
        continue;
      }

      if (typeof val !== "number" || isNaN(val) || !isFinite(val) || val <= 0) {
        throw new Error(
          `Invalid bone length for '${key}': must be a positive number, got ${String(
            val
          )}`
        );
      }

      anatomy[key] = val;
    }
  }

  // Verify all anatomy entries are positive
  for (const [key, val] of Object.entries(anatomy)) {
    if (typeof val !== "number" || isNaN(val) || !isFinite(val) || val <= 0) {
      throw new Error(
        `Invalid bone length for '${key}': must be a positive number, got ${String(
          val
        )}`
      );
    }
  }

  // 5. Behavior
  const behavior: Record<string, number | string | boolean> = {
    ...DEFAULT_BEHAVIOR,
  };

  if (parsed.behavior !== undefined) {
    if (!isObject(parsed.behavior)) {
      throw new Error(
        "Invalid legacy profile: 'behavior' must be a key-value object"
      );
    }

    for (const [key, val] of Object.entries(parsed.behavior)) {
      if (PROHIBITED_KEYS.has(key)) {
        continue;
      }

      if (
        (typeof val === "number" && isFinite(val)) ||
        typeof val === "string" ||
        typeof val === "boolean"
      ) {
        behavior[key] = val;
      }
    }
  }

  // 6. Skin
  let skin: Record<string, unknown> = {
    style: "cartoon",
    colors: {
      skeleton: {
        bone: colorRgb,
      },
    },
  };

  if (isObject(parsed.skin)) {
    skin = {};
    for (const [key, val] of Object.entries(parsed.skin)) {
      if (!PROHIBITED_KEYS.has(key)) {
        skin[key] = val;
      }
    }
  }

  // 7. Weights
  const weights: Record<string, number> = {};
  if (isObject(parsed.weights)) {
    for (const [key, val] of Object.entries(parsed.weights)) {
      if (PROHIBITED_KEYS.has(key)) {
        continue;
      }
      const num = Number(val);
      if (isFinite(num) && num >= 0) {
        weights[key] = num;
      }
    }
  }

  // 8. Timestamps
  const now = Date.now() / 1000;
  let createdAt = Number(parsed.createdAtUnixSeconds ?? parsed.created);
  if (isNaN(createdAt) || !isFinite(createdAt) || createdAt < 0) {
    createdAt = now;
  }

  let modifiedAt = Number(parsed.modifiedAtUnixSeconds ?? parsed.modified);
  if (isNaN(modifiedAt) || !isFinite(modifiedAt) || modifiedAt < createdAt) {
    modifiedAt = createdAt;
  }

  const candidateProfile: unknown = {
    schemaVersion: SCHEMA_VERSION,
    profileId,
    revision: 0,
    name: trimmedName,
    colorRgb,
    anatomy,
    behavior,
    skin,
    weights,
    createdAtUnixSeconds: createdAt,
    modifiedAtUnixSeconds: modifiedAt,
  };

  // Validate strictly against PianistProfileSchema
  return PianistProfileSchema.parse(candidateProfile);
}

/**
 * Serializes a validated PianistProfile into formatted JSON (2 spaces).
 */
export function exportProfileToJson(profile: PianistProfile): string {
  const validated = PianistProfileSchema.parse(profile);
  return JSON.stringify(validated, null, 2);
}
