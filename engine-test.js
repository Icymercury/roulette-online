/* ============================================================
 * engine.js 验收测试
 * ------------------------------------------------------------
 * 两部分：
 *   A. 等价性 —— 把 roulette-wheel.html 的原逻辑逐行转录成一份「参考实现」，
 *      用同一个随机种子驱动两套代码，最终状态必须逐字段一致。
 *      这是最强证据：证明抽出 engine 之后，规则一个字节都没走样。
 *   B. 蒙特卡洛 —— 带策略跑 5 万局，看通关率、平均转数与评价分布，
 *      确认数量级合理（同时也是以后调数值的基准线）。
 *
 * 用法：node engine-test.js
 * ============================================================ */

const E = require('./engine.js');

let PASS = 0, FAIL = 0;
function ok(name, cond, extra) {
  if (cond) { PASS++; console.log('  \u2713 ' + name); }
  else { FAIL++; console.log('  \u2717 ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, a, b) {
  ok(name, a === b, 'engine=' + JSON.stringify(a) + ' ref=' + JSON.stringify(b));
}

/* ============================ 可复现随机源 ============================ */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================
 * 参考实现 —— 原 roulette-wheel.html 的逻辑，去掉 DOM 与动画
 * 只做最小改动：把 Math.random 换成注入的 rng。
 * ============================================================ */

const REF_MAX_HP = 7, REF_MAX_SPIN = 100;
const REF_EVENTS = [
  { key: 'minus1' }, { key: 'plus1' }, { key: 'minus2' }, { key: 'plus2' }, { key: 'gold' },
];
const REF_SHOP = [
  { id: 'charm', price: 100 },
  { id: 'potion', price: 300 },
  { id: 'rewind', price: 200, max: 3 },
];

function refFresh() {
  return {
    hp: REF_MAX_HP, gold: 0, spins: 0, charms: 0, potions: 0,
    spent: 0, earned: 0, interest: 0, charmUsed: 0, rewinds: 0,
    ended: false, survived: false, ms31: false, ms71: false,
    tally: { minus1: 0, plus1: 0, minus2: 0, plus2: 0, gold: 0 },
  };
}

function refProbs(n) {
  return [
    30 + 0.4 * n,
    Math.max(0, 30 - 0.3 * n),
    10 + 0.2 * n,
    Math.max(0, 10 - 0.1 * n),
    Math.max(0, 20 - 0.2 * n),
  ];
}

function refPick(p, rng) {
  const r = rng() * 100;
  let acc = 0;
  for (let i = 0; i < 5; i++) { acc += p[i]; if (r < acc) return i; }
  return 4;
}

function refMilestone(S, n) {
  S.hp = REF_MAX_HP;
  S.charms = 0; S.potions = 0;
  if (n === 31) S.ms31 = true; else S.ms71 = true;
}

function refResolve(S, idx, goldBefore) {
  const e = REF_EVENTS[idx];
  S.tally[e.key]++;
  S.spins++;
  let dead = false;

  if (e.key === 'minus1' || e.key === 'minus2') {
    const dmg = e.key === 'minus1' ? 1 : 2;
    if (S.hp - dmg <= 0 && S.charms > 0) {
      S.charms--; S.charmUsed++; S.hp = 1;
    } else {
      S.hp -= dmg;
      if (S.hp <= 0) { S.hp = 0; dead = true; }
    }
  } else if (e.key === 'plus1') {
    if (S.hp < REF_MAX_HP) S.hp++;
  } else if (e.key === 'plus2') {
    if (S.hp < REF_MAX_HP) S.hp = Math.min(REF_MAX_HP, S.hp + 2);
  } else {
    S.gold += 50; S.earned += 50;
  }

  if (!dead) {
    const itr = Math.floor(goldBefore / 10);
    if (itr > 0) { S.gold += itr; S.earned += itr; S.interest += itr; }
  }

  if (!dead) {
    if (!S.ms31 && S.spins >= 31) refMilestone(S, 31);
    else if (!S.ms71 && S.spins >= 71) refMilestone(S, 71);
  }

  if (dead) { S.ended = true; return; }

  const pr = refProbs(Math.min(S.spins, REF_MAX_SPIN));
  if (S.spins >= REF_MAX_SPIN || pr[0] + pr[2] >= 100) { S.ended = true; S.survived = true; }
}

function refSpin(S, rng) {
  if (S.ended) return;

  if (S.ms71 && S.hp > 0) {
    if (S.hp - 1 <= 0 && S.charms > 0) {
      S.charms--; S.charmUsed++; S.hp = 1;
    } else {
      S.hp -= 1;
      if (S.hp <= 0) { S.hp = 0; S.ended = true; return; }
    }
  }

  const p = refProbs(Math.min(S.spins, REF_MAX_SPIN));
  const idx = refPick(p, rng);
  const goldBefore = S.gold;
  refResolve(S, idx, goldBefore);
}

function refBuy(S, itemId) {
  const it = REF_SHOP.filter(function (s) { return s.id === itemId; })[0];
  if (!it) return;
  if (S.ended || S.gold < it.price) return;
  if (it.max != null && S.rewinds >= it.max) return;
  S.gold -= it.price; S.spent += it.price;
  if (it.id === 'charm') S.charms++;
  else if (it.id === 'potion') S.potions++;
  else { S.rewinds++; S.spins = Math.max(0, S.spins - 5); }
}

function refUsePotion(S) {
  if (S.potions <= 0 || S.hp >= REF_MAX_HP || S.ended) return;
  S.potions--; S.hp = REF_MAX_HP;
}

/* ============================ 共用策略 ============================ */
/* 两套实现都调用同一个策略函数，所以动作序列完全一致。
   这是「危险线决策」型策略：先看血量离死亡有多近，再决定花钱。 */

function policy(st) {
  if (st.over) return null;

  // ① 顶不住了，先喝药（药水回满，最划算）
  if (st.hp <= 2 && st.potions > 0) return { type: 'usePotion' };
  // ② 顶不住又没药，钱够就买
  if (st.hp <= 2 && st.potions === 0 && st.gold >= 300) return { type: 'buy', itemId: 'potion' };
  // ③ 血线偏低，先垫一张护符
  if (st.hp <= 3 && st.charms === 0 && st.gold >= 100) return { type: 'buy', itemId: 'charm' };
  // ④ 镰刀期：任何血量的致命伤都可能来自转动前那一刀
  if (st.ms71 && st.hp <= 2 && st.gold >= 100) return { type: 'buy', itemId: 'charm' };
  // ⑤ 熬过 71 转且有钱，囤两张护符吃利息
  if (st.spins >= 71 && st.gold >= 200 && st.charms < 2) return { type: 'buy', itemId: 'charm' };

  return { type: 'spin' };
}

/* ============================ 两份状态的结构对齐 ============================ */

function engineAsFlat(m) {
  const p = m.players['1'];
  return {
    hp: p.hp, gold: p.gold, spins: p.spins, charms: p.charms, potions: p.potions,
    spent: p.spent, earned: p.earned, interest: p.interest,
    charmUsed: p.charmUsed, rewinds: p.rewinds,
    ended: m.phase !== 'playing', survived: p.finished,
    ms31: p.ms31, ms71: p.ms71, tally: p.tally,
  };
}

function refAsFlat(S) {
  return {
    hp: S.hp, gold: S.gold, spins: S.spins, charms: S.charms, potions: S.potions,
    spent: S.spent, earned: S.earned, interest: S.interest,
    charmUsed: S.charmUsed, rewinds: S.rewinds,
    ended: S.ended, survived: S.survived,
    ms31: S.ms31, ms71: S.ms71, tally: S.tally,
  };
}

function playEngine(seed) {
  const rng = mulberry32(seed);
  let m = E.createMatch({ mode: 'solo', players: [{ id: '1', name: 'X' }] });
  let guard = 0;
  while (m.phase === 'playing' && guard++ < 2000) {
    const p = m.players['1'];
    const act = policy({
      hp: p.hp, gold: p.gold, spins: p.spins, charms: p.charms, potions: p.potions,
      rewinds: p.rewinds, ms31: p.ms31, ms71: p.ms71, over: false,
    });
    if (!act) break;
    m = E.applyAction(m, Object.assign({ playerId: '1' }, act), rng).match;
  }
  return engineAsFlat(m);
}

function playRef(seed) {
  const rng = mulberry32(seed);
  const S = refFresh();
  let guard = 0;
  while (!S.ended && guard++ < 2000) {
    const act = policy({
      hp: S.hp, gold: S.gold, spins: S.spins, charms: S.charms, potions: S.potions,
      rewinds: S.rewinds, ms31: S.ms31, ms71: S.ms71, over: S.ended,
    });
    if (!act) break;
    if (act.type === 'spin') refSpin(S, rng);
    else if (act.type === 'buy') refBuy(S, act.itemId);
    else if (act.type === 'usePotion') refUsePotion(S);
  }
  return refAsFlat(S);
}

/* ============================================================
 * A. 等价性
 * ============================================================ */

console.log('\n=== A. 等价性：engine vs 原版逻辑（同种子逐字段对比）===\n');

{
  // 边界：概率表本身
  const p0 = E.probs(0);
  ok('probs(0) = 30/30/10/10/20',
    p0[0] === 30 && p0[1] === 30 && p0[2] === 10 && p0[3] === 10 && p0[4] === 20);

  const p100 = E.probs(100);
  ok('probs(100) = 70/0/30/0/0（三条正面线同时归零）',
    p100[0] === 70 && p100[1] === 0 && p100[2] === 30 && p100[3] === 0 && p100[4] === 0);

  let sumOk = true;
  for (let n = 0; n <= 100; n++) {
    const s = E.probs(n).reduce(function (a, b) { return a + b; }, 0);
    if (Math.abs(s - 100) > 1e-9) sumOk = false;
  }
  ok('任意 n ∈ [0,100] 概率总和恒为 100', sumOk);

  ok('doomProbs(100) = 100 → 命中第二条结束条件', E.doomProbs(100) === 100);
  ok('probs 超界自动截断（probs(500) === probs(100)）',
    JSON.stringify(E.probs(500)) === JSON.stringify(E.probs(100)));
}

{
  // 全量对比：2000 个种子，跑完整局
  const N = 2000;
  const fields = ['hp', 'gold', 'spins', 'charms', 'potions', 'spent', 'earned',
    'interest', 'charmUsed', 'rewinds', 'ended', 'survived', 'ms31', 'ms71'];
  const tallyFields = ['minus1', 'plus1', 'minus2', 'plus2', 'gold'];

  let mismatch = 0;
  let firstBad = null;
  let endedCount = 0, survivedCount = 0, totalSpins = 0;

  for (let seed = 1; seed <= N; seed++) {
    const a = playEngine(seed);
    const b = playRef(seed);

    let bad = null;
    for (const f of fields) if (a[f] !== b[f]) { bad = f; break; }
    if (!bad) for (const f of tallyFields) if (a.tally[f] !== b.tally[f]) { bad = 'tally.' + f; break; }

    if (bad) {
      mismatch++;
      if (!firstBad) firstBad = { seed: seed, field: bad, engine: a, ref: b };
    }
    if (a.ended) endedCount++;
    if (a.survived) survivedCount++;
    totalSpins += a.spins;
  }

  eq('2000 局逐字段完全一致（不一致数应为 0）', mismatch, 0);
  if (firstBad) {
    console.log('    首个不一致：seed=' + firstBad.seed + ' 字段=' + firstBad.field);
    console.log('    engine=' + JSON.stringify(firstBad.engine));
    console.log('    ref   =' + JSON.stringify(firstBad.ref));
  }

  console.log('    抽查：局均 ' + (totalSpins / N).toFixed(2) + ' 转 · 通关 ' +
    (survivedCount / N * 100).toFixed(2) + '%');
}

{
  // 规则细节单点验证
  let m = E.createMatch({ mode: 'solo', players: [{ id: '1' }] });
  const p = m.players['1'];

  // 利息只认转动前本金：99 金 → +9
  p.gold = 99;
  let r = E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(1));
  let interestEv = r.events.filter(function (e) { return e.t === 'interest'; })[0];
  ok('利息 = floor(99 / 10) = 9 金（按转动前本金）',
    interestEv && interestEv.amount === 9, JSON.stringify(interestEv));

  // 护符挡致命伤 → 锁 1 血
  m = E.createMatch({ mode: 'solo', players: [{ id: '1' }] });
  m.players['1'].hp = 1;
  m.players['1'].charms = 1;
  let charmCase = null;
  for (let s = 1; s <= 500 && !charmCase; s++) {
    const rr = E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(s));
    if (rr.events.some(function (e) { return e.t === 'damage'; })) charmCase = rr;
  }
  ok('护符挡下致命伤：不死亡、血量锁在 1、护符被消耗',
    !!charmCase &&
    charmCase.match.players['1'].hp === 1 &&
    charmCase.match.players['1'].charms === 0 &&
    charmCase.match.players['1'].alive === true &&
    charmCase.match.players['1'].charmUsed === 1 &&
    charmCase.events.some(function (e) { return e.t === 'damage' && e.blockedByCharm === true; }),
    charmCase ? JSON.stringify(charmCase.match.players['1']) : '没抽到伤害事件');

  // 31 转节点：回满血 + 道具清空
  m = E.createMatch({ mode: 'solo', players: [{ id: '1' }] });
  m.players['1'].spins = 30;
  m.players['1'].hp = 3;
  m.players['1'].charms = 2;
  m.players['1'].potions = 1;
  r = E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(7));
  const ms = r.events.filter(function (e) { return e.t === 'milestone'; })[0];
  ok('第 31 转：生命补满、道具被夺走',
    ms && ms.n === 31 && ms.lost === 3 && r.match.players['1'].hp === 7 &&
    r.match.players['1'].charms === 0 && r.match.players['1'].potions === 0,
    JSON.stringify(ms));

  // 71 转：装上镰刀；此后每转先扣 1 血
  // 注意 ms31 必须先置 true —— 真实对局走到 70 转时，31 节点早已用过；
  // 否则 !ms31 && spins>=31 会抢先命中 milestone(31)。这是原版行为，不是 bug。
  m = E.createMatch({ mode: 'solo', players: [{ id: '1' }] });
  Object.assign(m.players['1'], { spins: 70, hp: 7, ms31: true });
  r = E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(3));
  ok('第 71 转：scytheArmed = true', r.match.players['1'].ms71 === true);

  const before = r.match;
  const r2 = E.applyAction(before, { type: 'spin', playerId: '1' }, mulberry32(9));
  const scy = r2.events.filter(function (e) { return e.t === 'scythe'; })[0];
  ok('71 转之后：每转先扣 1 血（scythe 事件排在 roll 之前）',
    !!scy && r2.events[0].t === 'scythe',
    JSON.stringify(r2.events.map(function (e) { return e.t; })));

  // 护符挡镰刀 —— 只看 scythe 事件那一刻的血量，转盘结果会干扰终态
  m = E.createMatch({ mode: 'solo', players: [{ id: '1' }] });
  Object.assign(m.players['1'], { ms31: true, ms71: true, hp: 1, charms: 1 });
  let scyCharm = null;
  for (let s = 1; s <= 500 && !scyCharm; s++) {
    const rr = E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(s));
    const sc = rr.events.filter(function (e) { return e.t === 'scythe'; })[0];
    if (sc && sc.blockedByCharm) scyCharm = rr;
  }
  ok('血量为 1 时镰刀挥下：护符挡下，那一刻仍锁 1 血',
    !!scyCharm && scyCharm.events[0].hp === 1 &&
    scyCharm.match.players['1'].charmUsed === 1 &&
    scyCharm.match.players['1'].charms === 0,
    scyCharm ? JSON.stringify(scyCharm.events[0]) : '没抽到 scythe 事件');

  // 减少转数：限 3 次，且不回退节点标志
  m = E.createMatch({ mode: 'solo', players: [{ id: '1' }] });
  Object.assign(m.players['1'], { gold: 1000, spins: 40, ms31: true });
  for (let i = 0; i < 3; i++) m = E.applyAction(m, { type: 'buy', playerId: '1', itemId: 'rewind' }, mulberry32(1)).match;
  const st = m.players['1'];
  ok('减少转数：3 次后 spins = 40 − 15 = 25', st.spins === 25, String(st.spins));
  ok('减少转数：ms31 标志不随转数回退（赠礼不会二次触发）', st.ms31 === true);

  const r4 = E.applyAction(m, { type: 'buy', playerId: '1', itemId: 'rewind' }, mulberry32(1));
  const rej = r4.events.filter(function (e) { return e.t === 'rejected'; })[0];
  ok('减少转数：第 4 次被拒（limit-reached）', rej && rej.reason === 'limit-reached');

  // 死亡后不能行动
  m = E.createMatch({ mode: 'solo', players: [{ id: '1' }] });
  m.players['1'].alive = false;
  m.phase = 'over';
  const r5 = E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(1));
  ok('对局结束后动作被拒', r5.events[0].t === 'rejected' && r5.events[0].reason === 'game-over');

  // 纯函数性：applyAction 不得改动传入对象
  m = E.createMatch({ mode: 'solo', players: [{ id: '1' }] });
  const snapshot = JSON.stringify(m);
  E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(5));
  ok('applyAction 是纯函数（原对象未被修改）', JSON.stringify(m) === snapshot);
}

/* ============================================================
 * B. 蒙特卡洛
 * ============================================================ */

console.log('\n=== B. 蒙特卡洛：5 万局（危险线策略）===\n');

{
  const N = 50000;
  let survived = 0, dead = 0, spinSum = 0;
  let madeTo31 = 0, madeTo71 = 0, doomSum = 0;
  let goldSum = 0, interestSum = 0, charmUsedSum = 0;
  const spanBuckets = { '1-19': 0, '20-44': 0, '45-69': 0, '70-89': 0, '90-99': 0, '100': 0 };

  for (let seed = 1; seed <= N; seed++) {
    const a = playEngine(seed);
    if (a.survived) survived++; else dead++;
    spinSum += a.spins;
    if (a.ms31) madeTo31++;
    if (a.ms71) madeTo71++;
    goldSum += a.gold;
    interestSum += a.interest;
    charmUsedSum += a.charmUsed;

    const s = a.spins;
    if (s >= 100) spanBuckets['100']++;
    else if (s >= 90) spanBuckets['90-99']++;
    else if (s >= 70) spanBuckets['70-89']++;
    else if (s >= 45) spanBuckets['45-69']++;
    else if (s >= 20) spanBuckets['20-44']++;
    else spanBuckets['1-19']++;
  }

  const rate = survived / N * 100;
  console.log('  通关率        ' + rate.toFixed(2) + '%   （存活 ' + survived + ' / 死亡 ' + dead + '）');
  console.log('  平均转数      ' + (spinSum / N).toFixed(2));
  console.log('  触发 31 节点  ' + (madeTo31 / N * 100).toFixed(1) + '%');
  console.log('  触发 71 镰刀  ' + (madeTo71 / N * 100).toFixed(1) + '%');
  console.log('  场均剩余金币  ' + (goldSum / N).toFixed(0) + '（其中利息 ' + (interestSum / N).toFixed(0) + '）');
  console.log('  场均护符消耗  ' + (charmUsedSum / N).toFixed(2));
  console.log('  转数分布：' + Object.keys(spanBuckets)
    .map(function (k) { return k + ' ' + (spanBuckets[k] / N * 100).toFixed(1) + '%'; }).join('  |  '));
  console.log('');
  console.log('  注意：通关率是「本策略下」的结果，不是游戏的固有属性。');
  console.log('        调整数值时必须用同一份策略重跑，否则数据不可比。');

  ok('通关率落在合理区间（10% ~ 45%，且非退化）', rate > 10 && rate < 45, rate.toFixed(2) + '%');
  ok('71 转镰刀在单机长局里可见（> 20%）', madeTo71 / N > 0.2,
    (madeTo71 / N * 100).toFixed(1) + '%');
}

console.log('\n=== 结果：' + PASS + ' 通过 / ' + FAIL + ' 失败 ===\n');
process.exit(FAIL > 0 ? 1 : 0);
