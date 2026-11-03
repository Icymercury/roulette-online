/* 死神追猎：为什么没人撑到 100 转 —— 逐转追踪 */
'use strict';
const PROBS=[30,30,10,10,20];
function mul(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const tierOf=function(k){return k>=91?3:k>=81?2:k>=71?1:0;};

function trace(seed, hpMax, healThresholdDelta, log) {
  const rng = mul(seed);
  let hp = hpMax, gold = 0, pot = 0, charm = 0, spins = 0, spent = 0, bought = 0;
  const marks = [];
  for (let n = 0; n < 400; n++) {
    const t = tierOf(spins);
    while (gold >= 300 && pot < 30) { gold -= 300; pot += 1; bought += 1; spent += 300; }
    if (gold >= 100 && charm < 3 && hp <= t + 3) { gold -= 100; charm += 1; }
    if (pot > 0 && hp <= t + healThresholdDelta && hp < hpMax) { pot -= 1; hp = hpMax; }
    if (t > 0) {
      if (hp - t <= 0 && charm > 0) { charm -= 1; hp = 1; }
      else { hp -= t; if (hp <= 0) { marks.push('死于第 ' + (spins+1) + ' 转（镰刀），金币 ' + gold + '，剩余药水 ' + pot); return { dead:true, spins:spins, marks:marks }; } }
    }
    const gb = gold;
    const r = rng()*100; let acc=0, idx=4;
    for (let i=0;i<5;i++){acc+=PROBS[i];if(r<acc){idx=i;break;}}
    spins += 1;
    if (idx===0||idx===2) { const d=idx===0?1:2;
      if (hp-d<=0&&charm>0){charm-=1;hp=1;} else {hp-=d; if(hp<=0){marks.push('死于第 '+spins+' 转（转盘），金币 '+gold+'，剩余药水 '+pot); return {dead:true,spins:spins,marks:marks};}}
    } else if (idx===1||idx===3) { hp = Math.min(hpMax, hp + (idx===1?1:2)); }
    else gold += 50;
    const it = Math.floor(Math.min(gb,500)/10); if (it>0) gold += it;
    if (spins % 20 === 0) marks.push('第 '+spins+' 转：血 '+hp+' 金 '+gold+' 药水 '+pot+' 已买 '+bought);
  }
  return { dead:false, spins:spins, marks:marks, hp:hp, gold:gold, pot:pot, bought:bought };
}

console.log('=== 单独一个玩家跑 100 转（10 血，镰刀按各自转数，利息本金封顶 500）===\n');
for (const hm of [10]) {
  let survived = 0, deathSpins = [];
  const T = 3000;
  for (let s = 0; s < T; s++) {
    const r = trace(s + 1, hm, 2);
    if (!r.dead) survived++; else deathSpins.push(r.spins);
  }
  console.log('血量上限 ' + hm + '：' + T + ' 次模拟中撑到 100 转 ' + survived + ' 次（' + (survived/T*100).toFixed(1) + '%）');
  if (deathSpins.length) {
    deathSpins.sort(function(a,b){return a-b;});
    console.log('  死亡转数：中位 ' + deathSpins[Math.floor(deathSpins.length/2)] +
      '   最早 ' + deathSpins[0] + '   最晚 ' + deathSpins[deathSpins.length-1] +
      '   平均 ' + (deathSpins.reduce(function(a,b){return a+b;},0)/deathSpins.length).toFixed(1));
  }
  console.log('');
}

console.log('=== 前 3 次模拟的轨迹 ===\n');
for (let s = 1; s <= 3; s++) {
  const r = trace(s, 10, 2);
  console.log('模拟 ' + s + '：' + (r.dead ? '死亡' : '活到 100 转'));
  r.marks.forEach(function(m){ console.log('    ' + m); });
  console.log('');
}

console.log('=== 需要的治疗量（手算）===\n');
let need = 0;
for (let spins = 0; spins < 100; spins++) need += tierOf(spins);
console.log('  1→100 转累计镰刀伤害 = ' + need + ' 血');
console.log('  （0~70 转 0；71~80 转 ×1；81~90 转 ×2；91~99 转 ×3）');
console.log('  起手只有 10 血，且药水只能补到 10 → 至少需要约 ' + Math.ceil((need)/10) + ' 瓶药水（每瓶最多补 10）');
console.log('  金币收入上限 = 金币格 10 金/转 + 利息 50 金/转 = 60 金/转');
console.log('  100 转总收入 ≈ ' + (60*100) + ' 金 → 最多买 ' + Math.floor(60*100/300) + ' 瓶药水');
console.log('');
