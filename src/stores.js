/**
 * Stores v2 — declaration helpers.
 *
 * A node declares the stores it needs as objects:
 *   stores: [{ name, description }, ...]
 *
 * Shared contract (all repos follow this exactly):
 *   - `name` matches ^[a-z][a-z0-9_]{0,40}$ so it forms a valid env-key suffix
 *     (the backend maps each store to `ZIBBY_STORE__<name>=<storeId>`).
 *   - `name` is UNIQUE within a workflow (across all nodes).
 *   - `description` is free text (used to render the AVAILABLE STORES prompt
 *     catalog so the agent can pick a store by description and pass its NAME).
 *
 * This validator is a CONVENIENCE that documents the contract — the backend
 * runs its own authoritative validation at deploy time. It is a pure function
 * (no I/O, no throwing) returning a list of human-readable error strings;
 * an empty array means the declarations are valid.
 */

/** Store `name` must form a valid env-key suffix. */
export const STORE_NAME_REGEX = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * Validate an array of store declarations.
 *
 * @param {Array<{name?: string, description?: string}>} stores
 * @returns {string[]} errors — empty when valid.
 */
export function validateStoreDefs(stores) {
  // Empty/absent is a valid no-op (backward compatible).
  if (stores == null) return [];
  if (!Array.isArray(stores)) {
    return ['stores must be an array of { name, description } objects'];
  }

  const errors = [];
  const seen = new Map(); // name -> first index, for unique-name detection

  stores.forEach((store, i) => {
    if (store == null || typeof store !== 'object' || Array.isArray(store)) {
      errors.push(`stores[${i}] must be an object { name, description }`);
      return;
    }
    const { name } = store;
    if (typeof name !== 'string' || name.length === 0) {
      errors.push(`stores[${i}] is missing a string "name"`);
      return;
    }
    if (!STORE_NAME_REGEX.test(name)) {
      errors.push(
        `stores[${i}] name "${name}" is invalid — must match ${STORE_NAME_REGEX} ` +
        `(lowercase letter first, then up to 40 of [a-z0-9_])`
      );
    }
    if (seen.has(name)) {
      errors.push(
        `stores[${i}] duplicate store name "${name}" (also at index ${seen.get(name)}) ` +
        `— store names must be unique within a workflow`
      );
    } else {
      seen.set(name, i);
    }
  });

  return errors;
}
