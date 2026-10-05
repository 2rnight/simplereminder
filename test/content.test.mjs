import { fileURLToPath } from 'node:url';
import path from 'node:path';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
import fs from 'fs'; import vm from 'vm';
const src = fs.readFileSync(path.join(SRC,'content.js'),'utf8');

const log = { add:0, remove:0, winAdd:0, winRemove:0, appended:0, removed:0, observe:0, disconnect:0 };
const el = () => ({ style:{}, classList:{add(){},remove(){},contains:()=>false},
  setAttribute(){}, appendChild(){}, append(){}, remove(){ log.removed++ },
  addEventListener(){}, removeEventListener(){}, attachShadow:()=>({append(){}}),
  focus(){}, close(){}, showModal(){}, get isConnected(){ return true }, open:false });

const ctx = {
  console,
  setTimeout, clearTimeout,
  requestAnimationFrame: (f)=>{ f(0); return 1 },
  MutationObserver: class { observe(){ log.observe++ } disconnect(){ log.disconnect++ } },
  document: { createElement: el, documentElement: { appendChild(){ log.appended++ } },
              addEventListener(){}, removeEventListener(){} },
  chrome: {
    runtime: { id:'fakeid', getURL:(p)=>'chrome-extension://fakeid/'+p },
    storage: { local:{ get: async()=>({}) },
               onChanged:{ addListener(){ log.add++ }, removeListener(){ log.remove++ } } },
  },
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
ctx.window.addEventListener    = (...a)=>{ log.winAdd++ };
ctx.window.removeEventListener = (...a)=>{ log.winRemove++ };

let pass=0,fail=0;
const ok=(c,m)=>{c?pass++:fail++;console.log((c?'✓ ':'✗ ')+m);};

// 第 1 次注入(模拟 manifest 声明式)
vm.runInContext(src, ctx);
ok(log.add===1 && log.winAdd===1, '第 1 次注入:各注册 1 个监听器');
ok(typeof ctx.window.__SR_TEARDOWN__==='function', '暴露了 __SR_TEARDOWN__');

// 第 2 次注入(模拟 background 补注入命中同一文档)
vm.runInContext(src, ctx);
ok(log.remove===1 && log.winRemove===1, '第 2 次注入先把旧实例的监听器摘掉');
ok(log.add===2 && log.winAdd===2, '然后注册自己的监听器(总数仍是各 1 个活的)');
ok(typeof ctx.window.__SR_TEARDOWN__==='function', '__SR_TEARDOWN__ 被新实例接管');

// 第 3 次:确认不会累积
vm.runInContext(src, ctx);
ok(log.add-log.remove===1, '注入 3 次后,storage 活监听器仍只有 1 个');
ok(log.winAdd-log.winRemove===1, '注入 3 次后,message 活监听器仍只有 1 个');

// 上下文失效:chrome.runtime.id 没了,旧实例不应抛异常
ctx.chrome.runtime.id = undefined;
let threw=false;
try { ctx.window.__SR_TEARDOWN__(); } catch(e){ threw=true; console.log(e.message); }
ok(!threw, '上下文失效后调用 teardown 不抛异常');

console.log(`\n${fail?'✗':'✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
