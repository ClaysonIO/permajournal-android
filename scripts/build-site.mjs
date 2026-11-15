// Builds the GitHub Pages site into _site/: copies site/ and fills in the
// repository name and the latest release (version, date, APK link and size).
// REPO is "owner/name"; RELEASE is the JSON from
// `gh release view --json tagName,publishedAt,url,assets`, or empty if there
// is no release yet.
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '_site');
const repo = process.env.REPO || 'ClaysonIO/permajournal-android';
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Bad REPO: ${repo}`);

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let release = null;
try {
  release = JSON.parse(process.env.RELEASE || 'null');
} catch {
  console.warn('RELEASE is not valid JSON; building without a latest release.');
}

const releases = `https://github.com/${repo}/releases/latest`;
let button = `<a class="btn primary" href="${releases}">Get the latest release<small>Android APK</small></a>`;
let note = 'Android 7 or newer. The app is installed from an APK file, not from the Play Store.';
if (release?.tagName) {
  const apk = release.assets?.find((a) => a.name.endsWith('.apk'));
  const version = escape(release.tagName.replace(/^v/, ''));
  const date = new Date(release.publishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const size = apk ? ` · ${Math.round(apk.size / 1e6)} MB` : '';
  button = `<a class="btn primary" href="${escape(apk?.url ?? release.url)}">Download for Android<small>Version ${version}${size}</small></a>`;
  note = `Latest release: <a href="${escape(release.url)}">${version}</a>, ${escape(date)}. Android 7 or newer; installed from an APK file, not from the Play Store.`;
}

await rm(out, { recursive: true, force: true });
await cp(join(root, 'site'), out, { recursive: true });
const html = (await readFile(join(out, 'index.html'), 'utf8'))
  .replaceAll('__REPO__', repo)
  .replace('<!-- LATEST -->', button)
  .replace('<!-- LATEST_NOTE -->', note);
await writeFile(join(out, 'index.html'), html);
console.log(`Built _site for ${repo}${release?.tagName ? ` at ${release.tagName}` : ' (no release yet)'}`);
