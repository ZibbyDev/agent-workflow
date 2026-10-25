import { readFileSync } from 'node:fs';
import * as util from 'node:util';

/**
 * Load a `.env` file into process.env with Node's own parser (no dotenv).
 *
 * Same behaviour the engine had with `dotenv.config()`:
 *   - a key already in process.env wins (the file only fills what is missing);
 *   - a missing or unreadable file is skipped without a word;
 *   - nothing is printed.
 * `util.parseEnv` reads quotes, `#` comments and multiline values the same way
 * dotenv 17 does (checked side by side on Node 22.23 — __tests__/load-env-file.test.ts).
 * Values are written onto the `process.env` object exactly as dotenv did, not
 * through `process.loadEnvFile`, which writes the native environment and so is
 * invisible where process.env is a copy (a test runner's sandbox).
 */
export function loadEnvFile(path = '.env'): void {
  if (typeof util.parseEnv !== 'function') {
    throw new Error(`Reading ${path} needs Node 20.12 or newer (this is ${process.version})`);
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // missing, a directory, or unreadable: the file is simply not there for us
  }
  for (const [key, value] of Object.entries(util.parseEnv(text))) {
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) process.env[key] = value;
  }
}
