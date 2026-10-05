import { fileURLToPath } from 'node:url';
import path from 'node:path';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
import { reconcileState, postponeState, startBreakState, endBreakState,
         setPauseState, computeNextWake, drawIdea, PAUSE_FOREVER, STALE_MS }
  from '../src/lib/scheduler.js';
import { DEFAULT_SETTINGS, DEFAULT_RUNTIME } from '../src/lib/storage.js';

let pass=0, fail=0;
const ok=(c,m)=>{ c?pass++:fail++; console.log((c?'✓ ':'✗ ')+m); };
const S = (o={}) => ({...DEFAULT_SETTINGS, ...o});
const R = (o={}) => ({...DEFAULT_RUNTIME, ...o});
const rnd = () => 0.42;                       // 固定随机,结果可复现
const MIN=60_000, T0=1_700_000_000_000;

console.log('── 基本周期 ───────────────────────────────');
let r = reconcileState(T0, S(), R());
ok(r.rt.phase==='idle' && r.rt.nextFireAt===T0+20*MIN, '空状态 → 排 20 分钟后');
ok(r.nextWake===T0+20*MIN, 'nextWake = nextFireAt');

r = reconcileState(T0+10*MIN, S(), r.rt);
ok(r.rt.phase==='idle' && r.events.length===0, '未到点 → 什么都不做');

r = reconcileState(T0+20*MIN, S(), r.rt, {random:rnd});
ok(r.rt.phase==='prenotice', '到点 → 进预告');
ok(r.rt.currentIdeaId!==null, '预告时已抽好内容(background 决定,不是页面)');
ok(r.rt.prenoticeEndsAt===T0+20*MIN+8000, '预告 8 秒');
const ideaA = r.rt.currentIdeaId;

const t2 = T0+20*MIN+8000;
r = reconcileState(t2, S(), r.rt);
ok(r.rt.phase==='breaking', '预告结束 → 进休息');
ok(r.rt.breakEndsAt-r.rt.breakStartedAt===20000, '休息 20 秒');
ok(r.rt.currentIdeaId===ideaA, '内容没变');

const t3 = t2+20000;
r = reconcileState(t3, S(), r.rt);
ok(r.rt.phase==='idle', '休息结束 → 回 idle');
ok(r.rt.nextFireAt===t3+20*MIN, '下一轮按正常间隔排');
ok(r.rt.currentIdeaId===null && r.rt.breakEndsAt===null, '现场清理干净');

console.log('\n── 幂等 ───────────────────────────────────');
let a = reconcileState(T0+20*MIN, S(), R({nextFireAt:T0}), {random:rnd});
let b = reconcileState(T0+20*MIN, S(), a.rt, {random:rnd});
ok(JSON.stringify(a.rt)===JSON.stringify(b.rt), '同一时刻连调两次,状态不变');
ok(b.events.length===0, '第二次不产生事件(不会重复埋点)');

console.log('\n── 补齐:一次调用跨多级过渡 ────────────────');
// 预告中 SW 挂掉,40 秒后才醒 —— 应补齐 预告→休息,且休息是完整的
r = reconcileState(T0+40000, S(), R({phase:'prenotice', prenoticeEndsAt:T0+8000, currentIdeaId:'stand'}));
ok(r.rt.phase==='breaking', 'SW 迟到 40 秒 → 补齐进入休息');
ok(r.rt.breakEndsAt-r.rt.breakStartedAt===20000, '⭐ 休息时长没被调度延迟吃掉,仍是完整 20 秒');

// idle 迟到 40 秒 → 应照常进预告,且预告是完整的 8 秒
r = reconcileState(T0+40000, S(), R({nextFireAt:T0}), {random:rnd});
ok(r.rt.phase==='prenotice' && r.rt.prenoticeEndsAt===T0+40000+8000,
   '⭐ 预告迟到也给满 8 秒(否则可能只闪 1 秒就黑屏)');

console.log('\n── 睡过去了:绝不能一醒来就黑屏 ────────────');
r = reconcileState(T0+3*3600_000, S(), R({nextFireAt:T0}));
ok(r.rt.phase==='idle', '睡 3 小时后醒来 → 不补放,仍是 idle');
ok(r.events.some(e=>e.type==='cycle-reset'), '产生 cycle-reset 事件');
ok(r.rt.nextFireAt===T0+3*3600_000+20*MIN, '重新起算 20 分钟');

r = reconcileState(T0+3*3600_000, S(), R({phase:'prenotice', prenoticeEndsAt:T0+8000, currentIdeaId:'stand'}));
ok(r.rt.phase==='idle' && r.rt.currentIdeaId===null,
   '⭐ 预告期间睡 3 小时 → 醒来不黑屏(最经典差评场景)');

r = reconcileState(T0+3*3600_000, S(), R({phase:'breaking', breakStartedAt:T0, breakEndsAt:T0+20000, currentIdeaId:'stand'}));
ok(r.rt.phase==='idle', '休息期间睡 3 小时 → 休息判定为已结束');
ok(r.rt.nextFireAt===T0+3*3600_000+20*MIN, '⭐ 从 now 起算而非 breakEndsAt,否则醒来立刻又响');

// STALE 边界
r = reconcileState(T0+STALE_MS-1000, S(), R({nextFireAt:T0}), {random:rnd});
ok(r.rt.phase==='prenotice', 'STALE 边界内(差 1 秒)→ 照常提醒');
r = reconcileState(T0+STALE_MS+1000, S(), R({nextFireAt:T0}));
ok(r.rt.phase==='idle', 'STALE 边界外 → 重置周期');

console.log('\n── 延迟 ───────────────────────────────────');
let p = reconcileState(T0, S(), R({nextFireAt:T0}), {random:rnd});
ok(p.rt.phase==='prenotice','(前置)构造出预告态');
const ideaB = p.rt.currentIdeaId;
p = postponeState(T0+3000, S(), p.rt);
ok(p.rt.phase==='idle' && p.rt.postponeCount===1, '预告期延迟 → 回 idle,计数 1');
ok(p.rt.nextFireAt===T0+3000+5*MIN, '延迟 5 分钟');
ok(p.rt.currentIdeaId===ideaB, '⭐ 延迟保留原内容(已剧透过,换掉会显得随机)');

let p2 = reconcileState(p.rt.nextFireAt, S(), p.rt, {random:rnd});
ok(p2.rt.phase==='prenotice', '延迟后仍然有预告(不是直接黑屏)');
ok(p2.rt.postponeCount===1, '⭐ 重新预告时延迟计数不被清零(角标要显示 ×N)');
p2 = postponeState(p2.rt.nextFireAt, S(), p2.rt);
ok(p2.rt.postponeCount===2, '再延迟一次 → ×2');
ok(postponeState(T0, S(), R({phase:'breaking'})).rt.postponeCount===0, '遮罩已盖上时延迟无效');

// 计数在休息真的发生后归零
let z = reconcileState(p2.rt.nextFireAt, S(), p2.rt, {random:rnd});
z = reconcileState(z.rt.prenoticeEndsAt, S(), z.rt);
z = reconcileState(z.rt.breakEndsAt, S(), z.rt);
ok(z.rt.postponeCount===0, '休息真的发生后,延迟计数归零');

console.log('\n── 跳过 / 立即休息 ────────────────────────');
let k = reconcileState(T0, S(), R({nextFireAt:T0}), {random:rnd});
k = reconcileState(k.rt.prenoticeEndsAt, S(), k.rt);
const tk = k.rt.breakStartedAt+1000;
let k2 = endBreakState(tk, S(), k.rt, 'skipped');
ok(k2.rt.phase==='idle', '跳过 → 回 idle');
ok(k2.rt.nextFireAt===tk+20*MIN, '⭐ 跳过后按【正常】间隔重排,没有减半惩罚');
ok(k2.events[0].type==='break-end:skipped', '事件带 skipped,埋点能分开记');
ok(endBreakState(tk+1, S(), k2.rt, 'skipped').events.length===0, '重复上报 → 无事件(不重复埋点)');

let s1 = startBreakState(T0, S(), R(), {random:rnd});
ok(s1.rt.phase==='breaking' && s1.rt.prenoticeEndsAt===null, '立即休息 → 跳过预告直接进遮罩');
ok(startBreakState(T0+1, S(), s1.rt).events.length===0, '休息中再点「立即休息」是幂等的');

console.log('\n── 暂停 ───────────────────────────────────');
let q = setPauseState(T0, R({phase:'prenotice', prenoticeEndsAt:T0+8000, currentIdeaId:'stand'}), T0+30*MIN);
ok(q.rt.phase==='idle' && q.rt.currentIdeaId===null, '暂停会取消进行中的预告');
ok(q.nextWake===T0+30*MIN, '暂停期间只需在到期时醒来');
let q2 = reconcileState(T0+10*MIN, S(), q.rt);
ok(q2.rt.phase==='idle' && q2.rt.nextFireAt===null, '暂停期内不排下一次');
let q3 = reconcileState(T0+30*MIN+1, S(), q.rt);
ok(q3.rt.pausedUntil===null && q3.rt.nextFireAt===T0+30*MIN+1+20*MIN, '暂停到期 → 恢复并重新起算');
ok(computeNextWake(setPauseState(T0,R(),PAUSE_FOREVER).rt)===null, '无限期暂停 → 不排闹钟');
ok(startBreakState(T0, S(), setPauseState(T0,R(),PAUSE_FOREVER).rt, {random:rnd}).rt.pausedUntil===null,
   '手动要求「立即休息」会解除暂停');

console.log('\n── 配置边界 ───────────────────────────────');
r = reconcileState(T0, S({preNoticeSeconds:0}), R({nextFireAt:T0}), {random:rnd});
ok(r.rt.phase==='breaking', '预告设为 0 → 直接进休息,不经过 prenotice');
r = reconcileState(T0, S({intervalMinutes:5}), R());
ok(r.rt.nextFireAt===T0+5*MIN, '间隔改 5 分钟生效');

console.log('\n── 洗牌袋 ─────────────────────────────────');
let bag=[], seen=[];
for(let i=0;i<6;i++){ const d=drawIdea(S(),bag); bag=d.bag; seen.push(d.ideaId); }
ok(!seen.some((v,i)=>i>1&&v===seen[i-1]&&v===seen[i-2]), '不会连抽 3 次同一条: '+seen.join(','));
ok(new Set(seen).size===2, '只在勾选的 2 条里抽');
ok(drawIdea(S({ideas:[{id:'stand',enabled:false},{id:'eyes',enabled:false},{id:'water',enabled:false}]}),[]).ideaId,
   '全部取消勾选(存储被改坏)→ 兜回全集而不是崩溃');

console.log('\n── 损坏状态不能把状态机卡死 ───────────────');
ok(reconcileState(T0, S(), R({phase:'prenotice', prenoticeEndsAt:null})).rt.phase==='idle', 'prenotice 缺时间戳 → 退回 idle');
ok(reconcileState(T0, S(), R({phase:'breaking', breakEndsAt:null})).rt.phase==='idle', 'breaking 缺时间戳 → 退回 idle');

console.log(`\n${fail?'✗':'✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
