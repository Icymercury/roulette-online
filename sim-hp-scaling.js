/* 第三轮：多人模式下血量该设多少，才能让死神节点重新可见
 * 依据：累计净伤害 ≈ 0.0065·k²；淘汰赛需打掉 (n-1)×HP
 * 令 0.0065·T² = (n-1)×HP·修正 → 反推 HP
 */
const MAX_SPIN = 100, ROUNDS = 20000, BASE_HP = 7;

function probs(n){
  n = Math.min(n, MAX_SPIN);
  return [
    30 + 0.4*n,
    Math.max(0, 30 - 0.3*n),
    10 + 0.2*n,
    Math.max(0, 10 - 0.1*n),
    Math.max(0, 20 - 0.2*n),
  ];
}
function pick(p){
  const r = Math.random() * 100;
  let acc = 0;
  for (let i = 0; i < 5; i++) { acc += p[i]; if (r < acc) return i; }
  return 4;
}
const DMG = [1, 0, 2, 0, 0], HEAL = [0, 1, 0, 2, 0];

function simShared(n, hpMax){
  const hp = new Array(n).fill(hpMax);
  const wins = new Array(n).fill(0);
  let k = 0, i = 0, alive = n, maxK = 0;
  while (alive > 1 && k < MAX_SPIN){
    while (hp[i] <= 0) i = (i + 1) % n;
    const e = pick(probs(k));
    k++;
    if (DMG[e] > 0){ hp[i] -= DMG[e]; if (hp[i] <= 0){ hp[i] = 0; alive--; } }
    else if (HEAL[e] > 0) hp[i] = Math.min(hpMax, hp[i] + HEAL[e]);
    i = (i + 1) % n;
  }
  const w = hp.findIndex(h => h > 0);
  if (w >= 0) wins[w]++;
  return { k, maxK: k, wins };
}

function run(n, hpDelta){
  const hpMax = BASE_HP + hpDelta * (n - 1);
  let sumK = 0, r31 = 0, r71 = 0, r100 = 0;
  const wins = new Array(n).fill(0);
  for (let r = 0; r < ROUNDS; r++){
    const x = simShared(n, hpMax);
    sumK += x.k;
    if (x.k >= 31) r31++;
    if (x.k >= 71) r71++;
    if (x.k >= MAX_SPIN) r100++;
    for (let i = 0; i < n; i++) wins[i] += x.wins[i];
  }
  const avg = sumK / ROUNDS;
  const spread = Math.max(...wins) / ROUNDS * 100 - Math.min(...wins) / ROUNDS * 100;
  console.log(
    `  血量 ${String(hpMax).padStart(3)} | 整局 ${avg.toFixed(1).padStart(5)} 转` +
    ` | 人均 ${(avg / n).toFixed(1).padStart(4)} 次` +
    ` | 31 节点 ${(r31 / ROUNDS * 100).toFixed(1).padStart(5)}%` +
    ` | 71 镰刀 ${(r71 / ROUNDS * 100).toFixed(1).padStart(5)}%` +
    ` | 100 绝境 ${(r100 / ROUNDS * 100).toFixed(1).padStart(5)}%` +
    ` | 位置差 ${spread.toFixed(1)}pp`
  );
}

console.log('\n模式 A · 共享轮盘（淘汰赛）· 血量随人数放大 —— 目标：节点可见度≈单人版');
console.log('单人版基准：31 节点 61.4% / 71 镰刀 25.2% / 绝境 22%\n');
for (const n of [2, 3, 4, 5]){
  console.log(`--- ${n} 人局 ---`);
  for (const d of [0, 2, 3, 5, 7]) run(n, d);
  console.log('');
}
