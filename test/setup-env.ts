/**
 * Keep the test suite off the live gateway's files.
 *
 * `src/config.ts` snapshots the environment at import time, so a test that sets
 * DB_PATH after something has already pulled in config keeps the default path —
 * the real ~/.local/share/piscord-gateway database. The suite was inserting
 * channels straight into production (a stray `dc:test_model_rpc` row is how it
 * was spotted) and reading the deployment's config.env for everything else.
 *
 * This runs before any test module is imported, so no test can reach a real
 * path by accident. Tests that want their own database still override these.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = mkdtempSync(resolve(tmpdir(), 'piscord-test-'));

process.env.PIDG_CONFIG ??= resolve(root, 'config.env');
process.env.DB_PATH ??= resolve(root, 'gateway.db');
process.env.SESSIONS_DIR ??= resolve(root, 'sessions');
