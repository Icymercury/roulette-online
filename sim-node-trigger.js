/* 补充模拟：多人模式下 V5 的三个关键节点还能不能触发
 * 31 转回满血 / 71 转镰刀 / 100 转绝境
 */
const MAX_HP = 7, MAX_SPIN = 100, ROUNDS = 20000;

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

function simShared(n){
  const hp = new Array(n).fill(MAX_HP);
  let k = 0, i = 0, alive = n;
  while (alive > 1 && k < MAX_SPIN){
    while (hp[i] <= 0) i = (i + 1) % n;
    const e = pick(probs(k));
    k++;
    if (DMG[e] > 0){ hp[i] -= DMG[e]; if (hp[i] <= 0){ hp[i] = 0; alive--; } }
    else if (HEAL[e] > 0) hp[i] = Math.min(MAX_HP, hp[i] + HEAL[e]);
    i = (i + 1) % n;
  }
  return { k, maxSp: k };
}

function simRace(n){
  const hp = new Array(n).fill(MAX_HP);
  const sp = new Array(n).fill(0);
  let alive = n;
  while (alive > 1){
    for (let i = 0; i < n && alive > 1; i++){
      if (hp[i] <= 0) continue;
      const e = pick(probs(sp[i]));
      sp[i]++;
      if (DMG[e] > 0){ hp[i] -= DMG[e]; if (hp[i] <= 0){ hp[i] = 0; alive--; } }
      else if (HEAL[e] > 0) hp[i] = Math.min(MAX_HP, hp[i] + HEAL[e]);
    }
  }
  return { k: sp.reduce((a, b) => a + b, 0), maxSp: Math.max(...sp) };
}

function rate(label, sim, n){
  let r31 = 0, r71 = 0, r100 = 0, sumMax = 0;
  for (let r = 0; r < ROUNDS; r++){
    const x = sim(n);
    if (x.maxSp >= 31) r31++;
    if (x.maxSp >= 71) r71++;
    if (x.maxSp >= MAX_SPIN) r100++;
    sumMax += x.maxSp;
  }
  console.log(
    `  ${n} 人 | 最高转数均值 ${(sumMax / ROUNDS).toFixed(1)}` +
    ` | 31 节点触发 ${(r31 / ROUNDS * 100).toFixed(1)}%` +
    ` | 71 镰刀 ${(r71 / ROUNDS * 100).toFixed(1)}%` +
    ` | 100 绝境 ${(r100 / ROUNDS * 100).toFixed(1)}%`
  );
}

console.log('\n===== 模式 A · 共享轮盘：按「总转数 k」判断节点 =====');
[2, 3, 4, 5].forEach(n => rate('A', simShared, n));

console.log('\n===== 模式 B · 独立轮盘：按「个人最高转数」判断节点 =====');
[2, 3, 4, 5].forEach(n => rate('B', simRace, n));

console.log('\n参考：单人版 V5 实际通关率约 22~24%，节点触发率高得多。');
console.log('每格 ' + ROUNDS + ' 局。\n');
