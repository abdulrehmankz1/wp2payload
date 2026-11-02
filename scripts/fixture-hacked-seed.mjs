#!/usr/bin/env node
// Starts and seeds the hacked-site fixture (tests/fixtures/hacked-site, doc 12.14). Idempotent.
// No npm deps. Never prints the Application Password; it is only written to .env as HACKED_WP_*.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILE = join(ROOT, 'tests', 'fixtures', 'hacked-site', 'docker-compose.yml');
const SITE_URL = 'http://localhost:8091';
const EDITOR = 'wp2p-editor';
const APP_PW_NAME = 'wp2p-hacked';
// Fake local-only admin credentials (fixture runs on 127.0.0.1 only).
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'fixture-admin-not-a-secret';

const log = (m) => console.log(`[fixture-hacked-seed] ${m}`);

function compose(args, { allowFail = false } = {}) {
  const r = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`docker compose failed to start: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    // Never echo stdout (may hold secrets); stderr from wp-cli does not.
    throw new Error(`docker compose ${args.slice(0, 6).join(' ')} exited ${r.status}: ${(r.stderr || '').trim().slice(0, 500)}`);
  }
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const wp = (args, opts) => compose(['run', '--rm', '-T', 'wpcli', 'wp', ...args], opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady() {
  log('waiting for WordPress files and database...');
  compose(['up', '-d', 'wordpress', 'db']);
  for (let i = 0; i < 60; i++) {
    const r = wp(['eval', 'global $wpdb; echo $wpdb->check_connection(false) ? "ready" : "no";'], { allowFail: true });
    // Before install, WP dies with 'not installed' once the DB connection works.
    if ((r.ok && r.out.endsWith('ready')) || /not installed/.test(r.err)) return;
    await sleep(3000);
  }
  throw new Error('timed out waiting for WordPress/MySQL (60 x 3s)');
}

function updateEnv(values) {
  const path = join(ROOT, '.env');
  let lines = [];
  try {
    lines = readFileSync(path, 'utf8').split(/\r?\n/);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(values)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
}

async function main() {
  await waitReady();

  if (!wp(['core', 'is-installed'], { allowFail: true }).ok) {
    log('installing WordPress core...');
    wp(['core', 'install', `--url=${SITE_URL}`, '--title=wp2payload hacked fixture', `--admin_user=${ADMIN_USER}`,
      `--admin_password=${ADMIN_PASS}`, '--admin_email=admin@example.invalid', '--skip-email']);
  } else log('core already installed');
  wp(['option', 'update', 'home', SITE_URL]);
  wp(['option', 'update', 'siteurl', SITE_URL]);
  wp(['rewrite', 'structure', '/%postname%/', '--hard']);
  wp(['rewrite', 'flush', '--hard']);

  log('seeding threats...');
  wp(['eval-file', '/seed/seed.php']);

  if (!wp(['user', 'get', EDITOR], { allowFail: true }).ok) {
    log(`creating user ${EDITOR}...`);
    wp(['user', 'create', EDITOR, 'wp2p-editor@example.invalid', '--role=editor', '--porcelain']);
  } else wp(['user', 'set-role', EDITOR, 'editor']);

  // Rotate: remove any previous fixture password, create a fresh one.
  const list = wp(['user', 'application-password', 'list', EDITOR, '--fields=uuid,name', '--format=json']);
  for (const e of JSON.parse(list.out || '[]')) {
    if (e.name === APP_PW_NAME) wp(['user', 'application-password', 'delete', EDITOR, e.uuid]);
  }
  const pw = wp(['user', 'application-password', 'create', EDITOR, APP_PW_NAME, '--porcelain']).out;
  if (!pw) throw new Error('application password creation returned nothing');
  updateEnv({ HACKED_WP_URL: SITE_URL, HACKED_WP_USER: EDITOR, HACKED_WP_APP_PASSWORD: pw });
  log('wrote HACKED_WP_URL, HACKED_WP_USER, HACKED_WP_APP_PASSWORD to .env (value not shown)');
  log('done');
}

main().catch((e) => { console.error(`[fixture-hacked-seed] FAILED: ${e.message}`); process.exit(1); });
