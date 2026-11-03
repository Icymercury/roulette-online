/* ============================================================
 * V9 · 用「正确打法」的 bot 重测两个模式
 * bot 策略：63 转前只攒钱（把利息本金顶到 500）→ 63~70 转在涨价前把药水囤够 →
 *          71 转后只在必要时按翻倍价补货；血量低于「镰刀档位+2」就喝药。
 * ============================================================ */
'use strict';
const PROBS=[30,30,10,10,20];
function mul(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const tierOf=function(k){return k>=91?3:k>=81?2:k>=71?1:0;};
const avg=function(a){return a.length?a.reduce(function(s,x){return s+x;},0)/a.length:NaN;};
const pct=function(x){return (x*100).toFixed(1)+'%';};

/* ============ 对赌轮盘（共享轮盘，镰刀按全局 k） ============ */
function runDuel(N, seed, o) {
  const rng=mul(seed), hpMax=o.hpMax||15, cap=o.cap||6000;
  const ps=[];
  for(let i=0;i<N;i++) ps.push({i:i,hp:hpMax,gold:0,pot:0,charm:0,prePot:0,postBought:0,spins:0,alive:true});
  let k=0, turn=0, potAt71=null, firstDeathK=null, maxPot=0;

  for(;;){
    let alive=0; for(let i=0;i<N;i++) if(ps[i].alive) alive++;
    if(alive<=1) return {end:'end',k:k,potAt71:potAt71,firstDeathK:firstDeathK,maxPot:maxPot};
    if(k>=cap) return {end:'stalemate',k:k,potAt71:potAt71,firstDeathK:firstDeathK,maxPot:maxPot};
    const p=ps[turn]; if(!p.alive){turn=(turn+1)%N;continue;}
    const t=tierOf(k);

    /* --- bot 商店策略 --- */
    if(t===0 && p.gold>=100 && p.charm<1) { p.gold-=100; p.charm+=1; }
    const price = k>=71 ? 300*Math.pow(2,p.postBought) : 300;
    if(k>=o.stockFrom){
      while(p.gold>=price && p.pot<o.potCap){ p.gold-=price; p.pot+=1; if(k>=71)p.postBought+=1; else p.prePot+=1; }
    }
    if(p.pot>p?false:false){}
    if(p.pot>0 && p.hp<=t+o.healDelta && p.hp<hpMax){ p.pot-=1; p.hp=hpMax; }
    if(p.pot>maxPot) maxPot=p.pot;

    if(t>0){
      if(p.hp-t<=0&&p.charm>0){p.charm-=1;p.hp=1;}
      else{p.hp-=t;if(p.hp<=0){p.hp=0;p.alive=false;if(firstDeathK===null)firstDeathK=k;turn=(turn+1)%N;continue;}}
    }

    const gb=p.gold;
    const r=rng()*100;let acc=0,idx=4;
    for(let i=0;i<5;i++){acc+=PROBS[i];if(r<acc){idx=i;break;}}
    p.spins+=1;k+=1;
    if(k===71&&potAt71===null)potAt71=ps.map(function(q){return q.pot;});

    if(idx===0||idx===2){const d=idx===0?1:2;
      if(p.hp-d<=0&&p.charm>0){p.charm-=1;p.hp=1;}
      else{p.hp-=d;if(p.hp<=0){p.hp=0;p.alive=false;if(firstDeathK===null)firstDeathK=k;}}
    }else if(idx===1||idx===3){p.hp=Math.min(hpMax,p.hp+(idx===1?1:2));}
    else p.gold+=50;

    if(p.alive&&o.interest!=='off'){
      const it=o.interest==='principal500'?Math.floor(Math.min(gb,500)/10):Math.floor(gb/10);
      if(it>0)p.gold+=it;
    }
    turn=(turn+1)%N;
  }
}

console.log('════════ A. 对赌轮盘 · 正确打法下会不会拖长/僵死（2~5 人，800 局/格，上限 6000 转）════════\n');
console.log('配置                                        2人僵局  2人均转数  2人最多囤药水  3人均转数  4人均转数  5人均转数');
const DUEL = [
  { k:'利息封顶500 + 翻倍 + 允许囤货(上限40)', o:{interest:'principal500', stockFrom:63, potCap:40, healDelta:2} },
  { k:'利息封顶500 + 翻倍 + 囤货上限 6      ', o:{interest:'principal500', stockFrom:63, potCap:6,  healDelta:2} },
  { k:'利息封顶500 + 翻倍 + 禁止囤货       ', o:{interest:'principal500', stockFrom:71, potCap:3,  healDelta:2} },
  { k:'利息全额   + 翻倍 + 允许囤货        ', o:{interest:'full',        stockFrom:63, potCap:40, healDelta:2} },
  { k:'利息封顶500 + 翻倍 + 囤货且更晚喝药  ', o:{interest:'principal500', stockFrom:63, potCap:40, healDelta:0} },
];
for(const c of DUEL){
  const cell=[2,3,4,5].map(function(N){
    let stuck=0;const lens=[];let mp=[];
    const T=800;
    for(let s=0;s<T;s++){
      const r=runDuel(N, 1234+s*7919+N*29, Object.assign({},c.o));
      if(r.end==='stalemate')stuck++;else lens.push(r.k);
      if(N===2)mp.push(r.maxPot);
    }
    return {sr:stuck/T,avg:avg(lens),mp:avg(mp)};
  });
  console.log(c.k.padEnd(44)+pct(cell[0].sr).padEnd(9)+(isNaN(cell[0].avg)?'僵死':cell[0].avg.toFixed(1)).padEnd(11)+
    cell[0].mp.toFixed(1).padEnd(16)+
    (isNaN(cell[1].avg)?'僵死':cell[1].avg.toFixed(1)).padEnd(11)+
    (isNaN(cell[2].avg)?'僵死':cell[2].avg.toFixed(1)).padEnd(11)+
    (isNaN(cell[3].avg)?'僵死':cell[3].avg.toFixed(1)));
}
console.log('');

/* ============ 死神追猎：敏感度（血量 / 目标转数） ============ */
console.log('════════ B. 死神追猎 · 「完成目标」需要什么血量（每组 600 局，2 人）════════\n');
console.log('血量   目标转数   完成率   全灭率   平均完成tick   说明');
for(const c of [
  {hp:10,target:100,doubling:true,stockFrom:63},
  {hp:12,target:100,doubling:true,stockFrom:63},
  {hp:15,target:100,doubling:true,stockFrom:63},
  {hp:10,target:80, doubling:true,stockFrom:63},
  {hp:10,target:70, doubling:true,stockFrom:63},
  {hp:10,target:100,doubling:false,stockFrom:63},
]){
  let hit=0,wipe=0;const ticks=[];
  const T=600, N=2;
  for(let s=0;s<T;s++){
    const rng=mul(4000+s*7919);
    const hpMax=c.hp;const ps=[];
    for(let i=0;i<N;i++)ps.push({i:i,hp:hpMax,gold:0,pot:0,charm:0,postBought:0,spins:0,alive:true,done:false,doneTick:null});
    for(let tick=0;tick<400;tick++){
      for(const p of ps){
        if(!p.alive||p.done)continue;
        const t=tierOf(p.spins);
        const price=c.doubling?(p.spins>=71?300*Math.pow(2,p.postBought):300):300;
        if(p.spins>=c.stockFrom){while(p.gold>=price&&p.pot<40){p.gold-=price;p.pot+=1;if(p.spins>=71)p.postBought+=1;}}
        if(p.gold>=100&&p.charm<2&&p.hp<=t+3){p.gold-=100;p.charm+=1;}
        if(p.pot>0&&p.hp<=t+2&&p.hp<hpMax){p.pot-=1;p.hp=hpMax;}
        if(t>0){
          if(p.hp-t<=0&&p.charm>0){p.charm-=1;p.hp=1;}
          else{p.hp-=t;if(p.hp<=0){p.hp=0;p.alive=false;continue;}}
        }
        const gb=p.gold;const r=rng()*100;let acc=0,idx=4;
        for(let i=0;i<5;i++){acc+=PROBS[i];if(r<acc){idx=i;break;}}
        p.spins+=1;
        if(idx===0||idx===2){const d=idx===0?1:2;
          if(p.hp-d<=0&&p.charm>0){p.charm-=1;p.hp=1;}
          else{p.hp-=d;if(p.hp<=0){p.hp=0;p.alive=false;continue;}}
        }else if(idx===1||idx===3){p.hp=Math.min(hpMax,p.hp+(idx===1?1:2));}
        else p.gold+=50;
        const it=Math.floor(Math.min(gb,500)/10);if(it>0)p.gold+=it;
        if(p.spins>=c.target){p.done=true;p.doneTick=tick;}
      }
    }
    const d=ps.filter(function(p){return p.done;});
    if(d.length){hit++;ticks.push(Math.min.apply(null,d.map(function(p){return p.doneTick;})));}
    if(ps.every(function(p){return !p.alive;}))wipe++;
  }
  console.log(String(c.hp).padEnd(7)+String(c.target).padEnd(11)+pct(hit/T).padEnd(9)+pct(wipe/T).padEnd(9)+
    (ticks.length?avg(ticks).toFixed(1):'—').padEnd(15)+(c.doubling?'71后翻倍':'无翻倍'));
}
console.log('');
