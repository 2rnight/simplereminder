import { fileURLToPath } from 'node:url';
import path from 'node:path';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
import { reconcileState, postponeState, startBreakState, endBreakState,
         setPauseState, setIdleState, badgeFor, assertAlive,
         computeNextWake, drawIdea, PAUSE_FOREVER, STALE_MS }
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
ok(r.rt.prenoticeStartedAt===T0+20*MIN, '写下 prenoticeStartedAt(预告进度线的分母)');
const ideaA = r.rt.currentIdeaId;

const t2 = T0+20*MIN+8000;
r = reconcileState(t2, S(), r.rt);
ok(r.rt.phase==='breaking', '预告结束 → 进休息');
ok(r.rt.prenoticeStartedAt===null && r.rt.prenoticeEndsAt===null, '预告的时间戳清理干净');
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
let q = setPauseState(T0, S(), R({phase:'prenotice', prenoticeEndsAt:T0+8000, currentIdeaId:'stand'}), T0+30*MIN);
ok(q.rt.phase==='idle' && q.rt.currentIdeaId===null, '暂停会取消进行中的预告');
ok(q.nextWake===T0+30*MIN, '暂停期间只需在到期时醒来');
let q2 = reconcileState(T0+10*MIN, S(), q.rt);
ok(q2.rt.phase==='idle' && q2.rt.nextFireAt===null, '暂停期内不排下一次');
let q3 = reconcileState(T0+30*MIN+1, S(), q.rt);
ok(q3.rt.pausedUntil===null && q3.rt.nextFireAt===T0+30*MIN+1+20*MIN, '暂停到期 → 恢复并重新起算');
ok(computeNextWake(setPauseState(T0,S(),R(),PAUSE_FOREVER).rt)===null, '无限期暂停 → 不排闹钟');
ok(startBreakState(T0, S(), setPauseState(T0,S(),R(),PAUSE_FOREVER).rt, {random:rnd}).rt.pausedUntil===null,
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


console.log('\n── ⭐ 暂停 → 恢复(回归)──────────────────');
{
  let p = setPauseState(T0, S(), R({nextFireAt:T0+10*MIN}), T0+30*MIN);
  ok(p.rt.nextFireAt===null && p.nextWake===T0+30*MIN, '暂停:清空 nextFireAt,只等到期');
  let u = setPauseState(T0+5*MIN, S(), p.rt, null);
  ok(u.rt.pausedUntil===null, '恢复:清掉 pausedUntil');
  ok(u.rt.nextFireAt===T0+5*MIN+20*MIN,
     '⭐ 恢复必须重算 nextFireAt —— 不补的话扩展就此永久死掉');
  ok(u.nextWake===u.rt.nextFireAt, '⭐ 恢复后 nextWake 不是 null(bug 的实质)');
  ok(assertAlive(u)===null, '不变式成立');
  // 无限期暂停后恢复,同样要活过来
  let f = setPauseState(T0, S(), R(), PAUSE_FOREVER);
  ok(assertAlive(setPauseState(T0+3*MIN, S(), f.rt, null))===null, '无限期暂停恢复后也活着');
}

console.log('\n── ⭐ 自然休息检测 ───────────────────────');
{
  // 离开:只记时刻,不动周期
  let a = setIdleState(T0, S(), R({nextFireAt:T0+8*MIN}), 'idle');
  ok(a.rt.idleSince===T0, '记下离开时刻');
  ok(a.rt.nextFireAt===T0+8*MIN,
     '⭐ 离开期间不动 nextFireAt —— 猜"要不要暂停周期"不如回来时重排稳');
  ok(setIdleState(T0, S(), R(), 'locked').rt.idleSince===T0, '锁屏等同离开');
  ok(setIdleState(T0+MIN, S(), a.rt, 'idle').rt.idleSince===T0, '重复 idle 事件不刷新时刻');

  // 回来:整轮重排
  let b = setIdleState(T0+30*MIN, S(), a.rt, 'active');
  ok(b.rt.idleSince===null, '回来了');
  ok(b.rt.nextFireAt===T0+30*MIN+20*MIN,
     '⭐ 回来 = 已经休息过了 —— 周期从头算,不能一回来就糊一脸');
  ok(b.events.some(e=>e.type==='idle-reset'), '发 idle-reset 事件');

  // 本来就没离开过 → no-op
  let c = setIdleState(T0, S(), R({nextFireAt:T0+5*MIN}), 'active');
  ok(c.rt.nextFireAt===T0+5*MIN && c.events.length===0, '没离开过 → active 是 no-op');

  // 回来时正盖着遮罩 → 撤掉
  let d = setIdleState(T0+30*MIN, S(),
    R({phase:'breaking', breakEndsAt:T0+30*MIN+10_000, currentIdeaId:'stand', idleSince:T0}), 'active');
  ok(d.rt.phase==='idle' && d.rt.breakEndsAt===null, '⭐ 回来时撤掉遮罩 —— 他刚休息完');

  // 暂停优先
  let e = setIdleState(T0, S(), R({pausedUntil:T0+MIN}), 'idle');
  ok(e.rt.idleSince===null, '暂停中不理会 idle 事件');
}

console.log('\n── badge ─────────────────────────────────');
{
  ok(badgeFor(T0, R({nextFireAt:T0+20*MIN})).text==='20', '20 分钟 → "20"');
  ok(badgeFor(T0, R({nextFireAt:T0+30_000})).text==='1', '⭐ 不足 1 分钟向上取整 → "1",不会显示 0');
  ok(badgeFor(T0, R({nextFireAt:T0-5_000})).text==='', '已过点 → 留空');
  ok(badgeFor(T0, R({nextFireAt:null})).text==='', '还没排 → 留空');
  ok(badgeFor(T0, R({phase:'prenotice', nextFireAt:T0})).text==='!', '预告 → "!"');
  ok(badgeFor(T0, R({phase:'breaking', breakEndsAt:T0+20_000})).text==='',
     '遮罩期间留空 —— 屏幕已经盖住了,没人看 badge');
  ok(badgeFor(T0, R({pausedUntil:T0+MIN, nextFireAt:T0+5*MIN})).text==='||', '暂停 → "||"');
  ok(badgeFor(T0, R({pausedUntil:PAUSE_FOREVER})).text==='||', '无限期暂停 → "||"');
  ok(badgeFor(T0, R({pausedUntil:T0-MIN, nextFireAt:T0+5*MIN})).text==='5', '暂停已过期 → 照常倒计时');
}

console.log('\n── ⭐ 不变式扫描:没在暂停就必须有下一次唤醒 ──');
{
  /* 这一段才是真正值钱的部分。
     「恢复后 nextWake 为 null」那个 bug 的后果是扩展永久性死掉,而 UI 上
     只表现为「下次休息 --:--」—— 看起来像个显示问题。与其指望每次改调度
     时都记得检查,不如把它写成一条对**所有**迁移、**所有**状态都成立的
     不变式,新加迁移函数时自然被覆盖。 */
  const states = [
    ['空',           R()],
    ['已排期',        R({nextFireAt:T0+10*MIN})],
    ['已到点',        R({nextFireAt:T0})],
    ['过期很久',      R({nextFireAt:T0-60*MIN})],
    ['预告中',        R({phase:'prenotice', nextFireAt:T0, prenoticeStartedAt:T0, prenoticeEndsAt:T0+8000, currentIdeaId:'stand'})],
    ['休息中',        R({phase:'breaking', breakStartedAt:T0, breakEndsAt:T0+20_000, currentIdeaId:'stand'})],
    ['暂停已到期',    R({pausedUntil:T0-MIN})],
    ['刚恢复',        setPauseState(T0,S(),R({nextFireAt:T0+5*MIN}),T0+MIN).rt],
    ['离开中',        R({nextFireAt:T0+5*MIN, idleSince:T0-10*MIN})],
    ['延迟过 3 次',   R({nextFireAt:T0+MIN, postponeCount:3, currentIdeaId:'eyes'})],
  ];
  const moves = [
    ['reconcile',   (n,s,rt)=>reconcileState(n,s,rt,{random:rnd})],
    ['postpone',    postponeState],
    ['startBreak',  (n,s,rt)=>startBreakState(n,s,rt,{random:rnd})],
    ['endBreak-ok', (n,s,rt)=>endBreakState(n,s,rt,'completed')],
    ['endBreak-skip',(n,s,rt)=>endBreakState(n,s,rt,'skipped')],
    ['resume',      (n,s,rt)=>setPauseState(n,s,rt,null)],
    ['idle→走',     (n,s,rt)=>setIdleState(n,s,rt,'idle')],
    ['idle→回',     (n,s,rt)=>setIdleState(n,s,rt,'active')],
  ];
  let bad = [];
  for (const [sn, st] of states) for (const [mn, mv] of moves) {
    for (const t of [T0, T0+MIN, T0+90*MIN]) {
      const why = assertAlive(mv(t, S(), st));
      if (why) bad.push(`${sn} + ${mn} @+${(t-T0)/MIN}min:${why}`);
    }
  }
  ok(bad.length===0,
     `${states.length}×${moves.length}×3 = ${states.length*moves.length*3} 种组合,没在暂停时全都排了下一次唤醒`);
  if (bad.length) console.log('   ' + bad.slice(0,6).join('\n   '));

  // 反向:暂停状态下允许没有唤醒(无限期暂停就该清掉闹钟)
  ok(assertAlive(setPauseState(T0,S(),R(),PAUSE_FOREVER))===null,
     '无限期暂停时 nextWake 为 null 是合法的,不算违反');
}

console.log(`\n${fail?'✗':'✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
