/* 第四轮：把「100 转绝境」从结束条件改成处决阶段
 * 原规则：k>=100 → 游戏结束（多人赛里会全员存活，分不出胜负）
 * 新规则：k>=100 → 扣血概率永久 100%（扣1 70% / 扣2 30%），游戏继续，直到只剩 1 人
 */
const MAX_SPIN = 100, ROUNDS = 20000, BASE_HP = 7;

function probs(n){
  if (n >= MAX_SPIN) return [70, 0, 30, 0, 0];
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

function sim(n, hpMax){
  const hp = new Array(n).fill(hpMax);
  let k = 0, i = 0, alive = n, enteredDoom = false, doomLen = 0;
  while (alive > 1){
    while (hp[i] <= 0) i = (i + 1) % n;
    const e = pick(probs(k));
    k++;
    if (k >= MAX_SPIN){ if (!enteredDoom){ enteredDoom = true; } doomLen++; }
    if (DMG[e] > 0){ hp[i] -= DMG[e]; if (hp[i] <= 0){ hp[i] = 0; alive--; } }
    else if (HEAL[e] > 0) hp[i] = Math.min(hpMax, hp[i] + HEAL[e]);
    i = (i + 1) % n;
  }
  return { k, winner: hp.findIndex(h => h > 0), enteredDoom, doomLen };
}

function run(n, hpDelta){
  const hpMax = BASE_HP + hpDelta * (n - 1);
  let sumK = 0, r31 = 0, r71 = 0, doom = 0, sumDoom = 0;
  const wins = new Array(n).fill(0);
  for (let r = 0; r < ROUNDS; r++){
    const x = sim(n, hpMax);
    sumK += x.k;
    if (x.k >= 31) r31++;
    if (x.k >= 71) r71++;
    if (x.enteredDoom){ doom++; sumDoom += x.doomLen; }
    wins[x.winner]++;
  }
  const avg = sumK / ROUNDS;
  const spread = Math.max(...wins) / ROUNDS * 100 - Math.min(...wins) / ROUNDS * 100;
  console.log(
    `  血量 ${String(hpMax).padStart(3)} | 整局 ${avg.toFixed(1).padStart(5)} 转` +
    ` | 人均 ${(avg / n).toFixed(1).padStart(4)} 次` +
    ` | 31 节点 ${(r31 / ROUNDS * 100).toFixed(1).padStart(5)}%` +
    ` | 71 镰刀 ${(r71 / ROUNDS * 100).toFixed(1).padStart(5)}%` +
    ` | 进入处决 ${(doom / ROUNDS * 100).toFixed(1).padStart(5)}%` +
    (doom ? ` (处决阶段均 ${(sumDoom / doom).toFixed(1)} 转)` : '              ') +
    ` | 位置差 ${spread.toFixed(1)}pp`
  );
}

console.log('\n模式 A · 共享轮盘 + 处决阶段（必分胜负，无平局）');
console.log('单人版基准：31 节点 61.4% / 71 镰刀 25.2% / 绝境 22%\n');
for (const n of [2, 3, 4, 5]){
  console.log(`--- ${n} 人局 ---`);
  for (const d of [0, 2, 3, 4, 5, 7]) run(n, d);
  console.log('');
}
