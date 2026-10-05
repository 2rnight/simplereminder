#!/usr/bin/env node
/**
 * SimpleReminder 测试入口 —— 零依赖,直接 `node test/run.mjs`。
 *
 * 每个测试文件都要往 globalThis 挂一套自己的假 chrome API,所以必须
 * 各自跑在独立进程里,否则互相污染。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();

let failed = 0;
for (const f of files) {
  console.log(`\n\x1b[1m━━━ ${f} ━━━\x1b[0m`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log(
  failed
    ? `\n\x1b[31m✗ ${failed}/${files.length} 个测试文件失败\x1b[0m`
    : `\n\x1b[32m✓ 全部 ${files.length} 个测试文件通过\x1b[0m`,
);
process.exit(failed ? 1 : 0);
