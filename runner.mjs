#!/usr/bin/env node
/**
 * OPERAQ STORE APPS · the build machine's side of a build (GitHub Actions, .github/workflows/operaq-app-build.yml, public repo).
 *
 *   node runner.mjs claim  <api,api…> [id]           take build <id> (or the next waiting one) → GitHub outputs api, job_id, platform
 *   node runner.mjs get    <api> <id> <job.json>     the job with the company's store keys (keys and names masked in the log)
 *   node runner.mjs status <api> <id> <status> [msg] building | uploaded | needs_first_upload | needs_app_record | failed
 *   node runner.mjs send   <api> <id> <what> <file>  keystore | ios-signing (JSON) | artifact (.aab / .ipa) back to OperaQ
 *   node runner.mjs play   <job.json> <app.aab>      upload to Google Play (the job's track) with the company's service account
 *
 * <api> is https://operaq.app or https://staging.operaq.app (or http://127.0.0.1:<port> in tests); the build token
 * (env OPERAQ_BUILD_TOKEN) is never sent anywhere else.
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ALLOWED = /^(https:\/\/(staging\.)?operaq\.app|http:\/\/127\.0\.0\.1:\d+)$/;

export function apiBase(api) {
  const a = String(api || '').replace(/\/+$/, '');
  if (!ALLOWED.test(a)) throw new Error(`Not an OperaQ server: ${api}`);
  return `${a}/api/operaq/build-runner`;
}

async function call(api, path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const token = process.env.OPERAQ_BUILD_TOKEN;
  if (!token) throw new Error('OPERAQ_BUILD_TOKEN is not set');
  const r = await fetchImpl(`${apiBase(api)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(`OperaQ answered ${r.status}: ${data.message || data.code || 'error'}`);
  return data;
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

/** Every secret of the job is hidden in the GitHub log before anything is printed. */
export function secretsOf(job) {
  const out = [];
  const a = job.android || {}; const i = job.ios || {};
  if (a.keystore) out.push(a.keystore.base64, a.keystore.password);
  if (a.serviceAccountJson) { out.push(a.serviceAccountJson); try { out.push(JSON.parse(a.serviceAccountJson).private_key); } catch { /* checked on save */ } }
  if (i.apiKey) out.push(i.apiKey.p8);
  if (i.signing) out.push(i.signing.p12, i.signing.password);
  if (a.googleServices) out.push(a.googleServices, ...googleServicesValues(a.googleServices));
  return out.filter((s) => typeof s === 'string' && s.length > 3).flatMap((s) => s.split('\n').filter((l) => l.trim().length > 3));
}

/** Every value of the company's Firebase file (google-services.json): API keys, project and app ids, bucket, client ids. */
export function googleServicesValues(raw) {
  let g;
  try { g = JSON.parse(String(raw).trim().startsWith('{') ? String(raw) : Buffer.from(String(raw), 'base64').toString('utf8')); } catch { return []; }
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(g);
  return out;
}

/**
 * This repo is PUBLIC (free GitHub minutes), so anyone can read its build logs: everything that names the company is hidden
 * too (app name, store id, addresses, Apple team and key ids). Short values (3 characters or less) cannot be masked usefully.
 */
export function identifiersOf(job) {
  const i = job.ios || {};
  const out = [job.appName, job.appId, job.startUrl, ...(job.hosts || []).filter((h) => !/(^|\.)operaq\.app$/.test(h)), i.teamId, i.apiKey && i.apiKey.keyId, i.apiKey && i.apiKey.issuerId];
  try {
    const u = new URL(job.startUrl);
    if (!/(^|\.)operaq\.app$/.test(u.hostname)) out.push(u.hostname); // a company's own domain; OperaQ's own address stays readable
    if (u.pathname.length > 4) out.push(u.pathname);
  } catch { /* checked in prepare */ }
  for (const id of [job.appId]) if (typeof id === 'string') out.push(...id.split('.').filter((part) => part.length > 3 && !['operaq', 'driver', 'staff', 'customer'].includes(part)));
  return [...new Set(out.filter((s) => typeof s === 'string' && s.trim().length > 3))];
}

/* ── Google Play (androidpublisher v3) ──────────────────────────────────────────────────────────────────────── */

export function serviceAccountJwt(sa, now = Math.floor(Date.now() / 1000)) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const claims = enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key).toString('base64url');
  return `${head}.${claims}.${sig}`;
}

export async function playUpload(job, aab, fetchImpl = fetch) {
  const sa = JSON.parse(job.android.serviceAccountJson);
  const tok = await fetchImpl(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountJwt(sa) }).toString(),
  }).then((r) => r.json());
  if (!tok.access_token) return { status: 'failed', message: 'Google did not accept the service account key. Upload a new key in Phone apps › Google Play.' };
  const auth = { Authorization: `Bearer ${tok.access_token}` };
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(job.appId)}`;
  const edit = await fetchImpl(`${base}/edits`, { method: 'POST', headers: auth });
  const e = await edit.json().catch(() => ({}));
  if (edit.status === 404 || edit.status === 403) {
    return { status: 'needs_first_upload', message: 'Google Play does not know this app yet, or the service account has no access to it. Upload the first build by hand in Play Console (download it in Phone apps), and invite the service account under Users and permissions.' };
  }
  if (!edit.ok) return { status: 'failed', message: `Google Play: ${(e.error && e.error.message) || edit.status}` };
  const up = await fetchImpl(`https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${encodeURIComponent(job.appId)}/edits/${e.id}/bundles?uploadType=media`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: aab,
  });
  const b = await up.json().catch(() => ({}));
  if (!up.ok) return { status: 'failed', message: `Google Play did not take the build: ${(b.error && b.error.message) || up.status}` };
  const track = job.android.track || 'internal';
  const release = async (status) => {
    const t = await fetchImpl(`${base}/edits/${e.id}/tracks/${track}`, {
      method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ track, releases: [{ name: `${job.version} (${job.buildNumber})`, versionCodes: [String(b.versionCode)], status }] }),
    });
    if (!t.ok) return t;
    return fetchImpl(`${base}/edits/${e.id}:commit`, { method: 'POST', headers: auth });
  };
  let done = await release('completed');
  let draft = false;
  if (!done.ok) {
    const err = await done.json().catch(() => ({}));
    if (!/draft/i.test(JSON.stringify(err))) return { status: 'failed', message: `Google Play: ${(err.error && err.error.message) || done.status}` };
    done = await release('draft'); draft = true;
    if (!done.ok) { const err2 = await done.json().catch(() => ({})); return { status: 'failed', message: `Google Play: ${(err2.error && err2.error.message) || done.status}` }; }
  }
  return { status: 'uploaded', message: draft ? `Uploaded to the ${track} track as a draft (the app is still a draft in Play Console).` : `Uploaded to the ${track} track.`, versionCode: b.versionCode };
}

/* ── command line ───────────────────────────────────────────────────────────────────────────────────────────── */

async function main([cmd, ...a]) {
  if (cmd === 'claim') {
    for (const api of String(a[0]).split(',').filter(Boolean)) {
      try {
        const { job } = await call(api, '/claim', { method: 'POST', body: a[1] ? { id: a[1] } : {} });
        if (job) { output('api', api); output('job_id', job.id); output('platform', job.platform); return; }
      } catch (err) { console.log(`${api}: ${err.message}`); }
    }
    output('api', ''); output('job_id', ''); output('platform', '');
    return;
  }
  if (cmd === 'get') {
    const { job } = await call(a[0], `/jobs/${encodeURIComponent(a[1])}`);
    for (const s of [...secretsOf(job), ...identifiersOf(job)]) console.log(`::add-mask::${s}`);
    writeFileSync(a[2], JSON.stringify(job));
    console.log(`Job ${job.id}: ${job.platform} ${job.kind} app, version ${job.version} (${job.buildNumber})`);
    return;
  }
  if (cmd === 'status') {
    await call(a[0], `/jobs/${encodeURIComponent(a[1])}/status`, { method: 'POST', body: { status: a[2], message: a.slice(3).join(' ').slice(0, 2000), runUrl: process.env.RUN_URL || '' } });
    return;
  }
  if (cmd === 'send') {
    const data = readFileSync(a[3]);
    await call(a[0], `/jobs/${encodeURIComponent(a[1])}/${a[2]}`, { method: 'POST', body: a[2] === 'artifact' ? { name: a[3].split('/').pop(), base64: data.toString('base64') } : JSON.parse(data.toString('utf8')) });
    return;
  }
  if (cmd === 'play') {
    const job = JSON.parse(readFileSync(a[0], 'utf8'));
    const res = await playUpload(job, readFileSync(a[1]));
    console.log(res.message);
    writeFileSync('play-result.json', JSON.stringify(res));
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}
