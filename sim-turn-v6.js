/* ============================================================
 * 轮流转盘 · 新规则（V6 草案）终止性验证
 * ------------------------------------------------------------
 * 待验证规则：
 *   · 轮流转盘（共享轮盘，轮流转动）
 *   · 转盘后概率不再变化：固定 [扣1 30, 加1 30, 扣2 10, 加2 10, 金币 20]
 *   · 每人 15 滴血
 *   · 删除 31 转节点
 *   · 71 转节点不再回血，只保留「此后每转转动前扣血」
 *   · 81 转后每转扣 2 滴，91 转后每转扣 3 滴（逐转叠加，非一次性）
 *
 * 核心问题：会不会出现两人都不死（僵局）？
 * ============================================================ */

'use strict';

const N_TRIALS = 2000;     // 每格样本数
const CAP = 1200;          // 判定僵局的转数上限
const PROBS = [30, 30, 10, 10, 20];   // 扣1 / 加1 / 扣2 / 加2 / 金币（固定，不再随转数变化）

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 转动前的轮盘读数 k → 本次镰刀扣血档位 */
function scytheTier(k) { return k >= 91 ? 3 : k >= 81 ? 2 : k >= 71 ? 1 : 0; }

function run(N, seed, o) {
  const rng = mulberry32(seed);
  const hpMax = 15;
  const ps = [];
  for (let i = 0; i < N; i++) ps.push({ i: i, hp: hpMax, gold: 0, pot: 0, charm: 0, alive: true, spins: 0 });

  let k = 0, turn = 0;
  let firstDeathK = null, scytheKills = 0, wheelKills = 0, pre71Deaths = 0, hpAt71 = null;

  for (;;) {
    let alive = 0;
    for (let i = 0; i < N; i++) if (ps[i].alive) alive++;
    if (alive <= 1) {
      let w = -1;
      for (let i = 0; i < N; i++) if (ps[i].alive) w = i;
      return { end: 'end', k: k, winner: w, firstDeathK: firstDeathK, scytheKills: scytheKills, wheelKills: wheelKills, pre71Deaths: pre71Deaths, hpAt71: hpAt71, spins: ps.map(function (p) { return p.spins; }) };
    }
    if (k >= CAP) return { end: 'stalemate', k: k, winner: -1, firstDeathK: firstDeathK, scytheKills: scytheKills, wheelKills: wheelKills, pre71Deaths: pre71Deaths, hpAt71: hpAt71, spins: ps.map(function (p) { return p.spins; }) };

    const p = ps[turn];
    if (!p.alive) { turn = (turn + 1) % N; continue; }

    const t = scytheTier(k);

    /* ---- 道具：保命优先（最有利于「不死」的打法） ---- */
    if (o.shop) {
      if (p.gold >= 300 && p.pot < 1) { p.gold -= 300; p.pot += 1; }
      if (p.pot > 0 && p.hp <= t + 2 && p.hp < hpMax) { p.pot -= 1; p.hp = hpMax; }
      if (o.charmOn && p.gold >= 100 && p.charm < 1 && p.hp <= t + 2) { p.gold -= 100; p.charm += 1; }
    }

    /* ---- 镰刀：转动前先扣，扣死就没有转盘了 ---- */
    if (t > 0) {
      if (p.hp - t <= 0 && p.charm > 0) { p.charm -= 1; p.hp = 1; }
      else {
        p.hp -= t;
        if (p.hp <= 0) {
          p.hp = 0; p.alive = false; scytheKills++;
          if (firstDeathK === null) firstDeathK = k;
          if (k < 71) pre71Deaths++;
          turn = (turn + 1) % N; continue;
        }
      }
    }

    /* ---- 掷骰（固定概率） ---- */
    const goldBefore = p.gold;
    const r = rng() * 100;
    let acc = 0, idx = 4;
    for (let i = 0; i < 5; i++) { acc += PROBS[i]; if (r < acc) { idx = i; break; } }
    p.spins += 1; k += 1;
    if (k === 71 && hpAt71 === null) hpAt71 = ps.map(function (q) { return q.hp; });

    if (idx === 0 || idx === 2) {
      const d = idx === 0 ? 1 : 2;
      if (p.hp - d <= 0 && p.charm > 0) { p.charm -= 1; p.hp = 1; }
      else {
        p.hp -= d;
        if (p.hp <= 0) {
          p.hp = 0; p.alive = false; wheelKills++;
          if (firstDeathK === null) firstDeathK = k;
          if (k < 71) pre71Deaths++;
        }
      }
    } else if (idx === 1 || idx === 3) {
      if (!(o.healOffAfter71 && k >= 71)) p.hp = Math.min(hpMax, p.hp + (idx === 1 ? 1 : 2));
    } else {
      p.gold += 50;
    }

    /* ---- 死神利息 ---- */
    if (p.alive && o.interest) {
      const it = Math.floor(goldBefore / 10);
      if (it > 0) p.gold += it;
    }

    turn = (turn + 1) % N;
  }
}

/* ---------------- 配置矩阵 ---------------- */
const CONFIGS = [
  { key: '① 沿用现状：利息开 + 商场开', interest: true, shop: true, charmOn: true, healOffAfter71: false },
  { key: '② 利息开 + 商场关', interest: true, shop: false, charmOn: false, healOffAfter71: false },
  { key: '③ 利息关 + 商场开', interest: false, shop: true, charmOn: true, healOffAfter71: false },
  { key: '④ 利息关 + 商场关', interest: false, shop: false, charmOn: false, healOffAfter71: false },
  { key: '⑤ 利息关 + 商场关 + 71 后禁疗', interest: false, shop: false, charmOn: false, healOffAfter71: true },
];

function pct(x) { return (x * 100).toFixed(1) + '%'; }
function avg(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }
function median(a) { const b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.floor(b.length / 2)]; }
function pctl(a, q) { const b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.min(b.length - 1, Math.floor(b.length * q))]; }

console.log('轮流转盘 · V6 草案终止性验证   每组 ' + N_TRIALS + ' 局，僵局上限 ' + CAP + ' 转');
console.log('固定概率 扣1 30% / 加1 30% / 扣2 10% / 加2 10% / 金币 20%    每人 15 血');
console.log('');

for (const cfg of CONFIGS) {
  console.log('════ ' + cfg.key + ' ════');
  console.log('人数   僵局率    平均结束转数   中位/最长   k=71时平均血量   首次死亡转数   死于71前');
  for (const N of [2, 3, 4, 5]) {
    const lens = [], stalemates = [], hp71 = [], fdk = [], pre = [];
    let stuck = 0;
    for (let s = 0; s < N_TRIALS; s++) {
      const r = run(N, 1000 + s * 7919 + N * 13, cfg);
      if (r.end === 'stalemate') { stuck++; stalemates.push(r.k); } else lens.push(r.k);
      if (r.hpAt71) hp71.push(avg(r.hpAt71));
      if (r.firstDeathK !== null) fdk.push(r.firstDeathK);
      pre.push(r.pre71Deaths > 0 ? 1 : 0);
    }
    const all = lens.concat(stalemates);
    console.log(
      String(N).padEnd(6) +
      pct(stuck / N_TRIALS).padEnd(9) +
      (lens.length ? (avg(lens).toFixed(1) + ' 转').padEnd(14) : '—'.padEnd(14)) +
      (lens.length ? (median(lens) + ' / ' + Math.max.apply(null, lens)).padEnd(11) : '—'.padEnd(11)) +
      (hp71.length ? avg(hp71).toFixed(1).padEnd(16) : '—'.padEnd(16)) +
      (fdk.length ? avg(fdk).toFixed(1).padEnd(14) : '—'.padEnd(14)) +
      pct(pre.reduce(function (a, b) { return a + b; }, 0) / N_TRIALS)
    );
  }
  console.log('');
}
