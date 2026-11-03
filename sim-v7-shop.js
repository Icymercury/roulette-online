/* ============================================================
 * V7 · 新商场规则的终止性验证
 * ------------------------------------------------------------
 * 规则（对赌轮盘）：
 *   · 固定概率 [30,30,10,10,20]，15 血，无 31 转
 *   · k>=71 每转对转动者扣 1 / >=81 扣 2 / >=91 扣 3（逐转叠加）
 *   · 71 转不清空道具（允许囤货）
 *   · 死神利息本金封顶 500  → 每转利息最多 +50
 *   · 道具价格：71 转后每买一次翻倍涨
 *
 * 关键风险：允许囤货 + 利息封顶后，玩家能不能囤出「不死」的药水墙？
 * ============================================================ */
'use strict';
const PROBS = [30, 30, 10, 10, 20];
function mul(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const tierOf = function(k){return k>=91?3:k>=81?2:k>=71?1:0;};

/* o: { interest:'principal500'|'payment500'|'full'|'off',
 *      scope:'player'|'global', counting:'post71'|'all', cap:N, hoardCap:N } */
function run(N, seed, o) {
  const rng = mul(seed), hpMax = 15, cap = o.cap || 3000;
  const ps = [];
  for (let i = 0; i < N; i++) ps.push({ i:i, hp:hpMax, gold:0, pot:0, charm:0, boughtPot:0, boughtCharm:0, alive:true, spins:0 });
  const gBought = { potion: 0, charm: 0 };   // 全局通胀计数

  let k = 0, turn = 0, potAt71 = null, firstDeathK = null;
  const hoardCap = o.hoardCap || 30;

  function price(base, itemKey, p) {
    const n = o.scope === 'global' ? gBought[itemKey] : (itemKey === 'potion' ? p.boughtPot : p.boughtCharm);
    let mult = 1;
    if (k >= 71) {
      if (o.counting === 'post71') mult = Math.pow(2, n - (o.scope === 'global' ? gBought['pre_' + itemKey] || 0 : (itemKey === 'potion' ? p.prePot || 0 : p.preCharm || 0)));
      else mult = Math.pow(2, n);
    }
    return base * Math.max(1, mult);
  }

  for (;;) {
    let alive = 0; for (let i = 0; i < N; i++) if (ps[i].alive) alive++;
    if (alive <= 1) return { end:'end', k:k, potAt71:potAt71, firstDeathK:firstDeathK };
    if (k >= cap) return { end:'stalemate', k:k, potAt71:potAt71, firstDeathK:firstDeathK };
    const p = ps[turn]; if (!p.alive) { turn = (turn+1)%N; continue; }
    const t = tierOf(k);

    /* 进场前把便宜货囤够（71 转前原价） */
    while (p.gold >= price(300,'potion',p) && p.pot < hoardCap) {
      const pr = price(300,'potion',p); p.gold -= pr; p.pot += 1; p.boughtPot += 1; gBought.potion += 1;
    }
    if (p.gold >= 100 && p.charm < 3 && p.hp <= t + 3) {
      const pr = price(100,'charm',p); if (p.gold >= pr) { p.gold -= pr; p.charm += 1; p.boughtCharm += 1; gBought.charm += 1; }
    }
    if (p.pot > 0 && p.hp <= t + 2 && p.hp < hpMax) { p.pot -= 1; p.hp = hpMax; }

    if (t > 0) {
      if (p.hp - t <= 0 && p.charm > 0) { p.charm -= 1; p.hp = 1; }
      else { p.hp -= t; if (p.hp <= 0) { p.hp = 0; p.alive = false; if (firstDeathK === null) firstDeathK = k; turn=(turn+1)%N; continue; } }
    }

    const gb = p.gold;
    const r = rng()*100; let acc=0, idx=4;
    for (let i=0;i<5;i++){acc+=PROBS[i];if(r<acc){idx=i;break;}}
    p.spins += 1; k += 1;
    if (k === 71 && potAt71 === null) potAt71 = ps.map(function(q){return q.pot;});

    if (idx===0||idx===2) {
      const d = idx===0?1:2;
      if (p.hp-d<=0 && p.charm>0) { p.charm-=1; p.hp=1; }
      else { p.hp -= d; if (p.hp<=0){p.hp=0;p.alive=false; if(firstDeathK===null)firstDeathK=k;} }
    } else if (idx===1||idx===3) { p.hp = Math.min(hpMax, p.hp + (idx===1?1:2)); }
    else { p.gold += 50; }

    if (p.alive && o.interest !== 'off') {
      let it;
      if (o.interest === 'principal500') it = Math.floor(Math.min(gb,500)/10);
      else if (o.interest === 'full') it = Math.floor(gb/10);
      else it = Math.min(500, Math.floor(gb/10));   // payment500
      if (it > 0) p.gold += it;
    }
    turn = (turn+1)%N;
  }
}
const avg = function(a){return a.length?a.reduce(function(s,x){return s+x;},0)/a.length:NaN;};
const pct = function(x){return (x*100).toFixed(1)+'%';};

console.log('════════ A. 对赌轮盘 · 新商场规则终止性（每组 1200 局，僵局上限 3000 转）════════\n');
const CASES = [
  { key:'利息本金封顶500 + 71后翻倍(每玩家)  ', o:{ interest:'principal500', scope:'player', counting:'post71' } },
  { key:'利息本金封顶500 + 71后翻倍(全局)    ', o:{ interest:'principal500', scope:'global', counting:'post71' } },
  { key:'利息本金封顶500 + 翻倍按总购买数    ', o:{ interest:'principal500', scope:'player', counting:'all' } },
  { key:'利息全额（不封顶）+ 71后翻倍        ', o:{ interest:'full',        scope:'player', counting:'post71' } },
  { key:'利息「收益」封顶500 + 71后翻倍      ', o:{ interest:'payment500',  scope:'player', counting:'post71' } },
  { key:'删掉利息 + 71后翻倍                  ', o:{ interest:'off',         scope:'player', counting:'post71' } },
];
console.log('方案                                2人僵局  2人均转数  71转时人均药水  3人  4人  5人');
for (const c of CASES) {
  const cell = [2,3,4,5].map(function(N){
    let stuck=0, lens=[], pot=[];
    const T=1200;
    for (let s=0;s<T;s++){
      const r = run(N, 8888+s*104729+N*31, c.o);
      if (r.end==='stalemate') stuck++; else lens.push(r.k);
      if (r.potAt71) pot.push(avg(r.potAt71));
    }
    return { sr:stuck/T, avg:avg(lens), pot:avg(pot) };
  });
  console.log(c.key.padEnd(37) + pct(cell[0].sr).padEnd(8) + (isNaN(cell[0].avg)?'—':cell[0].avg.toFixed(1)).padEnd(11) +
    cell[0].pot.toFixed(1).padEnd(16) + pct(cell[1].sr).padEnd(6) + pct(cell[2].sr).padEnd(6) + pct(cell[3].sr));
}
console.log('');

/* ==================== B. 死神追猎：10 血能不能撑到 100 转 ==================== */
console.log('════════ B. 死神追猎（10 血 / 镰刀按各自转数 / 目标 100 转）════════\n');
function runRace(N, seed, o) {
  const rng = mul(seed), hpMax = 10;
  const ps = [];
  for (let i=0;i<N;i++) ps.push({ i:i, hp:hpMax, gold:0, pot:0, charm:0, spat:0, boughtPot:0, spins:0, banana:0, alive:true, done:false });
  const target = 100, capSpins = 4000;
  let guard = 0;
  for (;;) {
    if (++guard > capSpins) return { stalled:true };
    const act = ps.filter(function(p){return p.alive && !p.done;});
    if (act.length <= 1) return { winner: act.length===1?act[0].i:-1, done: ps.filter(function(p){return p.done;}).length };
    const p = act[Math.floor(rng()*act.length)];   // 随机挑一个活跃玩家行动（模拟并行）
    const t = tierOf(p.spins);
    if (o.shop) {
      if (p.gold >= 300 && p.pot < 20) { p.gold -= 300; p.pot += 1; p.boughtPot += 1; }
      if (p.pot > 0 && p.hp <= t + 2 && p.hp < hpMax) { p.pot -= 1; p.hp = hpMax; }
      if (p.gold >= 100 && p.charm < 3 && p.hp <= t + 3) { p.gold -= 100; p.charm += 1; }
      if (o.banana && p.gold >= 150) {
        const foes = act.filter(function(q){return q.i!==p.i;});
        if (foes.length) { p.gold -= 150; foes[Math.floor(rng()*foes.length)].banana += 5; }
      }
    }
    if (t > 0) {
      if (p.hp - t <= 0 && p.charm > 0) { p.charm -= 1; p.hp = 1; }
      else { p.hp -= t; if (p.hp<=0){ p.hp=0; p.alive=false; continue; } }
    }
    const gb = p.gold;
    const r = rng()*100; let acc=0, idx=4;
    for (let i=0;i<5;i++){acc+=PROBS[i];if(r<acc){idx=i;break;}}
    if (p.banana > 0) p.banana -= 1; else p.spins += 1;   // 香蕉皮：转数不增，效果照常
    if (idx===0||idx===2) {
      const d = idx===0?1:2;
      if (p.hp-d<=0 && p.charm>0) { p.charm-=1; p.hp=1; }
      else { p.hp -= d; if (p.hp<=0){p.hp=0;p.alive=false;} }
    } else if (idx===1||idx===3) { p.hp = Math.min(hpMax, p.hp + (idx===1?1:2)); }
    else { p.gold += 50; }
    if (p.alive && o.interest !== 'off') {
      const it = o.interest === 'principal500' ? Math.floor(Math.min(gb,500)/10) : Math.floor(gb/10);
      if (it > 0) p.gold += it;
    }
    if (p.alive && p.spins >= target) p.done = true;
  }
}
console.log('人数   完成100转的人数(平均)   完成率   死亡人数(平均)   打到卡死');
for (const N of [2,3,4,5]) {
  let done=0, dead=0, stall=0, comp=[];
  const T=800;
  for (let s=0;s<T;s++){
    const r = runRace(N, 555+s*7919+N*17, {interest:'principal500', shop:true, banana:true});
    if (r.stalled) { stall++; continue; }
    comp.push(r.done);
    done += r.done;
    dead += N - r.done - (r.winner>=0?1:0);
  }
  console.log(String(N).padEnd(6)+avg(comp).toFixed(2).padEnd(22)+pct(avg(comp)/N).padEnd(9)+avg([dead/T]).toFixed(2).padEnd(17)+pct(stall/T));
}
console.log('');
