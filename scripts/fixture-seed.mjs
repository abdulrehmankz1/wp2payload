#!/usr/bin/env node
// Seeds the local WordPress fixture (docker-compose.yml). Idempotent. No npm deps.
// Never prints the Application Password; it is only written to .env.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_URL = 'http://localhost:8080';
const CACHE_DIR = join(ROOT, 'tests', 'fixtures', 'wordpress', '.cache');

// Pinned sources (see tests/fixtures/wordpress/README.md).
const THEME_DATA_SHA = 'b47acf980696897936265182cb684dca648476c7'; // WordPress/theme-test-data
const THEME_DATA_URL = `https://raw.githubusercontent.com/WordPress/theme-test-data/${THEME_DATA_SHA}/themeunittestdata.wordpress.xml`;
const THEME_DATA_SHA256 = '457aace6ec93cf77369bbcc6158996e52da8798bd5e39c83d58dfab9b50d64fa';
const THEME_DATA_FILE = 'themeunittestdata.wordpress.xml';
const YOAST_VERSION = '28.8';
const IMPORTER_VERSION = '0.9.7';
const IMPORT_FLAG = 'wp2p_fixture_import_done';
const EDITOR = 'wp2p-editor';
const APP_PW_NAME = 'wp2p-fixture';
// Fake local-only admin credentials (fixture runs on 127.0.0.1 only).
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'fixture-admin-not-a-secret';
const YOAST_POSTS = [
  { slug: 'markup-html-tags-and-formatting', title: 'Fixture SEO title: HTML tags and formatting', desc: 'Fixture SEO description for the HTML tags and formatting post.' },
  { slug: 'markup-image-alignment', title: 'Fixture SEO title: image alignment', desc: 'Fixture SEO description for the image alignment post.' },
];

const log = (m) => console.log(`[fixture-seed] ${m}`);

function compose(args, { allowFail = false } = {}) {
  const r = spawnSync('docker', ['compose', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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

async function download() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, THEME_DATA_FILE);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  if (existsSync(file) && sha(readFileSync(file)) === THEME_DATA_SHA256) return;
  log('downloading Theme Unit Test data (pinned commit)...');
  const res = await fetch(THEME_DATA_URL, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== THEME_DATA_SHA256) throw new Error('theme unit test data sha256 mismatch; refusing to import');
  writeFileSync(file, buf);
}

function updateEnv(values) {
  const path = join(ROOT, '.env');
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(values)) {
    const idx = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
}

async function main() {
  await download();
  await waitReady();

  if (!wp(['core', 'is-installed'], { allowFail: true }).ok) {
    log('installing WordPress core...');
    wp(['core', 'install', `--url=${SITE_URL}`, '--title=wp2payload fixture', `--admin_user=${ADMIN_USER}`,
      `--admin_password=${ADMIN_PASS}`, '--admin_email=admin@example.invalid', '--skip-email']);
  } else log('core already installed');
  wp(['option', 'update', 'home', SITE_URL]);
  wp(['option', 'update', 'siteurl', SITE_URL]);

  log('setting permalinks...');
  wp(['rewrite', 'structure', '/%postname%/', '--hard']);
  wp(['rewrite', 'flush', '--hard']);

  for (const [name, ver] of [['wordpress-importer', IMPORTER_VERSION], ['wordpress-seo', YOAST_VERSION]]) {
    const cur = wp(['plugin', 'get', name, '--field=version'], { allowFail: true });
    if (!cur.ok || cur.out !== ver) {
      log(`installing ${name} ${ver}...`);
      wp(['plugin', 'install', name, `--version=${ver}`, '--force']);
    }
    wp(['plugin', 'activate', name]);
  }

  const done = wp(['option', 'get', IMPORT_FLAG], { allowFail: true });
  if (!done.ok || done.out !== THEME_DATA_SHA) {
    log('importing Theme Unit Test data (this takes a minute)...');
    wp(['import', `/fixture/${THEME_DATA_FILE}`, '--authors=create', '--quiet']);
    wp(['option', 'update', IMPORT_FLAG, THEME_DATA_SHA]);
  } else log('theme unit test data already imported; skipping');

  for (const p of YOAST_POSTS) {
    const id = wp(['post', 'list', '--post_type=post', '--post_status=publish', `--name=${p.slug}`, '--field=ID']).out.split(/\s+/)[0];
    if (!id) throw new Error(`post with slug ${p.slug} not found`);
    wp(['post', 'meta', 'update', id, '_yoast_wpseo_title', p.title]);
    wp(['post', 'meta', 'update', id, '_yoast_wpseo_metadesc', p.desc]);
    log(`Yoast meta set on post ${id} (${p.slug})`);
  }

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
  updateEnv({ WP_URL: SITE_URL, WP_USER: EDITOR, WP_APP_PASSWORD: pw });
  log('wrote WP_URL, WP_USER, WP_APP_PASSWORD to .env (value not shown)');
  log('done');
}

main().catch((e) => { console.error(`[fixture-seed] FAILED: ${e.message}`); process.exit(1); });
