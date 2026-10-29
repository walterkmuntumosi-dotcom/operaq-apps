#!/usr/bin/env node
/**
 * OPERAQ STORE APPS · prepare one company's phone app for a build (owner 2026-10-28: "Publish to App Store and Google Play").
 *
 *   node prepare.mjs <job.json> <out-dir>
 *
 * Copies shell/ into <out-dir>, writes the company's name, app id, start address, colours, icon and version into it, adds the
 * native project of job.platform (android | ios) and patches what the stores check (permissions with plain-language reasons,
 * version numbers, export compliance). The app then opens the company's own OperaQ screens (customer app, driver app, My Work);
 * Capacitor's bridge gives those screens the phone's location and camera. The job comes from the OperaQ server
 * (runner.mjs get) and holds no other company's data. Powered by OPERAQ.
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const APP_ID = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){2,}$/;
export const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** The reasons iPhone shows when the app asks (Apple rejects vague ones). */
export const REASONS = {
  driver: {
    location: 'Your location is shared with your dispatcher while you are online, so jobs near you reach you and customers see you coming.',
    camera: 'Take a photo as proof of delivery and for your driver profile.',
    photos: 'Choose a photo for proof of delivery or your driver profile.',
  },
  customer: {
    location: 'Your location fills in your pick-up address and shows places near you.',
    camera: 'Take a photo to add to your booking or your profile.',
    photos: 'Choose a photo to add to your booking or your profile.',
  },
  staff: {
    location: 'Your location is checked when you clock in or out, as your company asks.',
    camera: 'Take a photo for clock-in or for documents you send to your company.',
    photos: 'Choose a document or photo to send to your company.',
  },
};

/** Checks a job before anything is built; returns the list of problems (empty = fine). */
export function checkJob(job) {
  const bad = [];
  if (!job || typeof job !== 'object') return ['job is missing'];
  if (!['android', 'ios'].includes(job.platform)) bad.push('platform must be android or ios');
  if (!['customer', 'driver', 'staff'].includes(job.kind)) bad.push('kind must be customer, driver or staff');
  if (!APP_ID.test(String(job.appId || ''))) bad.push('appId must look like com.company.app');
  if (!job.appName || String(job.appName).length > 30) bad.push('appName is required (30 characters at most)');
  if (!VERSION.test(String(job.version || ''))) bad.push('version must look like 1.0.0');
  if (!Number.isInteger(job.buildNumber) || job.buildNumber < 1) bad.push('buildNumber must be a whole number from 1');
  let start;
  try { start = new URL(job.startUrl); } catch { bad.push('startUrl is not an address'); }
  if (start && start.protocol !== 'https:') bad.push('startUrl must be https');
  if (job.brand && !HEX.test(job.brand)) bad.push('brand must be a colour like #112233');
  if (job.background && !HEX.test(job.background)) bad.push('background must be a colour like #ffffff');
  if (job.icon && !/^data:image\/png;base64,/.test(job.icon)) bad.push('icon must be a PNG');
  return bad;
}

/** The Capacitor config of the job (the app opens startUrl; OperaQ and the company's own domain stay inside the app). */
export function capacitorConfig(job) {
  const start = new URL(job.startUrl);
  const hosts = [...new Set([start.hostname, ...(job.hosts || [])].filter(Boolean))];
  return {
    appId: job.appId,
    appName: job.appName,
    webDir: 'www',
    appendUserAgent: `OperaQApp/${job.platform} OperaQKind/${job.kind}`,
    backgroundColor: job.background || '#ffffff',
    server: { url: job.startUrl, allowNavigation: hosts, errorPath: 'offline.html' },
    android: { allowMixedContent: false },
    ios: { contentInset: 'never', limitsNavigationsToAppBoundDomains: false },
    plugins: {
      SplashScreen: { launchShowDuration: 800, launchAutoHide: true, backgroundColor: job.background || '#ffffff', showSpinner: false },
    },
  };
}

/** Android: permissions in the manifest, version in build.gradle. */
export function patchAndroid(manifest, gradle, job) {
  const perms = ['android.permission.INTERNET', 'android.permission.ACCESS_COARSE_LOCATION', 'android.permission.ACCESS_FINE_LOCATION', 'android.permission.CAMERA'];
  let m = manifest;
  for (const p of perms) {
    if (!m.includes(`"${p}"`)) m = m.replace(/(\s*)<\/manifest>/, `\n    <uses-permission android:name="${p}" />$1</manifest>`);
  }
  if (!m.includes('android.hardware.camera')) m = m.replace(/(\s*)<\/manifest>/, '\n    <uses-feature android:name="android.hardware.camera" android:required="false" />$1</manifest>');
  if (!m.includes('android.hardware.location.gps')) m = m.replace(/(\s*)<\/manifest>/, '\n    <uses-feature android:name="android.hardware.location.gps" android:required="false" />$1</manifest>');
  const g = gradle
    .replace(/versionCode\s+\d+/, `versionCode ${job.buildNumber}`)
    .replace(/versionName\s+"[^"]*"/, `versionName "${job.version}"`);
  return { manifest: m, gradle: g };
}

const plistEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** iPhone: the reasons shown when the app asks, export compliance answered (HTTPS only), portrait + landscape. */
export function patchInfoPlist(plist, job) {
  const r = REASONS[job.kind] || REASONS.customer;
  const want = {
    NSLocationWhenInUseUsageDescription: r.location,
    NSCameraUsageDescription: r.camera,
    NSPhotoLibraryUsageDescription: r.photos,
  };
  let p = plist;
  for (const [k, v] of Object.entries(want)) {
    if (p.includes(`<key>${k}</key>`)) p = p.replace(new RegExp(`(<key>${k}</key>\\s*<string>)[^<]*(</string>)`), `$1${plistEsc(v)}$2`);
    else p = p.replace(/<dict>/, `<dict>\n\t<key>${k}</key>\n\t<string>${plistEsc(v)}</string>`);
  }
  if (!p.includes('<key>ITSAppUsesNonExemptEncryption</key>')) p = p.replace(/<dict>/, '<dict>\n\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>');
  return p;
}

/** iPhone: version + build number + display name in the Xcode project. */
export function patchPbxproj(pbx, job) {
  return pbx
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${job.version};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${job.buildNumber};`)
    .replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${job.appId};`);
}

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: '1' } });
}

export function prepare(job, out) {
  const bad = checkJob(job);
  if (bad.length) throw new Error(`The app settings are not complete: ${bad.join('; ')}`);
  mkdirSync(out, { recursive: true });
  cpSync(join(here, 'shell'), out, { recursive: true, filter: (src) => !src.includes(`${'/'}node_modules`) && !/\/(android|ios)(\/|$)/.test(src.slice(join(here, 'shell').length)) });

  writeFileSync(join(out, 'www', 'app.json'), JSON.stringify({ startUrl: job.startUrl, brand: job.brand || '#111111', background: job.background || '#ffffff' }));
  writeFileSync(join(out, 'capacitor.config.json'), JSON.stringify(capacitorConfig(job), null, 2));
  mkdirSync(join(out, 'assets'), { recursive: true });
  const icon = job.icon ? Buffer.from(job.icon.split(',')[1], 'base64') : readFileSync(join(here, 'default-icon.png'));
  writeFileSync(join(out, 'assets', 'logo.png'), icon);

  run('npm', ['ci', '--no-audit', '--no-fund'], out);
  run('npx', ['cap', 'add', job.platform], out);
  const bg = job.background || '#ffffff';
  run('npx', ['capacitor-assets', 'generate', `--${job.platform}`, '--iconBackgroundColor', bg, '--splashBackgroundColor', bg, '--logoSplashScale', '0.3'], out);

  if (job.platform === 'android') {
    const mPath = join(out, 'android/app/src/main/AndroidManifest.xml');
    const gPath = join(out, 'android/app/build.gradle');
    const { manifest, gradle } = patchAndroid(readFileSync(mPath, 'utf8'), readFileSync(gPath, 'utf8'), job);
    writeFileSync(mPath, manifest); writeFileSync(gPath, gradle);
  } else {
    const pPath = join(out, 'ios/App/App/Info.plist');
    const xPath = join(out, 'ios/App/App.xcodeproj/project.pbxproj');
    writeFileSync(pPath, patchInfoPlist(readFileSync(pPath, 'utf8'), job));
    writeFileSync(xPath, patchPbxproj(readFileSync(xPath, 'utf8'), job));
  }
  run('npx', ['cap', 'sync', job.platform], out);
  console.log(`Ready: ${job.appName} (${job.appId}) ${job.version} (${job.buildNumber}) for ${job.platform}, opens ${job.startUrl}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [jobPath, out] = process.argv.slice(2);
  if (!jobPath || !out) { console.error('usage: node prepare.mjs <job.json> <out-dir>'); process.exit(2); }
  if (existsSync(join(out, 'android')) || existsSync(join(out, 'ios'))) { console.error(`${out} already holds a native project; use an empty folder`); process.exit(2); }
  try { prepare(JSON.parse(readFileSync(jobPath, 'utf8')), out); } catch (err) { console.error(err.message); process.exit(1); }
}
