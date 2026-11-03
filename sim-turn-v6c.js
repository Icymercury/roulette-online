/* ============================================================
 * 轮流转盘 · V6 补充验证
 *  A. 崩溃临界点证明（利息本金封顶 590 vs 610）
 *  B. 三段镰刀的「可见度」：81 转 / 91 转 之后还剩多少局
 *  C. 另一种读法：镰刀扣血是给「转动者」还是「所有人」
 * ============================================================ */
'use strict';
const PROBS = [30, 30, 10, 10, 20];
function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}

function run(N, seed, o) {
  const rng = mulberry32(seed), hpMax = 15, cap = o.cap || 1500;
  const ps = [];
  for (let i = 0; i < N; i++) ps.push({ i:i, hp:hpMax, gold:0, pot:0, charm:0, alive:true });
  let k = 0, turn = 0;
  let tierSpins = [0,0,0], reached81 = 0, reached91 = 0, firstDeathK = null;
  for (;;) {
    let alive = 0; for (let i=0;i<N;i++) if (ps[i].alive) alive++;
    if (alive <= 1) return { end:'end', k:k, firstDeathK:firstDeathK, tierSpins:tierSpins, reached81:reached81, reached91:reached91 };
    if (k >= cap) return { end:'stalemate', k:k, firstDeathK:firstDeathK, tierSpins:tierSpins, reached81:reached81, reached91:reached91 };
    const p = ps[turn];
    if (!p.alive) { turn = (turn+1)%N; continue; }
    const t = k>=91?3 : k>=81?2 : k>=71?1 : 0;
    const targets = o.scytheAll ? ps.filter(function(q){return q.alive;}) : [p];

    if (o.potion !== 'off') {
      if (p.gold>=300 && p.pot<1) { p.gold-=300; p.pot+=1; }
      if (p.pot>0 && p.hp<=t+2 && p.hp<hpMax) { p.pot-=1; p.hp=hpMax; }
      if (o.charm && p.gold>=100 && p.charm<1 && p.hp<=t+2) { p.gold-=100; p.charm+=1; }
    }
    if (t>0) {
      for (const q of targets) {
        if (q.hp - t <= 0 && q.charm > 0) { q.charm -= 1; q.hp = 1; }
        else { q.hp -= t; if (q.hp <= 0) { q.hp = 0; q.alive = false; if (firstDeathK===null) firstDeathK = k; } }
      }
      if (!o.scytheAll && !p.alive) { turn=(turn+1)%N; continue; }
    }
    const goldBefore = p.gold;
    const r = rng()*100; let acc=0, idx=4;
    for (let i=0;i<5;i++){acc+=PROBS[i];if(r<acc){idx=i;break;}}
    k += 1;
    if (k === 82) reached81 = 1;
    if (k === 92) reached91 = 1;
    if (t === 1) tierSpins[0]++;
    else if (t === 2) tierSpins[1]++;
    else if (t === 3) tierSpins[2]++;

    if (idx===0 || idx===2) {
      const d = idx===0?1:2;
      if (p.hp-d<=0 && p.charm>0) { p.charm-=1; p.hp=1; }
      else { p.hp -= d; if (p.hp<=0){p.hp=0;p.alive=false; if(firstDeathK===null) firstDeathK=k;} }
    } else if (idx===1 || idx===3) {
      p.hp = Math.min(hpMax, p.hp + (idx===1?1:2));
    } else { p.gold += 50; }

    if (p.alive && o.interest !== 'off') {
      const base = o.interest === 'full' ? goldBefore : Math.min(goldBefore, o.interest);
      const it = Math.floor(base/10); if (it>0) p.gold += it;
    }
    turn = (turn+1)%N;
  }
}
function avg(a){return a.length?a.reduce(function(s,x){return s+x;},0)/a.length:NaN;}
function pct(x){return (x*100).toFixed(1)+'%';}

console.log('════════ A. 利息本金封顶 → 崩溃临界点（2 人局，3000 局）════════\n');
console.log('利息本金封顶   每回合最高利息   2人僵局率   4人僵局率   （理论临界：本金 600 时收入 70 金/回合 > 需要的 60）');
for (const capv of [400, 500, 550, 590, 600, 650, 1000]) {
  const res = [2,4].map(function(N){
    let stuck=0; const T=1500;
    for (let s=0;s<T;s++){ const r=run(N, 9001+s*7919+N*17, {interest:capv, potion:'on', charm:true, cap:1500}); if(r.end==='stalemate')stuck++; }
    return stuck/T;
  });
  console.log(String(capv).padEnd(15) + (capv/10).toFixed(0).padEnd(17) + pct(res[0]).padEnd(12) + pct(res[1]));
}
console.log('');

console.log('════════ B. 三段镰刀的可见度（删掉利息，其余照你说的）════════\n');
console.log('人数   平均转数   到达81转的局   到达91转的局   平均停在tier1   平均停在tier2   平均停在tier3');
for (const N of [2,3,4,5]) {
  const lens=[], r81=[], r91=[], t1=[], t2=[], t3=[];
  for (let s=0;s<3000;s++){
    const r = run(N, 4242+s*104729+N*13, {interest:'off', potion:'on', charm:true});
    lens.push(r.k); r81.push(r.reached81); r91.push(r.reached91);
    t1.push(r.tierSpins[0]); t2.push(r.tierSpins[1]); t3.push(r.tierSpins[2]);
  }
  const sum=function(a){return a.reduce(function(x,y){return x+y;},0);};
  console.log(String(N).padEnd(6)+avg(lens).toFixed(1).padEnd(11)+pct(sum(r81)/3000).padEnd(15)+pct(sum(r91)/3000).padEnd(15)+
    avg(t1).toFixed(1).padEnd(16)+avg(t2).toFixed(1).padEnd(16)+avg(t3).toFixed(1));
}
console.log('');

console.log('════════ C. 另一种读法：镰刀扣血给「所有人」（2 人局，删利息）════════\n');
console.log('扣血对象        2人平均转数   4人平均转数   5人平均转数');
for (const all of [false, true]) {
  const row = [2,4,5].map(function(N){
    const lens=[];
    for (let s=0;s<1500;s++){ const r=run(N, 555+s*7919+N*31, {interest:'off', potion:'on', charm:true, scytheAll:all}); lens.push(r.k); }
    return avg(lens);
  });
  console.log((all?'所有人每转都扣':'仅转动者扣').padEnd(16)+row.map(function(x){return x.toFixed(1).padEnd(14);}).join(''));
}
console.log('');
