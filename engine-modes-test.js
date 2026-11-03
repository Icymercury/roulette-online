/* ============================================================
 * 三模式规则验收测试
 *   A. 对赌轮盘（turn）—— 共享轮盘：15 血 / 固定概率 / 无 31 转 /
 *      71 转不回血不清道具 / 71-81-91 三段镰刀按全局 k / 利息封顶 500 /
 *      道具 71 转后每买一次翻倍 / 无 100 转上限
 *   B. 死神追猎（race）—— 各自轮盘：10 血 / 镰刀按各自转数 / 商城无减少转数、
 *      有香蕉皮 / 存活时间 / 结束条件（存活一人 or 完成 100 转比用时）
 *   C. 死亡轮盘（solo）—— 沿用 V5，本文件只验证它没被上面两个改坏
 *
 * 用法：node engine-modes-test.js
 * ============================================================ */

const E = require('./engine.js');

let PASS = 0, FAIL = 0;
function ok(name, cond, extra) {
  if (cond) { PASS++; console.log('  \u2713 ' + name); }
  else { FAIL++; console.log('  \u2717 ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fixed(v) { return function () { return v; }; }
function got(ev, t) { return ev.filter(function (e) { return e.t === t; }); }
function has(ev, t) { return got(ev, t).length > 0; }

function turnMatch(ids) {
  return E.createMatch({
    mode: 'turn',
    players: (ids || ['1', '2']).map(function (id) { return { id: id }; }),
  });
}
function raceMatch(ids, startedAt) {
  return E.createMatch({
    mode: 'race',
    players: (ids || ['1', '2']).map(function (id) { return { id: id }; }),
    startedAt: startedAt === undefined ? null : startedAt,
  });
}

/* ============================================================ */
console.log('\n=== A. 对赌轮盘（turn）===\n');

{
  ok('中文名 = 对赌轮盘', E.modeLabel('turn') === '对赌轮盘', E.modeLabel('turn'));

  const m = turnMatch(['1', '2']);
  ok('血量上限 15', m.players['1'].hp === 15 && m.players['2'].hp === 15, m.players['1'].hp);

  const view = E.publicView(m);
  ok('视图里带模式中文名与镰刀档位', view.modeLabel === '对赌轮盘' &&
    JSON.stringify(view.rules.scytheTiers) === JSON.stringify([{ from: 71, dmg: 1 }, { from: 81, dmg: 2 }, { from: 91, dmg: 3 }]),
    JSON.stringify(view.rules.scytheTiers));
  ok('视图里利息上限 = 500', view.rules.interestCap === 500, view.rules.interestCap);
  ok('视图里涨价起点 = 71', view.rules.inflationFrom === 71, view.rules.inflationFrom);
  ok('视图里没有 100 转上限（doomAt = null）', view.rules.doomAt === null, view.rules.doomAt);
}

{
  /* 概率固定 */
  const m = turnMatch(['1']);
  const r = E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(7));
  const roll = got(r.events, 'roll')[0];
  ok('概率固定为 30/30/10/10/20（不随转数变化）',
    JSON.stringify(roll.probs) === JSON.stringify([30, 30, 10, 10, 20]), JSON.stringify(roll.probs));
  ok('单机曲线仍在（probs(50) 不等于固定值），两者互不干扰',
    E.probs(50)[0] === 50 && JSON.stringify(E.probsFor(m, 50)) === JSON.stringify([30, 30, 10, 10, 20]));
}

{
  /* 无 31 转节点、71 转不回血不清道具 */
  let m = turnMatch(['1']);
  m.players['1'].hp = 5;
  m.k = 30;                                   // 下一转就是第 31 转
  let r = E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(3));
  ok('删除 31 转节点：第 31 转不产生 milestone', !has(r.events, 'milestone'),
    JSON.stringify(r.events.map(function (e) { return e.t; })));

  m = turnMatch(['1']);
  m.players['1'].hp = 4;
  m.players['1'].charms = 2;
  m.players['1'].potions = 1;
  m.k = 70;                                   // 下一转就是第 71 转
  r = E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(5));
  const ms = got(r.events, 'milestone')[0];
  ok('第 71 转仍是死神造访（有 milestone 事件）', !!ms, JSON.stringify(r.events.map(function (e) { return e.t; })));
  ok('71 转不回血', r.match.players['1'].hp !== 15 && ms && ms.hp !== 15,
    'hp after milestone = ' + (ms && ms.hp));
  ok('71 转不清空道具', r.match.players['1'].charms === 2 || r.match.players['1'].charms === 0
    ? (r.match.players['1'].charms + r.match.players['1'].potions) > 0 : false,
    'charms=' + r.match.players['1'].charms + ' potions=' + r.match.players['1'].potions);
}

{
  /* 三段镰刀：按全局 k，逐转叠加 */
  const m = turnMatch(['1', '2']);
  const probe = function (k) { const mm = E.cloneMatch(m); mm.k = k; return E.scytheFor(mm, mm.players['1']); };
  ok('镰刀档位 k=70 → 0', probe(70) === 0);
  ok('镰刀档位 k=71 → 1', probe(71) === 1);
  ok('镰刀档位 k=80 → 1', probe(80) === 1);
  ok('镰刀档位 k=81 → 2', probe(81) === 2);
  ok('镰刀档位 k=90 → 2', probe(90) === 2);
  ok('镰刀档位 k=91 → 3', probe(91) === 3);
  ok('镰刀档位 k=200 → 3（永久维持，不是一次性）', probe(200) === 3);

  /* 转动者才挨刀 */
  const m2 = E.cloneMatch(m);
  m2.k = 91;
  const r = E.applyAction(m2, { type: 'spin', playerId: '1' }, fixed(0.99));
  const sc = got(r.events, 'scythe')[0];
  ok('镰刀只扣「转动者」：scythe.playerId = 1', sc && sc.playerId === '1', JSON.stringify(sc));
  ok('scythe.amount = 3', sc && sc.amount === 3, sc && sc.amount);
  ok('另一名玩家血量不受影响', r.match.players['2'].hp === 15, r.match.players['2'].hp);

  /* 换档演出：真实对局走到 81 转时 ms71 早已置位 */
  const m3 = turnMatch(['1', '2']);
  m3.k = 80;
  m3.players['1'].ms71 = true;
  const r3 = E.applyAction(m3, { type: 'spin', playerId: '1' }, mulberry32(1));
  const armed = got(r3.events, 'scytheArmed')[0];
  ok('镰刀换档时广播 scytheArmed（80→81 档位 1→2）', armed && armed.previous === 1 && armed.dmg === 2, JSON.stringify(armed));
}

{
  /* 利息本金封顶 500 */
  const m = turnMatch(['1', '2']);
  m.players['1'].gold = 5000;
  const r = E.applyAction(m, { type: 'spin', playerId: '1' }, fixed(0.99));
  const it = got(r.events, 'interest')[0];
  ok('利息本金封顶 500 → 无论持有多少，每转最多 +50', it && it.amount === 50, JSON.stringify(it));

  const m2 = turnMatch(['1', '2']);
  m2.players['1'].gold = 499;
  const it2 = got(E.applyAction(m2, { type: 'spin', playerId: '1' }, fixed(0.99)).events, 'interest')[0];
  ok('利息 499 金 → +49', it2 && it2.amount === 49, it2 && it2.amount);
}

{
  /* 道具涨价：71 转后每买一次翻倍（对赌轮盘是多人模式，至少两名玩家） */
  let m = turnMatch(['1', '2']);
  const P = E.SHOP.potion;
  m.players['1'].gold = 100000;

  ok('70 转时药水原价 300', E.priceOf(m, m.players['1'], P) === 300, E.priceOf(m, m.players['1'], P));

  m = E.cloneMatch(m); m.k = 71;
  ok('71 转时药水仍是 300（第一次不翻倍）', E.priceOf(m, m.players['1'], P) === 300);

  let r = E.applyAction(m, { type: 'buy', playerId: '1', itemId: 'potion' }, mulberry32(1));
  let cost = got(r.events, 'buy')[0].cost;
  ok('71 转后第 1 次购买付 300', cost === 300, cost);
  ok('买完价格翻倍为 600', E.priceOf(r.match, r.match.players['1'], P) === 600, E.priceOf(r.match, r.match.players['1'], P));

  r = E.applyAction(r.match, { type: 'buy', playerId: '1', itemId: 'potion' }, mulberry32(1));
  cost = got(r.events, 'buy')[0].cost;
  ok('第 2 次购买付 600', cost === 600, cost);

  r = E.applyAction(r.match, { type: 'buy', playerId: '1', itemId: 'potion' }, mulberry32(1));
  cost = got(r.events, 'buy')[0].cost;
  ok('第 3 次购买付 1200', cost === 1200, cost);
  ok('价格再翻倍为 2400', E.priceOf(r.match, r.match.players['1'], P) === 2400, E.priceOf(r.match, r.match.players['1'], P));

  /* 71 转前的购买不计入涨价记账 */
  let m2 = turnMatch(['1', '2']);
  m2.players['1'].gold = 100000;
  m2.k = 40;
  m2 = E.applyAction(m2, { type: 'buy', playerId: '1', itemId: 'potion' }, mulberry32(1)).match;
  m2 = E.applyAction(m2, { type: 'buy', playerId: '1', itemId: 'potion' }, mulberry32(1)).match;
  m2 = E.cloneMatch(m2); m2.k = 71;
  ok('71 转前买了 2 瓶，71 转后首买仍按原价（涨价只数 71 转后的购买）',
    E.priceOf(m2, m2.players['1'], P) === 300, E.priceOf(m2, m2.players['1'], P));

  /* 各玩家的涨价互相独立 */
  const m3 = turnMatch(['1', '2']);
  m3.players['1'].gold = 100000;
  m3.players['2'].gold = 100000;
  m3.k = 71;
  const r3 = E.applyAction(m3, { type: 'buy', playerId: '1', itemId: 'potion' }, mulberry32(1));
  const r4 = E.applyAction(r3.match, { type: 'buy', playerId: '2', itemId: 'potion' }, mulberry32(1));
  ok('涨价按玩家各自记账：玩家1 买过后，玩家2 仍是原价',
    got(r4.events, 'buy')[0].cost === 300, got(r4.events, 'buy')[0].cost);
}

{
  /* 无 100 转上限 + 只剩一人结束 */
  const m = turnMatch(['1', '2']);
  m.k = 150;
  const r = E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(9));
  ok('k=150 时对局仍在进行（100 转上限已删除）', r.match.phase === 'playing', r.match.phase);

  const m2 = turnMatch(['1', '2']);
  m2.players['2'].alive = false;
  const r2 = E.applyAction(m2, { type: 'spin', playerId: '1' }, mulberry32(9));
  ok('只剩一人时结束，reason = last-standing',
    r2.match.phase === 'over' && r2.match.reason === 'last-standing' && r2.match.winner === '1',
    r2.match.reason + '/' + r2.match.winner);
}

{
  /* 减少转数已从对赌轮盘移除：共享轮盘的档位是全场共担的，谁买谁把所有人往后拖 */
  const m = turnMatch(['1', '2']);
  m.players['1'].gold = 1000;
  m.k = 75;
  const r = E.applyAction(m, { type: 'buy', playerId: '1', itemId: 'rewind' }, mulberry32(1));
  const rej = got(r.events, 'rejected')[0];
  ok('对赌轮盘买「减少转数」被拒（item-not-available）',
    rej && rej.reason === 'item-not-available', JSON.stringify(rej));
  ok('买不到就不会改动读数（k 仍是 75）', r.match.k === 75, r.match.k);
  ok('对赌轮盘商城 = 护符 + 药水',
    JSON.stringify(E.publicView(m).rules.shop) === JSON.stringify(['charm', 'potion']),
    JSON.stringify(E.publicView(m).rules.shop));
}

{
  /* ---- 封存（掉线等待）：停表 + 拒绝一切动作 ---- */
  const m = turnMatch(['1', '2']);
  m.startedAt = 1000;
  const frozen = E.pauseMatch(m, 5000);
  ok('封存后标记为封存中', frozen.frozen === true);
  ok('封存不改原对局（纯函数）', m.frozen === false);
  ok('封存中转动被拒（frozen）',
    got(E.applyAction(frozen, { type: 'spin', playerId: '1' }, mulberry32(1), 6000).events, 'rejected')[0]
      .reason === 'frozen');
  ok('封存中购买被拒（frozen）',
    got(E.applyAction(frozen, { type: 'buy', playerId: '1', itemId: 'charm' }, mulberry32(1), 6000).events, 'rejected')[0]
      .reason === 'frozen');
  ok('封存中喝药被拒（frozen）',
    got(E.applyAction(frozen, { type: 'usePotion', playerId: '1' }, mulberry32(1), 6000).events, 'rejected')[0]
      .reason === 'frozen');
  ok('封存期间计时停摆（elapsedMs 不涨）',
    E.elapsedMs(frozen, 6000) === E.elapsedMs(frozen, 20000) && E.elapsedMs(frozen, 20000) === 4000,
    E.elapsedMs(frozen, 6000) + ' / ' + E.elapsedMs(frozen, 20000));

  const thawed = E.resumeMatch(frozen, 20000);
  ok('解封后不再封存', thawed.frozen === false);
  ok('封存时长记进 pausedMs（5s→20s，共 15 秒）', thawed.pausedMs === 15000, thawed.pausedMs);
  ok('解封后计时接着走（封存那段不算）：25s 时只走了 9 秒',
    E.elapsedMs(thawed, 25000) === 9000, E.elapsedMs(thawed, 25000));
  ok('解封后能正常转动',
    got(E.applyAction(thawed, { type: 'spin', playerId: '1' }, mulberry32(9), 25000).events, 'roll').length === 1);

  /* 反复封存/解封要能累加 */
  const f2 = E.pauseMatch(thawed, 30000);
  const r2 = E.resumeMatch(f2, 35000);
  ok('第二次封存继续累加（15 + 5 = 20 秒）', r2.pausedMs === 20000, r2.pausedMs);
  ok('重复解封不会重复加时', E.resumeMatch(r2, 99000).pausedMs === 20000);

  /* 存活时间必须扣掉封存 —— 否则掉线就白白背了用时 */
  const m2 = raceMatch(['1', '2']);
  m2.startedAt = 0;
  const th2 = E.resumeMatch(E.pauseMatch(m2, 10000), 40000);   // 封存了 30 秒
  th2.players['1'].hp = 1;                                     // 下一转必死
  const dead = E.applyAction(th2, { type: 'spin', playerId: '1' }, () => 0, 60000);
  ok('死亡打点用的是「扣掉封存」的时间（60s − 30s = 30s）',
    dead.match.players['1'].survivalMs === 30000, String(dead.match.players['1'].survivalMs));
  ok('视图暴露封存状态',
    E.publicView(f2).frozen === true && E.publicView(f2).frozenSince === 30000,
    JSON.stringify([E.publicView(f2).frozen, E.publicView(f2).frozenSince]));
}

/* ============================================================ */
console.log('\n=== B. 死神追猎（race）===\n');

{
  ok('中文名 = 死神追猎', E.modeLabel('race') === '死神追猎', E.modeLabel('race'));

  const m = raceMatch(['1', '2']);
  ok('血量上限 10', m.players['1'].hp === 10 && m.players['2'].hp === 10, m.players['1'].hp);

  const view = E.publicView(m);
  ok('目标转数 = 100', view.rules.target === 100, view.rules.target);
  ok('商城没有「减少转数」', view.rules.shop.indexOf('rewind') < 0, JSON.stringify(view.rules.shop));
  ok('商城有「香蕉皮」', view.rules.shop.indexOf('banana') >= 0, JSON.stringify(view.rules.shop));
  ok('镰刀基准是「各自转数」', view.rules.scytheClock === 'own', view.rules.scytheClock);
  ok('存活时间初始为 null', view.players[0].survivalMs === null);
}

{
  /* 香蕉皮可叠加：扔两张 = 目标身上挂 10 次 */
  const m = raceMatch(['1', '2']);
  m.players['1'].gold = 1000;
  /* 把目标的血调高：这段测的是「压住几次」，不该被掷骰结果（可能一路扣血把人打死）干扰 */
  m.players['2'].hp = 999;
  const r1 = E.applyAction(m, { type: 'buy', playerId: '1', itemId: 'banana', targetId: '2' }, mulberry32(3));
  const r2 = E.applyAction(r1.match, { type: 'buy', playerId: '1', itemId: 'banana', targetId: '2' }, mulberry32(3));
  ok('扔两张香蕉皮：目标身上挂 10 次（可叠加）',
    r2.match.players['2'].bananas === 10, r2.match.players['2'].bananas);
  ok('每张都按原价 150 扣（71 转前不涨价）',
    r1.match.players['1'].gold === 850 && r2.match.players['1'].gold === 700,
    r1.match.players['1'].gold + ' / ' + r2.match.players['1'].gold);

  /* 叠加的 10 次要真的能压 10 转 */
  let cur = r2.match;
  for (let i = 0; i < 10; i++) {
    const step = E.applyAction(cur, { type: 'spin', playerId: '2' }, mulberry32(9));
    cur = step.match;
    if (cur.phase !== 'playing') break;
  }
  ok('10 次全部被压住（转数仍是 0）', cur.players['2'].spins === 0, cur.players['2'].spins);
  ok('10 次用完后香蕉皮耗尽', cur.players['2'].bananas === 0, cur.players['2'].bananas);
  const after = E.applyAction(cur, { type: 'spin', playerId: '2' }, mulberry32(9));
  ok('第 11 转恢复计数', after.match.players['2'].spins === 1, after.match.players['2'].spins);
}

{
  /* 镰刀按各自转数，不互相干扰 */
  const m = raceMatch(['1', '2']);
  m.players['1'].spins = 95;
  m.players['2'].spins = 40;
  ok('玩家1 在各自 95 转 → 档位 3', E.scytheFor(m, m.players['1']) === 3);
  ok('玩家2 在各自 40 转 → 档位 0', E.scytheFor(m, m.players['2']) === 0);

  /* 对赌轮盘同一份数据按全局 k 判，两者不同 */
  const t = turnMatch(['1', '2']);
  t.k = 95;
  ok('同样数字在对赌轮盘里是全局 k → 档位 3', E.scytheFor(t, t.players['1']) === 3);
  t.k = 40;
  ok('且全局 k=40 时两个人都是档位 0',
    E.scytheFor(t, t.players['1']) === 0 && E.scytheFor(t, t.players['2']) === 0);
}

{
  /* 香蕉皮 */
  let m = raceMatch(['1', '2']);
  m.players['1'].gold = 1000;

  let r = E.applyAction(m, { type: 'buy', playerId: '1', itemId: 'banana' }, mulberry32(1));
  const rej = got(r.events, 'rejected')[0];
  ok('香蕉皮必须指定目标，否则被拒（bad-target）', rej && rej.reason === 'bad-target', JSON.stringify(rej));

  r = E.applyAction(m, { type: 'buy', playerId: '1', itemId: 'banana', targetId: '1' }, mulberry32(1));
  ok('不能把香蕉皮扔给自己', got(r.events, 'rejected')[0].reason === 'bad-target');

  r = E.applyAction(m, { type: 'buy', playerId: '1', itemId: 'banana', targetId: '2' }, mulberry32(1));
  const b = got(r.events, 'banana')[0];
  ok('香蕉皮买到手：目标身上挂 5 次', b && b.targetId === '2' && b.added === 5 && r.match.players['2'].bananas === 5,
    JSON.stringify(b));

  /* 被扔香蕉皮的人：转数不涨，但效果照常 */
  let m2 = E.cloneMatch(r.match);
  m2.players['2'].hp = 10;
  m2.players['2'].gold = 0;
  m2.players['2'].spins = 40;
  let out = E.applyAction(m2, { type: 'spin', playerId: '2' }, fixed(0.99));   // 金币格
  ok('香蕉皮期间：转数不涨（40 转还是 40 转）', out.match.players['2'].spins === 40, out.match.players['2'].spins);
  ok('香蕉皮期间：转盘效果照常结算（金币 +50）',
    got(out.events, 'gold')[0] && out.match.players['2'].gold >= 50, out.match.players['2'].gold);
  ok('广播 slip 事件、剩余次数 5→4',
    got(out.events, 'slip')[0] && out.match.players['2'].bananas === 4, JSON.stringify(got(out.events, 'slip')[0]));
  ok('roll 事件标记 counted=false', got(out.events, 'roll')[0].counted === false);

  out = E.applyAction(out.match, { type: 'spin', playerId: '2' }, fixed(0.99));
  ok('第二转仍被压住（40 转）', out.match.players['2'].spins === 40, out.match.players['2'].spins);

  /* 连转 5 次后恢复计数 */
  let cur = E.applyAction(m2, { type: 'spin', playerId: '2' }, fixed(0.99));
  for (let i = 0; i < 4; i++) cur = E.applyAction(cur.match, { type: 'spin', playerId: '2' }, fixed(0.99));
  ok('5 次用完后香蕉皮耗尽', cur.match.players['2'].bananas === 0, cur.match.players['2'].bananas);
  cur = E.applyAction(cur.match, { type: 'spin', playerId: '2' }, fixed(0.99));
  ok('第 6 转恢复计数（40 → 41）', cur.match.players['2'].spins === 41, cur.match.players['2'].spins);

  /* 香蕉皮期间的镰刀照常砍 */
  const m3 = raceMatch(['1', '2']);
  m3.players['2'].spins = 95;
  m3.players['2'].bananas = 3;
  m3.players['2'].hp = 10;
  const out3 = E.applyAction(m3, { type: 'spin', playerId: '2' }, fixed(0.99));
  const sc = got(out3.events, 'scythe')[0];
  ok('香蕉皮压不住镰刀：转数不涨但转动前照样扣 3 血',
    sc && sc.amount === 3 && out3.match.players['2'].hp === 7 && out3.match.players['2'].spins === 95,
    JSON.stringify(sc));
}

{
  /* 商城：死神追猎不能买减少转数 */
  const m = raceMatch(['1', '2']);
  m.players['1'].gold = 10000;
  const r = E.applyAction(m, { type: 'buy', playerId: '1', itemId: 'rewind' }, mulberry32(1));
  const rej = got(r.events, 'rejected')[0];
  ok('死神追猎买「减少转数」被拒（item-not-available）', rej && rej.reason === 'item-not-available', JSON.stringify(rej));
}

{
  /* 结束条件②：完成 100 转比用时 */
  let m = raceMatch(['1', '2'], 1000);

  m.players['2'].spins = 99;
  let r = E.applyAction(m, { type: 'spin', playerId: '2' }, mulberry32(4), 6000);
  const fin = got(r.events, 'finished')[0];
  ok('玩家2 完成 100 转 → 广播 finished', !!fin && fin.spins === 100, JSON.stringify(fin));
  ok('存活时间 = 6000 − 1000 = 5000ms', r.match.players['2'].survivalMs === 5000, r.match.players['2'].survivalMs);
  ok('一个人撞线不结束（等第二个人）', r.match.phase === 'playing', r.match.phase);

  r.match.players['1'].spins = 99;
  r = E.applyAction(r.match, { type: 'spin', playerId: '1' }, mulberry32(4), 4000);
  ok('两人都完成 → 用时最短者获胜（玩家1：3000ms）',
    r.match.phase === 'over' && r.match.reason === 'fastest-finish' && r.match.winner === '1',
    r.match.reason + '/' + r.match.winner);
  ok('名次数组按用时升序 = ["1","2"]',
    JSON.stringify(r.match.ranking) === JSON.stringify(['1', '2']), JSON.stringify(r.match.ranking));
  ok('over 事件带名次', JSON.stringify(got(r.events, 'over')[0].ranking) === JSON.stringify(['1', '2']));
  ok('视图里带名次并暴露存活时间',
    JSON.stringify(E.publicView(r.match).ranking) === JSON.stringify(['1', '2']) &&
    E.publicView(r.match).players.filter(function (p) { return p.id === '1'; })[0].survivalMs === 3000);
}

{
  /* 结束条件①：只剩一人存活 */
  const m = raceMatch(['1', '2'], 0);
  m.players['2'].alive = false;
  m.players['2'].diedAt = 7000;
  m.players['2'].survivalMs = 7000;
  const r = E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(2), 9000);
  ok('只剩一人 → last-standing', r.match.reason === 'last-standing' && r.match.winner === '1',
    r.match.reason + '/' + r.match.winner);
}

{
  /* 唯一的完成者直接获胜 */
  const m = raceMatch(['1', '2'], 0);
  m.players['2'].alive = false;
  m.players['1'].spins = 99;
  const r = E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(2), 5000);
  ok('唯一完成者获胜（sole-finisher）',
    r.match.phase === 'over' && r.match.reason === 'sole-finisher' && r.match.winner === '1',
    r.match.reason + '/' + r.match.winner);
}

{
  /* 全灭 → 无人胜出 */
  const m = raceMatch(['1', '2'], 0);
  m.players['2'].alive = false;
  m.players['1'].hp = 1;
  m.players['1'].spins = 95;            // 档位 3，转动前必死
  const r = E.applyAction(m, { type: 'spin', playerId: '1' }, mulberry32(2), 5000);
  ok('全员阵亡 → all-dead，无胜者',
    r.match.phase === 'over' && r.match.reason === 'all-dead' && r.match.winner === null,
    r.match.reason + '/' + r.match.winner);
  ok('死亡也记录存活时间', r.match.players['1'].survivalMs === 5000, r.match.players['1'].survivalMs);
}

/* ============================================================ */
console.log('\n=== C. 死亡轮盘（solo）没被改坏 ===\n');

{
  const m = E.createMatch({ mode: 'solo', players: [{ id: '1' }] });
  const view = E.publicView(m);
  ok('中文名 = 死亡轮盘', view.modeLabel === '死亡轮盘', view.modeLabel);
  ok('仍是 7 血 / 100 转绝境 / 31 与 71 两个节点',
    view.rules.hpMax === 7 && view.rules.doomAt === 100 &&
    view.rules.nodeFirst === 31 && view.rules.nodeScythe === 71,
    JSON.stringify(view.rules));
  ok('仍是概率递增', E.preset('solo').growingProbs === true);
  ok('利息仍不封顶', view.rules.interestCap === null, view.rules.interestCap);
  ok('道具仍不涨价', view.rules.inflationFrom === null, view.rules.inflationFrom);
  ok('商城仍是 护符/药水/减少转数',
    JSON.stringify(view.rules.shop) === JSON.stringify(['charm', 'potion', 'rewind']),
    JSON.stringify(view.rules.shop));

  /* 单机镰刀仍是 ms71 粘性标志：减少转数也关不掉 */
  const m2 = m;
  m2.players['1'].ms71 = true;
  m2.players['1'].gold = 1000;
  m2.players['1'].spins = 80;
  const r = E.applyAction(m2, { type: 'buy', playerId: '1', itemId: 'rewind' }, mulberry32(1));
  ok('单机：减少转数把 80 压回 75，但镰刀照旧（ms71 粘性）',
    r.match.players['1'].spins === 75 && E.scytheFor(r.match, r.match.players['1']) === 1,
    r.match.players['1'].spins + '/' + E.scytheFor(r.match, r.match.players['1']));
}

/* ============================================================ */
console.log('\n=== D. 退出本局（leaveMatch）===\n');

{
  /* ① 摘人要干净：名单里不能留、座位信息要原样还回去 */
  const m = turnMatch(['1', '2', '3']);
  const r = E.leaveMatch(m, '2', 5000);
  ok('退出的人从 order 里摘掉', JSON.stringify(r.match.order) === JSON.stringify(['1', '3']),
    JSON.stringify(r.match.order));
  ok('退出的人从 players 里删掉', !r.match.players['2']);
  ok('原对局对象没被改（applyAction/leaveMatch 都是纯函数）',
    JSON.stringify(m.order) === JSON.stringify(['1', '2', '3']), JSON.stringify(m.order));
  ok('座位信息（id/名字/凭证）原样还给调用方',
    r.seat && r.seat.id === '2' && r.seat.name === '玩家 2', JSON.stringify(r.seat));
  ok('广播 leave 事件', has(r.events, 'leave'));
  ok('leave 事件带上还剩几人', r.events.find(function (e) { return e.t === 'leave'; }).left === 2,
    String(r.events.find(function (e) { return e.t === 'leave'; }).left));
  ok('三个人走一个，对局没结束', r.match.phase === 'playing', r.match.phase);

  /* ② 轮次指针：退场不等于「跳过下一个人」 */
  const m2 = turnMatch(['1', '2', '3']);
  m2.turn = 0;                                   // 轮到 1 号
  const r2 = E.leaveMatch(m2, '3', 1);           // 走的是排在最后的 3 号
  ok('摘掉排在后面的人，轮次指针不动', r2.match.turn === 0, String(r2.match.turn));
  ok('轮次指向的还是原来那个人', r2.match.order[r2.match.turn] === '1',
    r2.match.order[r2.match.turn]);

  const m3 = turnMatch(['1', '2', '3']);
  m3.turn = 2;                                   // 轮到 3 号
  const r3 = E.leaveMatch(m3, '1', 1);           // 走的是排在前面的 1 号
  ok('摘掉排在前面的人，轮次指针左移一格（还是同一个人）',
    r3.match.turn === 1 && r3.match.order[r3.match.turn] === '3',
    r3.match.turn + '/' + r3.match.order[r3.match.turn]);

  const m4 = turnMatch(['1', '2', '3']);
  m4.turn = 1;                                   // 轮到 2 号
  const r4 = E.leaveMatch(m4, '2', 1);           // 正轮到的人自己走了
  ok('轮到的人自己走了 → 位子交给下一位，不跳空',
    r4.match.order[r4.match.turn] === '3', r4.match.order[r4.match.turn]);

  const m5 = turnMatch(['1', '2', '3']);
  m5.turn = 2;                                   // 轮到 3 号
  const r5 = E.leaveMatch(m5, '3', 1);           // 最后一个走了 → 指针要夹回 0
  ok('最后一位走了，轮次指针夹回 0', r5.match.turn === 0, String(r5.match.turn));

  /* ③ 少到只剩一个活人 → 当场定局，不会把房间吊住 */
  const m6 = turnMatch(['1', '2']);
  const r6 = E.leaveMatch(m6, '1', 7000);
  ok('两人局走一个 → 另一个立刻胜出', r6.match.phase === 'over' && r6.match.winner === '2',
    r6.match.phase + '/' + r6.match.winner);
  ok('获胜原因是「最后一个站着的人」', r6.match.reason === 'last-standing', r6.match.reason);

  /* 一人局自己退出：没人接手，标成 all-left（不是 all-dead —— 他是走的，不是死的） */
  const m7 = turnMatch(['1']);
  const r7 = E.leaveMatch(m7, '1', 1);
  ok('一人局里唯一的人退出 → 本局结束且标成 all-left',
    r7.match.phase === 'over' && r7.match.reason === 'all-left', r7.match.reason);
  ok('走光后对局名单是空的', r7.match.order.length === 0, String(r7.match.order.length));
  ok('走光时没有赢家', r7.match.winner === null, String(r7.match.winner));

  /* ④ 死神追猎同样成立 */
  const r8 = E.leaveMatch(raceMatch(['1', '2', '3'], 1000), '2', 3000);
  ok('死神追猎：退场后名单少一人', r8.match.order.length === 2, String(r8.match.order.length));
  ok('死神追猎：退场不改变别人的进度',
    r8.match.players['1'].spins === 0 && r8.match.players['3'].spins === 0);
  const r9 = E.leaveMatch(raceMatch(['1', '2'], 1000), '2', 2000);
  ok('死神追猎：两人局走一个 → 另一个按「最后一个站着的人」胜出',
    r9.match.phase === 'over' && r9.match.reason === 'last-standing', r9.match.reason);

  /* ⑤ 边界 */
  const m8 = turnMatch(['1', '2']);
  const r10 = E.leaveMatch(m8, '9', 1);
  ok('退场的人根本不在局里 → 拒绝（no-such-player）',
    r10.events.length === 1 && r10.events[0].t === 'rejected'
    && r10.events[0].reason === 'no-such-player', JSON.stringify(r10.events));
  ok('拒绝时 seat 为 null（调用方据此别乱建观战席）', r10.seat === null, String(r10.seat));

  const over = E.leaveMatch(m8, '1', 1).match;
  const r11 = E.leaveMatch(over, '2', 1);
  ok('对局已结束就不能再退场 → 拒绝（game-over）',
    r11.events.length === 1 && r11.events[0].t === 'rejected'
    && r11.events[0].reason === 'game-over', JSON.stringify(r11.events));

  /* ⑥ 封存中允许退场 —— 否则有人掉线时别人就被锁死了 */
  const frozen = E.pauseMatch(turnMatch(['1', '2', '3']), 100);
  ok('封存中转动被拒（对照）',
    E.applyAction(frozen, { type: 'spin', playerId: '1' }, mulberry32(1)).events[0].reason === 'frozen');
  const r12 = E.leaveMatch(frozen, '3', 200);
  ok('封存中依然可以退出本局（不然被锁死）',
    r12.seat && r12.seat.id === '3' && r12.match.order.length === 2,
    JSON.stringify(r12.seat) + '/' + JSON.stringify(r12.match.order));
  ok('封存中退场不会顺手解封（掉线的人还没回来）',
    r12.match.frozen === true, String(r12.match.frozen));
}

/* ============================================================ */
console.log('\n=== 结果：' + PASS + ' 通过 / ' + FAIL + ' 失败 ===\n');
process.exit(FAIL > 0 ? 1 : 0);
