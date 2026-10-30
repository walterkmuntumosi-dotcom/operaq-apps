// OperaQ store apps: the job check, the native patches and the build machine's calls (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { checkJob, capacitorConfig, patchAndroid, patchInfoPlist, patchPbxproj, patchAppDelegate, googleServicesOf, ENTITLEMENTS } from '../prepare.mjs';
import { apiBase, secretsOf, identifiersOf, serviceAccountJwt, playUpload } from '../runner.mjs';

const job = { platform: 'android', kind: 'driver', appId: 'app.operaq.acme.driver', appName: 'Acme Driver', version: '1.2.0', buildNumber: 7, startUrl: 'https://operaq.app/deliver/app/driver/acme', brand: '#0F766E', background: '#ffffff' };

test('a complete job passes; bad ids, versions and plain http are refused', () => {
  assert.deepEqual(checkJob(job), []);
  assert.ok(checkJob({ ...job, appId: 'acme' }).length);
  assert.ok(checkJob({ ...job, version: '1.2' }).length);
  assert.ok(checkJob({ ...job, startUrl: 'http://operaq.app/x' }).some((m) => /https/.test(m)));
  assert.ok(checkJob({ ...job, kind: 'admin' }).length);
});

test('the app opens the company screen, keeps its domain inside, and tells OperaQ it is the store app', () => {
  const c = capacitorConfig({ ...job, hosts: ['acme.com'] });
  assert.equal(c.server.url, job.startUrl);
  assert.deepEqual(c.server.allowNavigation, ['operaq.app', 'acme.com']);
  assert.match(c.appendUserAgent, /OperaQApp\/android OperaQKind\/driver/);
  assert.equal(c.server.errorPath, 'offline.html');
});

test('Android: permissions added once, version set', () => {
  const m = '<manifest>\n    <uses-permission android:name="android.permission.INTERNET" />\n</manifest>';
  const g = 'versionCode 1\n        versionName "1.0"';
  const out = patchAndroid(m, g, job);
  assert.equal(out.manifest.match(/android.permission.INTERNET/g).length, 1);
  assert.match(out.manifest, /ACCESS_FINE_LOCATION/);
  assert.match(out.gradle, /versionCode 7/);
  assert.match(out.gradle, /versionName "1.2.0"/);
});

test('iPhone: plain-language reasons, export compliance, version and bundle id', () => {
  const p = patchInfoPlist('<plist><dict>\n\t<key>CFBundleName</key>\n</dict></plist>', job);
  assert.match(p, /NSLocationWhenInUseUsageDescription<\/key>\s*<string>Your location is shared with your dispatcher/);
  assert.match(p, /ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  const x = patchPbxproj('MARKETING_VERSION = 1.0;\nCURRENT_PROJECT_VERSION = 1;\nPRODUCT_BUNDLE_IDENTIFIER = com.capacitorjs.app;', job);
  assert.match(x, /MARKETING_VERSION = 1.2.0;/);
  assert.match(x, /CURRENT_PROJECT_VERSION = 7;/);
  assert.match(x, /PRODUCT_BUNDLE_IDENTIFIER = app.operaq.acme.driver;/);
});

test('the build token only ever goes to an OperaQ server', () => {
  assert.equal(apiBase('https://operaq.app/'), 'https://operaq.app/api/operaq/build-runner');
  assert.equal(apiBase('https://staging.operaq.app'), 'https://staging.operaq.app/api/operaq/build-runner');
  assert.throws(() => apiBase('https://evil.example'));
  assert.throws(() => apiBase('https://operaq.app.evil.example'));
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { client_email: 'builder@acme.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' };

test('every key line is masked in the log', () => {
  const s = secretsOf({ android: { keystore: { base64: 'QUJDREVGRw==', password: 'pw-123456' }, serviceAccountJson: JSON.stringify(sa) }, ios: { apiKey: { p8: '-----BEGIN PRIVATE KEY-----\nMIGTAgEA\n-----END PRIVATE KEY-----' } } });
  assert.ok(s.includes('QUJDREVGRw=='));
  assert.ok(s.includes('pw-123456'));
  assert.ok(s.includes('MIGTAgEA'));
});

test('Google sign-in JWT is signed with the service account key', () => {
  const [h, c, sig] = serviceAccountJwt(sa, 1000).split('.');
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).iss, sa.client_email);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url')));
});

function fakeGoogle({ editStatus = 200, draftOnly = false } = {}) {
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const f = async (url, opt = {}) => {
    calls.push(`${opt.method || 'GET'} ${url.replace(/^https:\/\/[^/]+/, '')}`);
    if (url.includes('oauth2')) return res(200, { access_token: 't' });
    if (url.endsWith('/edits')) return res(editStatus, { id: 'e1' });
    if (url.includes('/bundles')) return res(200, { versionCode: 7 });
    if (url.includes('/tracks/')) {
      const body = JSON.parse(opt.body);
      if (draftOnly && body.releases[0].status !== 'draft') return res(400, { error: { message: 'Only releases with status draft may be created on draft app.' } });
      return res(200, {});
    }
    if (url.endsWith(':commit')) return res(200, {});
    return res(404, {});
  };
  return { f, calls };
}

test('Google Play: upload → internal track → commit', async () => {
  const g = fakeGoogle();
  const r = await playUpload({ ...job, android: { serviceAccountJson: JSON.stringify(sa) } }, Buffer.from('aab'), g.f);
  assert.equal(r.status, 'uploaded');
  assert.ok(g.calls.some((c) => c.startsWith('PUT') && c.includes('/tracks/internal')));
});

test('Google Play: an app still in draft gets a draft release', async () => {
  const r = await playUpload({ ...job, android: { serviceAccountJson: JSON.stringify(sa) } }, Buffer.from('aab'), fakeGoogle({ draftOnly: true }).f);
  assert.equal(r.status, 'uploaded');
  assert.match(r.message, /draft/);
});

test('Google Play: unknown app → first upload by hand', async () => {
  const r = await playUpload({ ...job, android: { serviceAccountJson: JSON.stringify(sa) } }, Buffer.from('aab'), fakeGoogle({ editStatus: 404 }).f);
  assert.equal(r.status, 'needs_first_upload');
});

test('public build log: the company name, store id, addresses and Apple ids are masked', async () => {
  const { identifiersOf } = await import('../runner.mjs');
  const ids = identifiersOf({
    appName: 'Acme Rides', appId: 'com.acmerides.driver', startUrl: 'https://operaq.app/deliver/app/driver/acmerides',
    hosts: ['rides.acme.example'], ios: { teamId: 'ABCDE12345', apiKey: { keyId: 'KEY1234567', issuerId: '1111-2222' } },
  });
  for (const v of ['Acme Rides', 'com.acmerides.driver', 'acmerides', 'rides.acme.example', 'ABCDE12345', 'KEY1234567', '1111-2222', '/deliver/app/driver/acmerides']) {
    assert.ok(ids.includes(v), v);
  }
  assert.ok(!ids.includes('driver') && !ids.includes('operaq.app'), 'generic words stay readable');
});

/* ── notifications ─────────────────────────────────────────────────────────────────────────────────────────── */

const firebase = (pkg) => Buffer.from(JSON.stringify({
  project_info: { project_number: '987654321098', project_id: 'acme-rides-push', storage_bucket: 'acme-rides-push.appspot.com' },
  client: [{ client_info: { mobilesdk_app_id: '1:987654321098:android:abcdef0123456789', android_client_info: { package_name: pkg } }, api_key: [{ current_key: 'AIzaFakeFakeFakeFakeFake' }] }],
  configuration_version: '1',
})).toString('base64');

test('notifications: Android needs the Firebase file of this very app', () => {
  const on = { ...job, push: true };
  assert.ok(checkJob(on).some((m) => /Firebase file is missing/.test(m)));
  assert.ok(checkJob({ ...on, android: { googleServices: 'not base64 json' } }).some((m) => /not valid/.test(m)));
  assert.ok(checkJob({ ...on, android: { googleServices: firebase('app.operaq.other.driver') } }).some((m) => /another app id/.test(m)));
  assert.deepEqual(checkJob({ ...on, android: { googleServices: firebase(job.appId) } }), []);
  assert.equal(googleServicesOf({ android: { googleServices: firebase(job.appId) } }).project_info.project_id, 'acme-rides-push');
  assert.deepEqual(checkJob({ ...job, platform: 'ios', push: true }), [], 'iPhone needs no Firebase file');
});

test('notifications: iPhone gets the production entitlement and hands the push address to Capacitor', () => {
  const pbx = '\t\t\t\tMARKETING_VERSION = 1.0;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.capacitorjs.app;\n\t\t\t\tSWIFT_VERSION = 5.0;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.capacitorjs.app;\n';
  const on = patchPbxproj(pbx, { ...job, platform: 'ios', push: true });
  assert.equal(on.match(/CODE_SIGN_ENTITLEMENTS = App\/App.entitlements;/g).length, 2);
  assert.equal(patchPbxproj(on, { ...job, platform: 'ios', push: true }).match(/CODE_SIGN_ENTITLEMENTS/g).length, 2, 'added once');
  assert.ok(!patchPbxproj(pbx, { ...job, platform: 'ios' }).includes('CODE_SIGN_ENTITLEMENTS'), 'no entitlement without notifications');
  assert.match(ENTITLEMENTS, /<key>aps-environment<\/key>\s*<string>production<\/string>/);
  const swift = 'import UIKit\nimport Capacitor\n\n@UIApplicationMain\nclass AppDelegate: UIResponder, UIApplicationDelegate {\n    var window: UIWindow?\n}\n';
  const d = patchAppDelegate(swift);
  assert.match(d, /didRegisterForRemoteNotificationsWithDeviceToken[\s\S]*capacitorDidRegisterForRemoteNotifications[\s\S]*capacitorDidFailToRegisterForRemoteNotifications[\s\S]*\n}\n$/);
  assert.equal(patchAppDelegate(d), d, 'patched once');
});

test('notifications: the app config asks for banners, and only when they are on', () => {
  assert.deepEqual(capacitorConfig({ ...job, push: true }).plugins.PushNotifications.presentationOptions, ['badge', 'sound', 'alert']);
  assert.equal(capacitorConfig(job).plugins.PushNotifications, undefined);
});

test('public build log: every value of the Firebase file is masked', () => {
  const j = { ...job, push: true, android: { googleServices: firebase(job.appId) } };
  const masked = [...secretsOf(j), ...identifiersOf(j)];
  for (const v of [j.android.googleServices, 'AIzaFakeFakeFakeFakeFake', '987654321098', 'acme-rides-push', 'acme-rides-push.appspot.com', '1:987654321098:android:abcdef0123456789']) {
    assert.ok(masked.includes(v), v);
  }
});
