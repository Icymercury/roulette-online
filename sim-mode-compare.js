/* 多人模式节奏模拟
 * A. 共享轮盘（回合制 · 轮流转动 · 看谁先死）
 * B. 独立轮盘（同场竞速 · 各转各的 · 看谁先死）
 * 用 V5 现有概率公式，先看节奏与公平性，暂不含商场/节点/干扰
 */
const MAX_HP = 7, MAX_SPIN = 100, ROUNDS = 20000;

function probs(n){
  n = Math.min(n, MAX_SPIN);
  return [
    30 + 0.4*n,               // 扣1
    Math.max(0, 30 - 0.3*n),  // 加1
    10 + 0.2*n,               // 扣2
    Math.max(0, 10 - 0.1*n),  // 加2
    Math.max(0, 20 - 0.2*n),  // 金币
  ];
}
function pick(p){
  const r = Math.random() * 100;
  let acc = 0;
  for (let i = 0; i < 5; i++) { acc += p[i]; if (r < acc) return i; }
  return 4;
}
const DMG = [1, 0, 2, 0, 0], HEAL = [0, 1, 0, 2, 0];

/* ===== A. 共享轮盘：所有人推进同一个转数 k ===== */
function simShared(n){
  const hp = new Array(n).fill(MAX_HP);
  let k = 0, i = 0, alive = n, firstDeath = null;
  while (alive > 1 && k < MAX_SPIN){
    while (hp[i] <= 0) i = (i + 1) % n;
    const e = pick(probs(k));
    k++;
    if (DMG[e] > 0){
      hp[i] -= DMG[e];
      if (hp[i] <= 0){ hp[i] = 0; alive--; if (firstDeath === null) firstDeath = k; }
    } else if (HEAL[e] > 0){
      hp[i] = Math.min(MAX_HP, hp[i] + HEAL[e]);
    }
    i = (i + 1) % n;
  }
  return { total: k, firstDeath, winner: hp.findIndex(h => h > 0) };
}

/* ===== B. 独立轮盘：每人有自己的转数，同时推进 ===== */
function simRace(n){
  const hp = new Array(n).fill(MAX_HP);
  const sp = new Array(n).fill(0);
  let alive = n, t = 0, firstDeath = null;
  while (alive > 1 && t < MAX_SPIN * n){
    for (let i = 0; i < n && alive > 1; i++){
      if (hp[i] <= 0) continue;
      const e = pick(probs(sp[i]));
      sp[i]++; t++;
      if (DMG[e] > 0){
        hp[i] -= DMG[e];
        if (hp[i] <= 0){ hp[i] = 0; alive--; if (firstDeath === null) firstDeath = t; }
      } else if (HEAL[e] > 0){
        hp[i] = Math.min(MAX_HP, hp[i] + HEAL[e]);
      }
    }
  }
  return { total: t, firstDeath, winner: hp.findIndex(h => h > 0) };
}

function run(label, sim, n){
  let sumTotal = 0, sumFirst = 0, cntFirst = 0;
  const wins = new Array(n).fill(0);
  for (let r = 0; r < ROUNDS; r++){
    const x = sim(n);
    sumTotal += x.total;
    if (x.firstDeath !== null){ sumFirst += x.firstDeath; cntFirst++; }
    if (x.winner >= 0) wins[x.winner]++;
  }
  const effFirst = cntFirst ? sumFirst / cntFirst : 0;
  const winStr = wins.map((w, i) => `P${i} ${(w / ROUNDS * 100).toFixed(1)}%`).join(' / ');
  console.log(
    `  ${n} 人 | 整局平均 ${(sumTotal / ROUNDS).toFixed(1)} 转` +
    ` | 人均操作 ${(sumTotal / ROUNDS / n).toFixed(1)} 次` +
    ` | 首死 @${effFirst.toFixed(1)} 转`
  );
  console.log(`       位置胜率  ${winStr}`);
}

console.log('\n================ 模式 A · 共享轮盘（回合制）================');
console.log('（所有人推进同一个转数 k，概率随 k 递增，后手承担的扣血概率更高）');
[2, 3, 4, 5].forEach(n => run('A', simShared, n));

console.log('\n================ 模式 B · 独立轮盘（同场竞速）================');
console.log('（每人有自己的转数，概率各自独立递增，互不影响）');
[2, 3, 4, 5].forEach(n => run('B', simRace, n));

console.log('\n注：每格 ' + ROUNDS + ' 局；均不含商场道具、死神节点、干扰机制。\n');
