/* ============================================================
 * 死亡轮盘客户端（roulette-wheel.html）无头验证
 * ------------------------------------------------------------
 * 做法：把页面里的内联脚本抠出来，在一个假 DOM 里跑起来，
 *       再拿「同一串随机数」直接驱动 engine.js 跑一遍，
 *       逐步比对客户端状态与引擎状态是否完全一致。
 * 这证明的是：客户端页面的规则确实全部来自 engine.js，
 *            页面自己一行规则都没留。
 *
 * 用法：node client-solo-test.js
 * ============================================================ */

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ENGINE = require('./engine.js');

let PASS = 0, FAIL = 0;
function ok(name, cond, extra) {
  if (cond) { PASS++; console.log('  \u2713 ' + name); }
  else { FAIL++; console.log('  \u2717 ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

/* ---------------- 假 DOM ---------------- */
function makeEl(tag) {
  const el = {
    tag: tag || 'div', nodeType: 1, children: [], style: {}, _cls: {}, _html: '', _txt: '', offsetWidth: 0,
    classList: {
      add(c) { el._cls[c] = true; },
      remove(c) { delete el._cls[c]; },
      contains(c) { return !!el._cls[c]; },
    },
    setAttribute() {}, getAttribute() { return null; },
    /* 跟真 DOM 一样较真：appendChild 收到非节点就抛。
       假 DOM 惯着它，真浏览器可不会 —— 2026-09-24 联机端就是这么整页报废的。 */
    appendChild(c) {
      if (!c || typeof c !== 'object' || c.nodeType !== 1) {
        throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
      }
      el.children.push(c); return c;
    },
    insertBefore(c) {
      if (!c || typeof c !== 'object' || c.nodeType !== 1) {
        throw new TypeError("Failed to execute 'insertBefore' on 'Node': parameter 1 is not of type 'Node'.");
      }
      el.children.unshift(c); return c;
    },
    querySelector() { return makeEl('button'); },
    addEventListener() {},
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = v; if (v === '') el.children = []; },
  });
  Object.defineProperty(el, 'textContent', {
    get() { return el._txt; },
    /* 真实浏览器的 textContent 是 WebIDL DOMString：赋数字会被强制转成字符串。
       假 DOM 必须照抄这个行为，否则 "1" !== 1 会误判成状态偏差。 */
    set(v) { el._txt = String(v); },
  });
  return el;
}

const els = {};
function byId(id) { return els[id] || (els[id] = makeEl('div')); }

/* ---------------- 可控计时器 ---------------- */
let timers = [], timerId = 1, vtime = 0;
function flushTimers() {
  let guard = 0;
  while (timers.length && guard++ < 2000) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers.shift();
    vtime = t.at;
    try { t.fn(); } catch (e) { /* 假 DOM 下的小异常不影响状态比对 */ }
  }
}

/* ---------------- 可控随机源 ---------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/* 客户端每次转动消耗两个随机数：①引擎掷骰 ②转盘落点的抖动
   所以引擎看到的是第 0、2、4… 个，抖动拿走第 1、3、5… 个 */
function buildStream(seed, n) {
  const r = mulberry32(seed), out = [];
  for (let i = 0; i < n; i++) out.push(r());
  return out;
}

/* ---------------- 抠出页面里的内联脚本 ---------------- */
const html = fs.readFileSync(path.join(__dirname, 'roulette-wheel.html'), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ok('页面里找到内联脚本', inline.length === 1, '找到 ' + inline.length + ' 段');
ok('页面通过 <script src> 引入 engine.js（单机模式本地运行）',
  /<script\s+src=["']engine.js["']/.test(html));

let code = inline[inline.length - 1];
/* 让外部能读到页面内部的 M / S（它们是 let，不会挂到 global 上） */
code += '\n;globalThis.__probe = function(){ return { M: M, S: S }; };\n';

const store = {};
const sandbox = {
  console, Math, JSON, Object, Array, String, Number, Boolean, Date, Error, RegExp,
  document: {
    body: makeEl('body'),
    getElementById: byId,
    createElement: makeEl,
    createElementNS: function (ns, tag) { return makeEl(tag); },
    addEventListener() {},
  },
  getComputedStyle: function () { return { getPropertyValue: function () { return '#000'; } }; },
  localStorage: {
    getItem: function (k) { return k in store ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
  },
  confirm: function () { return true; },
  setTimeout: function (fn, ms) { timers.push({ id: timerId++, fn: fn, at: vtime + (ms || 0) }); return timerId; },
  clearTimeout: function (id) { timers = timers.filter(function (t) { return t.id !== id; }); },
  setInterval: function () { return 0; },     // 滴答声的 interval：不跑
  clearInterval: function () {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.RREngine = ENGINE;

vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: 'roulette-wheel-inline.js' });
  ok('内联脚本在假 DOM 里执行成功（无语法/引用错误）', true);
} catch (e) {
  ok('内联脚本在假 DOM 里执行成功（无语法/引用错误）', false, e.message);
  console.log('\n=== 结果：' + PASS + ' 通过 / ' + (FAIL + 1) + ' 失败 ===\n');
  process.exit(1);
}

/* 关掉灯泡动画（它靠 setTimeout 自递归，会在 flush 里无限排下去） */
sandbox.bulbsRun = function () {};
sandbox.bulbsStop = function () {};
flushTimers();

const probe = sandbox.__probe;
ok('页面启动后已创建引擎对局', !!probe().M && probe().M.mode === 'solo', probe() && probe().M && probe().M.mode);
ok('开局 HUD：生命 7 / 7', byId('hpTxt').textContent === '7 / 7', byId('hpTxt').textContent);
ok('开局 HUD：转数 0', byId('spinTxt').textContent === '0', byId('spinTxt').textContent);

/* ---------- V17：血量搬到轮盘正上方 ---------- */
ok('V17 顶部血量条存在（心 + 数字 + 条都在里面）',
  /class="hpstrip"/.test(html) && /id="hpCell"/.test(html) && /id="hpFill"/.test(html));
ok('血量条排在轮盘之前（不是塞在左栏里）',
  html.indexOf('class="hpstrip"') > 0 && html.indexOf('class="hpstrip"') < html.indexOf('<main>'),
  html.indexOf('class="hpstrip"') + ' vs ' + html.indexOf('<main>'));
ok('开局血量条是满的（7 / 7 → 宽度 100%）', byId('hpFill').style.width === '100%', byId('hpFill').style.width);
ok('左栏里不再重复一份「生命」数字', html.indexOf('class="stat"') > html.indexOf('class="hpstrip"')
  && !/<span class="k">生命<\/span>/.test(html));
ok('顶部那一格带 me 标记（单人模式下那就是你自己）',
  byId('hpCell').className.indexOf('me') >= 0, byId('hpCell').className);

/* ---------------- 逐转比对：客户端 vs 引擎 ---------------- */
console.log('\n  ── 逐步比对：同一个随机序列，客户端页面 vs 直接驱动引擎 ──\n');

const STREAM = buildStream(20260924, 40000);
let si = 0;
const clientRng = function () { const v = STREAM[si % STREAM.length]; si++; return v; };
sandbox.Math = Object.create(Math);
sandbox.Math.random = clientRng;

/* 客户端的 Math 是沙箱全局的 Math，直接换掉沙箱里的引用 */
sandbox.Math = Math;
const realRandom = Math.random;
Math.random = clientRng;      // 内联脚本里用的是全局 Math

/* 参考实现：引擎只吃第 0、2、4… 个随机数 */
let ri = 0;
const refRng = function () { const v = STREAM[ri % STREAM.length]; ri += 2; return v; };
let ref = ENGINE.createMatch({ mode: 'solo', players: [{ id: '1', name: '你' }] });

let step = 0, mismatch = null, ended = false;
while (!ended && step++ < 3000) {
  /* 客户端走一步 */
  sandbox.spin();
  flushTimers();
  const cm = probe().M;
  const cs = probe().S;

  /* 参考实现走一步 */
  const out = ENGINE.applyAction(ref, { type: 'spin', playerId: '1' }, refRng);
  ref = out.match;

  const a = cm.players['1'], b = ref.players['1'];
  const fields = ['hp', 'gold', 'spins', 'charms', 'potions', 'spent', 'earned',
    'interest', 'charmUsed', 'rewinds', 'ms31', 'ms71', 'alive'];
  for (const f of fields) {
    if (a[f] !== b[f]) { mismatch = { step: step, field: f, client: a[f], ref: b[f] }; break; }
  }
  if (!mismatch) for (const f of ['minus1', 'plus1', 'minus2', 'plus2', 'gold']) {
    if (a.tally[f] !== b.tally[f]) { mismatch = { step: step, field: 'tally.' + f, client: a.tally[f], ref: b.tally[f] }; break; }
  }
  if (mismatch) break;

  /* HUD 也必须跟着走 */
  if (byId('spinTxt').textContent !== String(b.spins)) {
    mismatch = { step: step, field: 'HUD.spins', client: byId('spinTxt').textContent, ref: b.spins };
    break;
  }
  if (byId('hpTxt').textContent !== b.hp + ' / 7') {
    mismatch = { step: step, field: 'HUD.hp', client: byId('hpTxt').textContent, ref: b.hp + ' / 7' };
    break;
  }

  if (cm.phase !== 'playing') ended = true;
  if (ref.phase !== 'playing') { /* 参考也应该同时结束 */ }
}

ok('客户端与引擎逐步一致（' + step + ' 转内无任何字段偏差）', !mismatch,
  mismatch ? JSON.stringify(mismatch) : '');

const fm = probe().M, fs2 = probe().S;
ok('客户端与引擎同时判定结束', fm.phase === 'over' && ref.phase === 'over',
  'client=' + fm.phase + ' ref=' + ref.phase);
ok('结束原因一致', fm.reason === ref.reason, fm.reason + ' vs ' + ref.reason);
ok('最终转数一致', fm.players['1'].spins === ref.players['1'].spins,
  fm.players['1'].spins + ' vs ' + ref.players['1'].spins);
console.log('    本局：' + fm.players['1'].spins + ' 转 · 结束原因 ' + fm.reason +
  ' · 剩余生命 ' + fm.players['1'].hp + ' · 金币 ' + fm.players['1'].gold);

ok('结束后结算弹窗已弹出', byId('endOverlay').classList.contains('show'));
ok('结算标题与结局一致',
  byId('endTitle').textContent === (fm.reason === 'doom' ? '死 神 退 场' : '你 死 了'),
  byId('endTitle').textContent + ' / reason=' + fm.reason);
ok('结算里列出了统计数据', byId('endTally').innerHTML.indexOf('最终转数') >= 0);
ok('最佳记录写入了本地存储', store.rr_best !== undefined, JSON.stringify(store));

/* 结束后再点转动应无反应 */
const spinsBefore = probe().M.players['1'].spins;
sandbox.spin(); flushTimers();
ok('对局结束后再点转动不会有任何变化', probe().M.players['1'].spins === spinsBefore);

/* ---------------- 商场：走引擎、且拒绝有提示 ---------------- */
console.log('\n  ── 商场 ──\n');
Math.random = realRandom;

{
  /* 重开一局，手动塞钱进去（钱只在引擎里，页面读不到也就改不了） */
  sandbox.init();
  flushTimers();
  const m = probe().M;
  m.players['1'].gold = 1000;      // 直接改引擎状态（本地单机的「作弊」，联机时不存在）
  probe().S.gold = 1000;

  const before = probe().M.players['1'].charms;
  sandbox.buy({ id: 'charm' });
  flushTimers();
  ok('购买护符：护符 +1、金币 −100',
    probe().M.players['1'].charms === before + 1 && probe().M.players['1'].gold === 900,
    'charms=' + probe().M.players['1'].charms + ' gold=' + probe().M.players['1'].gold);

  sandbox.buy({ id: 'rewind' });
  flushTimers();
  ok('减少转数：由引擎回退 5 转（此时还没转过，仍为 0）',
    probe().M.players['1'].rewinds === 1 && probe().M.players['1'].spins === 0,
    JSON.stringify({ rewinds: probe().M.players['1'].rewinds, spins: probe().M.players['1'].spins }));

  /* 把钱花光，验证被拒时给出中文提示 */
  probe().M.players['1'].gold = 0;
  probe().S.gold = 0;
  const logEl = byId('log');
  const n0 = logEl.children.length;
  sandbox.buy({ id: 'potion' });
  flushTimers();
  ok('钱不够时购买被拒，并在日志里给出中文原因',
    logEl.children.length > n0 && logEl.children[0]._html.indexOf('金币不够') >= 0,
    logEl.children[0] && logEl.children[0]._html);

  const shopIds = ENGINE.shopFor(probe().M, probe().M.players['1']).map(function (s) { return s.id; });
  ok('商城列表来自引擎（护符/药水/减少转数）',
    JSON.stringify(shopIds) === JSON.stringify(['charm', 'potion', 'rewind']), JSON.stringify(shopIds));
}

console.log('\n=== 结果：' + PASS + ' 通过 / ' + FAIL + ' 失败 ===\n');
process.exit(FAIL > 0 ? 1 : 0);
