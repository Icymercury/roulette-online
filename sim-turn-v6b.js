/* ============================================================
 * 轮流转盘 · V6 僵局机制定位 + 修复方案对比
 * ============================================================ */

'use strict';

const PROBS = [30, 30, 10, 10, 20];
const TIER = function (k) { return k >= 91 ? 3 : k >= 81 ? 2 : k >= 71 ? 1 : 0; };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* o.interest : 'off' | 'full' | 数字(利息本金封顶值)
   o.potion   : 'on'  | 'off' | 'offAfter71' | 数字(限购次数)
   o.charm    : true/false
   o.cap      : 僵局判定转数 */
function run(N, seed, o) {
  const rng = mulberry32(seed);
  const hpMax = 15, cap = o.cap || 1200;
  const ps = [];
  for (let i = 0; i < N; i++) ps.push({ i: i, hp: hpMax, gold: 0, pot: 0, charm: 0, potBought: 0, alive: true, spins: 0 });

  let k = 0, turn = 0, firstDeathK = null, goldAt71 = null, immortalK = null, deathCauseScythe = 0, deathCauseWheel = 0;

  for (;;) {
    let alive = 0;
    for (let i = 0; i < N; i++) if (ps[i].alive) alive++;
    if (alive <= 1) { let w = -1; for (let i = 0; i < N; i++) if (ps[i].alive) w = i; return finish('end', w); }
    if (k >= cap) return finish('stalemate', -1);

    const p = ps[turn];
    if (!p.alive) { turn = (turn + 1) % N; continue; }

    const t = TIER(k);

    /* ---- 道具 ---- */
    const potionAllowed = o.potion !== 'off' && !(o.potion === 'offAfter71' && k >= 71);
    const potionLimit = typeof o.potion === 'number' ? o.potion : Infinity;
    if (o.potion !== 'off') {
      if (potionAllowed && p.gold >= 300 && p.pot < 1 && p.potBought < potionLimit) { p.gold -= 300; p.pot += 1; p.potBought += 1; }
      if (p.pot > 0 && p.hp <= t + 2 && p.hp < hpMax) { p.pot -= 1; p.hp = hpMax; }
      if (o.charm && p.gold >= 100 && p.charm < 1 && p.hp <= t + 2) { p.gold -= 100; p.charm += 1; }
    }

    /* ---- 镰刀 ---- */
    if (t > 0) {
      if (p.hp - t <= 0 && p.charm > 0) { p.charm -= 1; p.hp = 1; }
      else {
        p.hp -= t;
        if (p.hp <= 0) { p.hp = 0; p.alive = false; deathCauseScythe++; if (firstDeathK === null) firstDeathK = k; turn = (turn + 1) % N; continue; }
      }
    }

    /* ---- 掷骰 ---- */
    const goldBefore = p.gold;
    const r = rng() * 100;
    let acc = 0, idx = 4;
    for (let i = 0; i < 5; i++) { acc += PROBS[i]; if (r < acc) { idx = i; break; } }
    p.spins += 1; k += 1;
    if (k === 71 && goldAt71 === null) goldAt71 = ps.map(function (q) { return q.gold; });

    if (idx === 0 || idx === 2) {
      const d = idx === 0 ? 1 : 2;
      if (p.hp - d <= 0 && p.charm > 0) { p.charm -= 1; p.hp = 1; }
      else { p.hp -= d; if (p.hp <= 0) { p.hp = 0; p.alive = false; deathCauseWheel++; if (firstDeathK === null) firstDeathK = k; } }
    } else if (idx === 1 || idx === 3) {
      p.hp = Math.min(hpMax, p.hp + (idx === 1 ? 1 : 2));
    } else {
      p.gold += 50;
    }

    /* ---- 利息 ---- */
    if (p.alive && o.interest !== 'off') {
      const principal = o.interest === 'full' ? goldBefore : Math.min(goldBefore, o.interest);
      const it = Math.floor(principal / 10);
      if (it > 0) p.gold += it;
    }
    if (immortalK === null && p.gold >= 500) immortalK = k;

    turn = (turn + 1) % N;
  }

  function finish(kind, w) {
    return { end: kind, k: k, winner: w, firstDeathK: firstDeathK, goldAt71: goldAt71, immortalK: immortalK, scythe: deathCauseScythe, wheel: deathCauseWheel, last: ps };
  }
}

function avg(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : NaN; }
function pct(x) { return (x * 100).toFixed(1) + '%'; }

/* ============ A. 机制定位：钱从哪来、什么时候变成不死 ============ */
console.log('════════ A. 僵局机制定位（2 人局，利息开 + 商场开，2000 局）════════\n');
{
  let g71 = [], ik = [], stuck = 0, endK = [], lastGold = [];
  for (let s = 0; s < 2000; s++) {
    const r = run(2, 5000 + s * 104729, { interest: 'full', potion: 'on', charm: true });
    if (r.end === 'stalemate') { stuck++; lastGold.push(avg(r.last.map(function (p) { return p.gold; }))); }
    else { endK.push(r.k); lastGold.push(avg(r.last.map(function (p) { return p.gold; }))); }
    if (r.goldAt71) g71.push(avg(r.goldAt71));
    if (r.immortalK !== null) ik.push(r.immortalK);
  }
  console.log('  僵局率                      ' + pct(stuck / 2000));
  console.log('  k=71 时人均金币             ' + avg(g71).toFixed(0) + ' 金');
  console.log('  人均金币首次突破 500 的转数  ' + (ik.length ? avg(ik).toFixed(1) : '从未') + ' 转' + (ik.length ? '（' + pct(ik.length / 2000) + ' 的局会出现）' : ''));
  console.log('  终局时人均金币              ' + avg(lastGold).toFixed(0) + ' 金');
  console.log('  正常结束局的平均转数        ' + (endK.length ? avg(endK).toFixed(1) : '—') + ' 转');
  console.log('');
  console.log('  ── 不死门槛推导 ──');
  console.log('  91 转后镰刀每转对「转动者」扣 3 血，2 人局每人每 2 转挨 1 次 → 每个自己的回合挨 3 血');
  console.log('  要活下去必须每回合补 3 血：药水 300 金 / 15 血 → 需 300 × 3/15 = 60 金/回合');
  console.log('  每回合收入 = 金币格 10 金 + 利息 0.1 × 本金');
  console.log('  → 本金 > 500 金时，收入 ≥ 60 金/回合 ⇒ 药水无限买 ⇒ 数学上不死');
  console.log('');
}

/* ============ B. 修复方案对比 ============ */
console.log('════════ B. 修复方案对比（僵局率 / 平均结束转数）════════\n');
const FIXES = [
  { key: '现状：利息全额 + 药水护符', o: { interest: 'full', potion: 'on', charm: true } },
  { key: '修法①：删掉利息              ', o: { interest: 'off', potion: 'on', charm: true } },
  { key: '修法②：利息本金封顶 300     ', o: { interest: 300, potion: 'on', charm: true } },
  { key: '修法③：利息本金封顶 500     ', o: { interest: 500, potion: 'on', charm: true } },
  { key: '修法④：71 转后药水绝版      ', o: { interest: 'full', potion: 'offAfter71', charm: true } },
  { key: '修法⑤：药水限购 1 次        ', o: { interest: 'full', potion: 1, charm: true } },
  { key: '修法⑥：药水限购 2 次        ', o: { interest: 'full', potion: 2, charm: true } },
  { key: '修法⑦：删利息 + 药水不限    ', o: { interest: 'off', potion: 'on', charm: true } },
];
console.log('方案                          2人僵局   2人平均转数   4人僵局   4人平均转数   5人平均转数');
for (const f of FIXES) {
  const row = [2, 4, 5].map(function (N) {
    let stuck = 0; const lens = [];
    const T = 1500;
    for (let s = 0; s < T; s++) {
      const r = run(N, 31337 + s * 7919 + N * 101, Object.assign({}, f.o));
      if (r.end === 'stalemate') stuck++; else lens.push(r.k);
    }
    return { sr: stuck / T, avg: avg(lens) };
  });
  console.log(f.key.padEnd(30) + pct(row[0].sr).padEnd(10) + (isNaN(row[0].avg) ? '—' : row[0].avg.toFixed(1)).padEnd(14) +
    pct(row[1].sr).padEnd(10) + (isNaN(row[1].avg) ? '—' : row[1].avg.toFixed(1)).padEnd(14) +
    (isNaN(row[2].avg) ? '—' : row[2].avg.toFixed(1)));
}
console.log('');

/* ============ C. 座位公平性（4 人局，修法①） ============ */
console.log('════════ C. 座位公平性（4 人局，修法①：删掉利息）════════\n');
{
  const wins = [0, 0, 0, 0]; let n = 0, draw = 0;
  for (let s = 0; s < 8000; s++) {
    const r = run(4, 777 + s * 104729, { interest: 'off', potion: 'on', charm: true });
    if (r.winner >= 0) { wins[r.winner]++; n++; } else draw++;
  }
  console.log('  座位 0/1/2/3 胜率： ' + wins.map(function (w) { return pct(w / n); }).join('  |  ') +
    '     最大差 ' + ((Math.max.apply(null, wins) - Math.min.apply(null, wins)) / n * 100).toFixed(1) + 'pp');
  console.log('');
}

/* ============ D. 推荐方案完整数据 ============ */
console.log('════════ D. 推荐方案（删掉死神利息，其余照你说的）════════\n');
console.log('人数   平均转数   中位数   90分位   最长   人均操作   死于71转前   71转时人均血量');
for (const N of [2, 3, 4, 5]) {
  const lens = [], g71 = [], preD = [];
  let pre = 0;
  const T = 3000;
  for (let s = 0; s < T; s++) {
    const r = run(N, 2024 + s * 7919 + N * 131, { interest: 'off', potion: 'on', charm: true });
    lens.push(r.k);
    if (r.goldAt71) g71.push(0);
    if (r.firstDeathK !== null && r.firstDeathK < 71) pre++;
  }
  lens.sort(function (a, b) { return a - b; });
  console.log(String(N).padEnd(6) + avg(lens).toFixed(1).padEnd(11) + lens[Math.floor(lens.length / 2)].toString().padEnd(9) +
    lens[Math.floor(lens.length * 0.9)].toString().padEnd(9) + lens[lens.length - 1].toString().padEnd(7) +
    (avg(lens) / N).toFixed(1).padEnd(11) + pct(pre / T).padEnd(13) + '—');
}
console.log('');
