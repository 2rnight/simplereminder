import { fileURLToPath } from 'node:url';
import path from 'node:path';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
/* 集成层测试:假 chrome + 可控时钟,跑真实 background.js */
let NOW = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => NOW;

const L = {};                       // 顶层注册的监听器
const mem = { sync:{}, local:{}, session:{} };
const changeListeners = [];
const alarms = new Map();
const badge = { text:null, color:null };
const idleCfg = { seconds:null, state:'active' };
const timers = [];                  // 捕获 setTimeout,避免真的等
globalThis.setTimeout = (fn,ms)=>{ timers.push({fn,at:NOW+ms}); return timers.length; };
globalThis.clearTimeout = (id)=>{ if(id) timers[id-1]=null; };

function mkArea(name){
  return {
    async get(k){ return (k in mem[name]) ? {[k]:mem[name][k]} : {}; },
    async set(o){
      const ch={};
      for(const [k,v] of Object.entries(o)){ ch[k]={oldValue:mem[name][k], newValue:v}; mem[name][k]=v; }
      for(const f of changeListeners) f(ch, name);
    },
  };
}
globalThis.chrome = {
  storage:{ sync:mkArea('sync'), local:mkArea('local'), session:mkArea('session'),
            onChanged:{ addListener(f){ changeListeners.push(f); } } },
  runtime:{ onStartup:{addListener(f){L.startup=f}}, onInstalled:{addListener(f){L.installed=f}},
            onMessage:{addListener(f){L.msg=f}}, getManifest:()=>({version:'0.1.0'}),
            getURL:p=>'chrome-extension://fake/'+p, id:'fake' },
  alarms:{ onAlarm:{addListener(f){L.alarm=f}},
           async clear(n){ return alarms.delete(n); },
           async get(n){ return alarms.get(n); },
           async create(n,o){ alarms.set(n,o); } },
  action:{ onClicked:{addListener(f){L.click=f}},
           async setBadgeText(o){ badge.text=o.text; },
           async setBadgeBackgroundColor(o){ badge.color=o.color; } },
  idle:{ onStateChanged:{addListener(f){L.idle=f}},
         setDetectionInterval(s){ idleCfg.seconds=s; },
         async queryState(){ return idleCfg.state; } },
  tabs:{ query:async()=>[] },
  scripting:{ executeScript:async()=>{} },
};

const bg = await import(path.join(SRC,'background.js'));
const settle = async () => { for(let i=0;i<60;i++) await Promise.resolve(); await new Promise(r=>realNow&&process.nextTick(r)); for(let i=0;i<60;i++) await Promise.resolve(); };
const send = (m) => new Promise(res => { const r=L.msg(m,{},res); if(r!==true) res(); });
const rt = () => mem.local.runtime;
const stats = () => Object.values(mem.local.stats||{})[0]||{};

let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log((c?'✓ ':'✗ ')+m);};
const MIN=60_000;

await settle();
console.log('── worker 启动 ───────────────────────────');
ok(!!L.alarm && !!L.startup && !!L.installed && !!L.msg && !!L.idle,
   '五个入口都在顶层同步注册了(放进 async 会冷启动丢事件)');
ok(!L.click, 'manifest 挂了 default_popup,action.onClicked 永不触发,不该注册它');
ok(rt()?.phase==='idle' && rt().nextFireAt===NOW+20*MIN, 'worker 启动即 reconcile,排好下一轮');
ok(alarms.get('next-wake')?.when===NOW+20*MIN, '排了唯一的 next-wake 闹钟');
ok(alarms.size===2 && alarms.has('next-wake') && alarms.has('badge-tick'),
   '⭐ 只有两个闹钟:next-wake 管正确性,badge-tick 管好看');

console.log('\n── 闹钟到点 → 推进状态机 ─────────────────');
NOW += 20*MIN;
await L.alarm({name:'next-wake'}); await settle();
ok(rt().phase==='prenotice', '闹钟触发 → 进预告');
ok(alarms.get('next-wake').when===rt().prenoticeEndsAt, '闹钟重排到预告结束');
ok(timers.some(t=>t&&t.at===rt().prenoticeEndsAt+50), '8 秒 < 30 秒闹钟下限,额外挂了 fast-path 兜底');

NOW = rt().prenoticeEndsAt;
await L.alarm({name:'next-wake'}); await settle();
ok(rt().phase==='breaking', '预告结束 → 遮罩');
const ideaInBreak = rt().currentIdeaId;

console.log('\n── 跳过:埋点只记一次 ────────────────────');
NOW += 3000;
await send({type:'BREAK_FINISHED', reason:'skipped', ideaId:ideaInBreak}); await settle();
ok(rt().phase==='idle', '跳过 → 回 idle');
ok(stats()[ideaInBreak]?.skipped===1, '记了 1 次 skipped');
ok(rt().nextFireAt===NOW+20*MIN, '按正常间隔重排');

console.log('\n── 串行化:并发不会丢更新 / 重复埋点 ──────');
NOW = rt().nextFireAt; await L.alarm({name:'next-wake'}); await settle();
NOW = rt().prenoticeEndsAt; await L.alarm({name:'next-wake'}); await settle();
ok(rt().phase==='breaking','(前置)再次进入休息');
const id2 = rt().currentIdeaId;
const before = JSON.stringify(stats());
NOW = rt().breakEndsAt;
// 同一瞬间:倒计时归零的闹钟 + 用户长按跳过的上报 + 另一个标签页重复上报
await Promise.all([ L.alarm({name:'next-wake'}),
                    send({type:'BREAK_FINISHED',reason:'skipped',ideaId:id2}),
                    send({type:'BREAK_FINISHED',reason:'skipped',ideaId:id2}) ]);
await settle();
const d = (stats()[id2]?.completed||0)+(stats()[id2]?.skipped||0) - (()=>{const b=JSON.parse(before)[id2]||{};return (b.completed||0)+(b.skipped||0);})();
ok(d===1, '⭐ 三路并发结束同一次休息,埋点总共只 +1(实际 +'+d+')');
ok(rt().phase==='idle', '状态正确落到 idle');

console.log('\n── ⭐ 暂停 → 恢复(回归)──────────────────');
await send({type:'SET_PAUSE', until:NOW+30*MIN}); await settle();
ok(rt().pausedUntil===NOW+30*MIN && rt().nextFireAt===null, '暂停:清空 nextFireAt');
ok(badge.text==='||', '暂停时 badge 显示 ||');
ok(!alarms.get('badge-tick'), '暂停时停掉 badge 心跳 —— 没人在等,别每分钟唤醒 SW');

NOW += 2*MIN;
await send({type:'SET_PAUSE', until:null}); await settle();
ok(rt().pausedUntil===null, '恢复:清掉 pausedUntil');
ok(rt().nextFireAt===NOW+20*MIN,
   '⭐ 恢复**必须**重算 nextFireAt —— 不补的话 nextWake 为 null,扩展就此永久死掉');
ok(alarms.get('next-wake')?.when===NOW+20*MIN, '⭐ 恢复后真的排上了闹钟(这才是 bug 的实质)');
ok(badge.text==='20', '恢复后 badge 立刻回到倒计时');
ok(!!alarms.get('badge-tick'), '恢复后 badge 心跳也回来了');

console.log('\n── ⭐ 自然休息检测(chrome.idle)──────────');
ok(idleCfg.seconds===300, 'detectionInterval = idleResetSeconds,于是 idle 事件本身就等价于"离开够久了"');
NOW += 5*MIN;
await L.idle('idle'); await settle();
ok(rt().idleSince===NOW, '记下离开时刻');
ok(!alarms.get('badge-tick'), '人不在就停掉 badge 心跳');
const beforeAway = rt().nextFireAt;
ok(beforeAway !== null, '离开期间**不动** nextFireAt —— 该响就响,回来再重排');

NOW += 12*MIN;                                  // 离开期间周期早就过了
await L.idle('active'); await settle();
ok(rt().idleSince===null, '回来了');
ok(rt().nextFireAt===NOW+20*MIN,
   '⭐ 回来 = 已经休息过了,整轮重排 —— 不能一回来就糊一脸');
ok(rt().phase==='idle' && rt().currentIdeaId===null, '现场清理干净');
ok(!!alarms.get('badge-tick'), 'badge 心跳恢复');

// 回来时正好盖着遮罩 → 一并撤掉
await send({type:'START_BREAK'}); await settle();
ok(rt().phase==='breaking', '(前置)遮罩盖上了');
await L.idle('idle'); await settle();
NOW += 6*MIN;
await L.idle('active'); await settle();
ok(rt().phase==='idle', '⭐ 离开期间盖上的遮罩,回来时撤掉 —— 他刚休息完');

console.log('\n── badge ─────────────────────────────────');
NOW = rt().nextFireAt - 7*MIN; await L.alarm({name:'badge-tick'}); await settle();
ok(badge.text==='7', 'badge 心跳只重画,不碰状态');
ok(rt().phase==='idle', '心跳没有引发任何状态迁移');
NOW = rt().nextFireAt; await L.alarm({name:'next-wake'}); await settle();
ok(badge.text==='!', '预告相位 badge 显示 !');
ok(!alarms.get('badge-tick'), '非 idle 相位不跑心跳');
NOW = rt().prenoticeEndsAt; await send({type:'RECONCILE'}); await settle();
ok(badge.text==='', '遮罩期间 badge 留空 —— 屏幕已经被盖住了,没人看');
NOW = rt().breakEndsAt;
await send({type:'BREAK_FINISHED', reason:'completed', ideaId:rt().currentIdeaId}); await settle();

console.log('\n── 页面侧推一把(RECONCILE)──────────────');
// 预告 8 秒 < alarm 下限 30 秒,闹钟管不了这个过渡,必须由页面触发
NOW = rt().nextFireAt; await L.alarm({name:'next-wake'}); await settle();
ok(rt().phase==='prenotice','(前置)处于预告');
NOW = rt().prenoticeEndsAt;
await send({type:'RECONCILE'}); await settle();
ok(rt().phase==='breaking', '⭐ 页面侧 RECONCILE 推进了预告→休息(闹钟够不着的过渡)');
const snap = JSON.stringify(rt());
await Promise.all([send({type:'RECONCILE'}), send({type:'RECONCILE'})]); await settle();
ok(JSON.stringify(rt())===snap, '多个标签页同时推 → 幂等,状态不变');
NOW = rt().breakEndsAt;
await send({type:'BREAK_FINISHED', reason:'completed', ideaId:rt().currentIdeaId}); await settle();

console.log('\n── settings 变更 ─────────────────────────');
const beforeFire = rt().nextFireAt;
await chrome.storage.sync.set({settings:{...(mem.sync.settings||{}), intervalMinutes:5}});
await settle();
ok(rt().nextFireAt===NOW+5*MIN, '⭐ 间隔改 5 分钟 → 立刻从现在重算,不用等完旧的 20 分钟');
ok(rt().nextFireAt!==beforeFire, '确实变了');

console.log('\n── 无回声循环 ────────────────────────────');
let writes=0; const origSet=chrome.storage.local.set;
chrome.storage.local.set = async (o)=>{ writes++; return origSet(o); };
await L.alarm({name:'next-wake'}); await settle();
ok(writes<=1, '⭐ 一次 reconcile 最多写一次 local(没有写→onChanged→再写的回声循环),实际 '+writes);

console.log('\n── 暂停 ──────────────────────────────────');
await send({type:'SET_PAUSE', until:NOW+30*MIN}); await settle();
ok(rt().pausedUntil===NOW+30*MIN && alarms.get('next-wake').when===NOW+30*MIN, '暂停 → 闹钟只排到恢复时刻');
await send({type:'SET_PAUSE', until:bg.PAUSE_FOREVER}); await settle();
ok(alarms.size===0, '⭐ 无限期暂停 → 闹钟被清掉,不再空转');
await send({type:'START_BREAK'}); await settle();
ok(rt().phase==='breaking' && rt().pausedUntil===null, '「立即休息」解除暂停并直接进遮罩');

console.log(`\n${fail?'✗':'✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
