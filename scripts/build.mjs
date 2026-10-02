import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let revision = 'development';
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { /* An uncommitted local preview has no source revision yet. */ }
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
// Copy contents without preserving Unix file modes. Windows/WSL mounts may
// allow writing files while rejecting chmod performed by fs.cp/copyFile.
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
const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
await writeFile(new URL('../dist/index.html', import.meta.url), html.replaceAll('__BUILD_REVISION__', revision).replaceAll('__BUILD_SHORT__', revision.slice(0, 7)));
await writeFile(new URL('../dist/build.json', import.meta.url), JSON.stringify({ revision, repository: 'https://github.com/tqluffy/zjsy', version: '1.0.0' }, null, 2) + '\n');
console.log(`Built static assets from ${revision}. No runtime dependencies.`);
