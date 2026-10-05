import { fileURLToPath } from 'node:url';
import path from 'node:path';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const L={}; const mem={sync:{},local:{},session:{}};
const area=(n)=>({get:async(k)=>(k in mem[n]?{[k]:mem[n][k]}:{}),set:async(o)=>Object.assign(mem[n],o)});
const injected=[];
const alarms=new Map();
globalThis.chrome={
  storage:{sync:area('sync'),local:area('local'),session:area('session'),onChanged:{addListener(){}}},
  alarms:{onAlarm:{addListener(f){L.alarm=f}},
          async clear(n){return alarms.delete(n)}, async create(n,o){alarms.set(n,o)}},
  runtime:{onInstalled:{addListener(f){L.installed=f}},onStartup:{addListener(f){L.startup=f}},
           onMessage:{addListener(f){L.msg=f}},getManifest:()=>({version:'0.1.0'}),
           getURL:p=>'chrome-extension://fake/'+p, id:'fake'},
  action:{onClicked:{addListener(f){L.click=f}}},
  tabs:{query:async()=>[
    {id:1,url:'https://news.ycombinator.com/',active:false,discarded:false},
    {id:2,url:'https://www.google.com/',       active:true, discarded:false},
    {id:3,url:'chrome://extensions/',          active:false,discarded:false},
    {id:4,url:'https://mail.google.com/',      active:false,discarded:true },
    {id:5,url:'https://chromewebstore.google.com/', active:false,discarded:false},
    {id:6,url:'https://github.com/',           active:false,discarded:false},
  ]},
  scripting:{executeScript:async({target,files})=>{
    if(target.tabId===5) throw new Error('Cannot access a chrome:// URL'); // 模拟受限页面
    injected.push(target.tabId);
  }},
};
await import(path.join(SRC,'background.js'));
await new Promise(r=>setTimeout(r,60));   // 等 worker 启动时那个 IIFE

let pass=0,fail=0;
const ok=(c,m)=>{c?pass++:fail++;console.log((c?'✓ ':'✗ ')+m);};
ok(injected.length>0, '已对打开的标签页补注入');
ok(injected[0]===2, '活动标签页排第一个注入(id=2 google): 实际 '+injected[0]);
ok(injected.includes(1)&&injected.includes(6), '普通 http(s) 标签页都注入了(HN / GitHub)');
ok(!injected.includes(3), 'chrome:// 页面被跳过');
ok(!injected.includes(4), '已丢弃(discarded)的标签页被跳过');
ok(!injected.includes(5), '受限页面抛错后不影响其它标签页');
ok(mem.session.injectedVersion==='0.1.0', '注入完成后写下 session 标记');

// worker 重启:标记还在 → 不该重复注入
const n=injected.length;
await import(path.join(SRC,'background.js?v=2'));
await new Promise(r=>setTimeout(r,60));
ok(injected.length===n, 'worker 重启且标记未变时不重复注入');

// 版本升级 → 应重新注入
mem.session.injectedVersion='0.0.9';
await import(path.join(SRC,'background.js?v=3'));
await new Promise(r=>setTimeout(r,60));
ok(injected.length>n, '版本变化后重新补注入');

console.log(`\n${fail?'✗':'✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
