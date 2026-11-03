/* ============================================================
 * 死神追猎：100 转到底能不能完成？
 * ------------------------------------------------------------
 * 上一版 bot 的错误：一有钱就立刻买药水 → 利息本金永远压在低位
 * （实际收入只有 10 金/转）。正确打法必须先把本金攒到 500 吃满利息，
 * 并在 71 转涨价前把药水一次囤够。
 *
 * 本脚本用「每 tick 所有活跃玩家各转一次」模拟并行竞速。
 * ============================================================ */
'use strict';
const PROBS = [30,30,10,10,20];
function mul(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const tierOf = function(k){return k>=91?3:k>=81?2:k>=71?1:0;};

function runRace(N, seed, o) {
  const rng = mul(seed), hpMax = o.hpMax, target = 100, maxTicks = o.maxTicks || 400;
  const ps = [];
  for (let i=0;i<N;i++) ps.push({ i:i, hp:hpMax, gold:0, pot:0, charm:0, prePot:0, postBought:0, spins:0, banana:0, alive:true, done:false, doneTick:null, deadTick:null });

  for (let tick = 0; tick < maxTicks; tick++) {
    for (const p of ps) {
      if (!p.alive || p.done) continue;
      const t = tierOf(p.spins);

      /* ---- 商店策略 ---- */
      if (o.shop) {
        const potPrice = o.doubling ? (p.spins >= 71 ? 300 * Math.pow(2, p.postBought) : 300) : 300;
        if (p.spins >= o.stockSpin) {                 // 71 转前一次性囤货
          while (p.gold >= potPrice && p.pot < 40) { p.gold -= potPrice; p.pot += 1; if (p.spins >= 71) p.postBought += 1; else p.prePot += 1; }
        }
        if (p.gold >= 100 && p.charm < 2 && p.hp <= t + 3) { p.gold -= 100; p.charm += 1; }
        if (p.pot > 0 && p.hp <= t + o.healDelta && p.hp < hpMax) { p.pot -= 1; p.hp = hpMax; }
      }

      /* ---- 镰刀（按各自转数） ---- */
      if (t > 0) {
        if (p.hp - t <= 0 && p.charm > 0) { p.charm -= 1; p.hp = 1; }
        else { p.hp -= t; if (p.hp <= 0) { p.hp = 0; p.alive = false; p.deadTick = tick; continue; } }
      }

      /* ---- 掷骰 ---- */
      const gb = p.gold;
      const r = rng()*100; let acc=0, idx=4;
      for (let i=0;i<5;i++){acc+=PROBS[i];if(r<acc){idx=i;break;}}
      if (p.banana > 0) p.banana -= 1; else p.spins += 1;

      if (idx===0||idx===2) { const d=idx===0?1:2;
        if (p.hp-d<=0&&p.charm>0){p.charm-=1;p.hp=1;}
        else { p.hp -= d; if (p.hp<=0){ p.hp=0; p.alive=false; p.deadTick=tick; continue; } }
      } else if (idx===1||idx===3) { p.hp = Math.min(hpMax, p.hp + (idx===1?1:2)); }
      else { p.gold += 50; }

      if (o.interest !== 'off') {
        const it = o.interest === 'principal500' ? Math.floor(Math.min(gb,500)/10) : Math.floor(gb/10);
        if (it > 0) p.gold += it;
      }
      if (p.spins >= target) { p.done = true; p.doneTick = tick; }
    }
  }
  return ps;
}
const avg=function(a){return a.length?a.reduce(function(s,x){return s+x;},0)/a.length:NaN;};
const pct=function(x){return (x*100).toFixed(1)+'%';};

const BASE = { hpMax:10, interest:'principal500', shop:true, doubling:true, stockSpin:63, healDelta:2 };

console.log('════════ 死神追猎 · 100 转完成率（每组 600 局，每 tick 全员各转一次）════════\n');
console.log('配置                                          完成100转人数   撞线(≥1人完成)   全灭   平均完成tick');
const CASES = [
  { k:'10血 + 利息封顶500 + 71后翻倍 + 囤货@63', o:{} },
  { k:'10血 + 利息封顶500 + 71后翻倍 + 囤货@66', o:{ stockSpin:66 } },
  { k:'10血 + 利息封顶500 + 无翻倍   + 囤货@63', o:{ doubling:false } },
  { k:'10血 + 利息封顶500 + 无翻倍   + 即时买  ', o:{ doubling:false, stockSpin:0 } },
  { k:'15血 + 利息封顶500 + 71后翻倍 + 囤货@63', o:{ hpMax:15 } },
  { k:'20血 + 利息封顶500 + 71后翻倍 + 囤货@63', o:{ hpMax:20 } },
  { k:'10血 + 无利息     + 71后翻倍 + 囤货@63', o:{ interest:'off' } },
];
for (const c of CASES) {
  const T = 400, N = 2;
  let doneTot=0, hit=0, wipe=0; const ticks=[];
  for (let s=0;s<T;s++){
    const ps = runRace(N, 4000+s*7919, Object.assign({}, BASE, c.o));
    const d = ps.filter(function(p){return p.done;});
    doneTot += d.length;
    if (d.length) { hit++; ticks.push(Math.min.apply(null, d.map(function(p){return p.doneTick;}))); }
    if (ps.every(function(p){return !p.alive;})) wipe++;
  }
  console.log(c.k.padEnd(45) + (doneTot/T).toFixed(2).padEnd(15) + pct(hit/T).padEnd(17) + pct(wipe/T).padEnd(7) + (ticks.length?avg(ticks).toFixed(1):'—'));
}
console.log('');

console.log('════════ 手算：撑到 100 转需要多少资源 ════════\n');
{
  let need = 0;
  for (let s=0;s<100;s++) need += tierOf(s);
  console.log('  71~100 转累计镰刀伤害 = ' + need + ' 血');
  console.log('  10 血起手、药水只能补到 10 → 需补 ' + (need + 10 - 1) + ' 血 ≈ ' + Math.ceil((need+10)/10) + ' 瓶药水（按每次满额补 10 算）');
  console.log('  单局金币收入上限 = 10 金/转 × 100 + 利息 50 金/转 × (100−18) ≈ ' + (10*100+50*82) + ' 金');
  console.log('  71 转前 300 金/瓶 → 最多囤 ' + Math.floor((10*100+50*82)/300) + ' 瓶；若拖到 71 转后买，300→600→1200→2400 只够 4 瓶');
  console.log('');
  const ps = runRace(2, 12345, Object.assign({}, BASE, {}));
  ps.forEach(function(p){ console.log('  样例玩家'+p.i+'：完成=' + p.done + ' 转数=' + p.spins + ' 71转前囤药水=' + p.prePot + ' 71转后买=' + p.postBought + ' 存活=' + p.alive + ' 完成tick=' + p.doneTick + ' 死亡tick=' + p.deadTick); });
}
console.log('');
