import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
};
try {
  if (git('status', '--porcelain')) throw new Error('请先提交全部改动；部署必须来自已提交的源码。');
  if (git('branch', '--show-current') !== 'main') throw new Error('请从 main 分支发布。');
  const remote = git('remote', 'get-url', 'origin');
  if (!/^(https:\/\/github\.com\/tqluffy\/zjsy(?:\.git)?|git@github\.com:tqluffy\/zjsy(?:\.git)?)$/.test(remote)) throw new Error('origin 必须指向 tqluffy/zjsy。');
  const revision = git('rev-parse', 'HEAD');
  run('git', ['push', 'origin', 'main']);
  const published = git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0];
  if (published !== revision) throw new Error('GitHub main 与本地提交不一致，停止部署。');
  run(process.execPath, ['scripts/build.mjs']);
  run('wrangler', ['deploy', '--tag', revision.slice(0, 7), '--message', `Source: https://github.com/tqluffy/zjsy/commit/${revision}`]);
  console.log(`Published GitHub commit ${revision} to https://zjsy.zhtianqi.cn`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
