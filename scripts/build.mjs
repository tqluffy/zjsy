import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let revision = 'development';
let dirtyWorkingTree = false;
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  dirtyWorkingTree = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
} catch { /* An uncommitted local preview has no source revision yet. */ }
const ciRevision = process.env.WORKERS_CI_COMMIT_SHA;
if (ciRevision) {
  if (!/^[0-9a-f]{40}$/i.test(ciRevision)) throw new Error('Invalid Workers Builds commit SHA.');
  if (revision !== 'development' && revision !== ciRevision) throw new Error('Workers Builds commit SHA does not match the checkout.');
  revision = ciRevision;
} else if (dirtyWorkingTree) revision = 'development';
if (process.env.WORKERS_CI && revision === 'development') throw new Error('Production builds require a source commit SHA.');
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
// Copy file contents without imposing source file permissions.
async function copyContents(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = new URL(entry.name + (entry.isDirectory() ? '/' : ''), source);
    const to = new URL(entry.name + (entry.isDirectory() ? '/' : ''), destination);
    if (entry.isDirectory()) await copyContents(from, to);
    else if (entry.isFile()) await writeFile(to, await readFile(from));
  }
}
await copyContents(new URL('../src/', import.meta.url), new URL('../dist/', import.meta.url));
async function stampHtml(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) await stampHtml(path);
    else if (entry.name.endsWith('.html')) {
      const html = await readFile(path, 'utf8');
      const buildUrl = revision === 'development' ? 'https://github.com/tqluffy/zjsy' : `https://github.com/tqluffy/zjsy/tree/${revision}`;
      const buildLabel = revision === 'development' ? '工作区构建' : `开源版本 ${revision.slice(0, 7)}`;
      await writeFile(path, html.replaceAll('__BUILD_URL__', buildUrl).replaceAll('__BUILD_LABEL__', buildLabel));
    }
  }
}
await stampHtml(new URL('../dist/', import.meta.url));
await writeFile(new URL('../dist/build.json', import.meta.url), JSON.stringify({ revision, repository: 'https://github.com/tqluffy/zjsy', version: '1.1.0' }, null, 2) + '\n');
console.log(`Built static assets from ${revision}. No runtime dependencies.`);
