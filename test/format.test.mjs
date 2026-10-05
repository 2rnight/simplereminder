import { remainText, clockText, toggleIdea, dailyCount } from '../src/lib/format.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '✓ ' : '✗ ') + m); };

console.log('── 剩余时间文案 ───────────────────────────');
ok(remainText(20) === '还有 20 秒', '秒');
ok(remainText(60) === '还有 1 分钟', '整分不显示 0 秒');
ok(remainText(90) === '还有 1 分 30 秒', '分 + 秒');
ok(remainText(1200) === '还有 20 分钟', '20 分钟');
ok(remainText(0) === '还有 0 秒', '归零');
ok(remainText(-5) === '还有 0 秒', '负数夹到 0(倒计时可能冲过头)');
ok(remainText(19.2) === '还有 20 秒', 'ceil:显示「还有 0 秒」却没结束会很怪');
ok(remainText(119.5) === '还有 2 分钟', '119.5s → ceil 到 120 → 整分');

console.log('\n── 时钟 ───────────────────────────────────');
const d = new Date(2026, 9, 5, 9, 7, 0);
ok(clockText(d.getTime()) === '09:07', '个位数补零');
const d2 = new Date(2026, 9, 5, 14, 32, 0);
ok(clockText(d2.getTime()) === '14:32', '下午时间');

console.log('\n── 内容勾选:不允许全部取消 ───────────────');
const three = [
  { id: 'stand', enabled: true },
  { id: 'eyes', enabled: true },
  { id: 'water', enabled: false },
];
let r = toggleIdea(three, 'water');
ok(r.ideas.find(i => i.id === 'water').enabled === true && !r.refused, '可以勾上');
r = toggleIdea(three, 'eyes');
ok(r.ideas.find(i => i.id === 'eyes').enabled === false && !r.refused, '还剩 2 条时可以取消');

const one = [
  { id: 'stand', enabled: true },
  { id: 'eyes', enabled: false },
  { id: 'water', enabled: false },
];
r = toggleIdea(one, 'stand');
ok(r.refused === true, '⭐ 最后一条拒绝取消');
ok(r.ideas === one, '拒绝时原样返回,不产生新数组');
r = toggleIdea(one, 'eyes');
ok(!r.refused && r.ideas.filter(i => i.enabled).length === 2, '最后一条锁住时,仍可勾上别的');

ok(toggleIdea(three, 'nope').refused === false, '未知 id 不崩溃');
ok(toggleIdea(three, 'stand').ideas !== three, '返回新数组,不原地修改');
ok(three.find(i => i.id === 'stand').enabled === true, '原数组未被污染');

console.log('\n── 后果预览 ───────────────────────────────');
ok(dailyCount(5) === 96, '间隔 5 分钟 → 一天约 96 次(文档里的例子)');
ok(dailyCount(20) === 24, '间隔 20 分钟 → 24 次');
ok(dailyCount(0) === 480, '0 不会除零崩溃');

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
