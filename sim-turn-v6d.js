/* 轮流转盘 · V6 死因分解：现在到底是谁在杀人 */
'use strict';
const PROBS=[30,30,10,10,20];
function mul(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function run(N,seed,interest){
  const rng=mul(seed),hpMax=15;const ps=[];
  for(let i=0;i<N;i++)ps.push({i:i,hp:hpMax,gold:0,pot:0,charm:0,alive:true});
  let k=0,turn=0,scyKills=0,wheelKills=0,hp71=null,cap71Total=0,cap71N=0,pre71=0;
  for(;;){
    let alive=0;for(let i=0;i<N;i++)if(ps[i].alive)alive++;
    if(alive<=1)return {scyKills:scyKills,wheelKills:wheelKills,hp71:hp71,k:k,pre71:pre71};
    if(k>=1500)return {scyKills:scyKills,wheelKills:wheelKills,hp71:hp71,k:k,pre71:pre71,stuck:1};
    const p=ps[turn];if(!p.alive){turn=(turn+1)%N;continue;}
    const t=k>=91?3:k>=81?2:k>=71?1:0;
    if(p.gold>=300&&p.pot<1){p.gold-=300;p.pot+=1;}
    if(p.pot>0&&p.hp<=t+2&&p.hp<hpMax){p.pot-=1;p.hp=hpMax;}
    if(p.gold>=100&&p.charm<1&&p.hp<=t+2){p.gold-=100;p.charm+=1;}
    if(t>0){
      if(p.hp-t<=0&&p.charm>0){p.charm-=1;p.hp=1;}
      else{p.hp-=t;if(p.hp<=0){p.hp=0;p.alive=false;scyKills++;if(k<71)pre71++;turn=(turn+1)%N;continue;}}
    }
    const gb=p.gold;const r=rng()*100;let acc=0,idx=4;
    for(let i=0;i<5;i++){acc+=PROBS[i];if(r<acc){idx=i;break;}}
    k++;
    if(k===71){hp71=ps.map(function(q){return q.hp;});}
    if(idx===0||idx===2){const d=idx===0?1:2;
      if(p.hp-d<=0&&p.charm>0){p.charm-=1;p.hp=1;}
      else{p.hp-=d;if(p.hp<=0){p.hp=0;p.alive=false;wheelKills++;if(k<71)pre71++;}}
    }else if(idx===1||idx===3){p.hp=Math.min(hpMax,p.hp+(idx===1?1:2));}
    else p.gold+=50;
    if(p.alive&&interest){const it=Math.floor(gb/10);if(it>0)p.gold+=it;}
    turn=(turn+1)%N;
  }
}
const avg=function(a){return a.reduce(function(x,y){return x+y;},0)/a.length;};
const pct=function(x){return (x*100).toFixed(1)+'%';};
console.log('死因分解（1500 局/格，塔顶 1500 转）   出装：药水+护符\n');
console.log('人数   利息    镰刀致死   转盘致死   首次死亡在71转前的局   71转时人均血量   血量标准差');
for(const interest of [false,true]){
  for(const N of [2,3,4,5]){
    let sk=0,wk=0,pre=0,h71=[];const T=1500;
    for(let s=0;s<T;s++){
      const r=run(N,7000+s*104729+N*7,interest);
      sk+=r.scyKills;wk+=r.wheelKills;pre+=r.pre71>0?1:0;
      if(r.hp71)h71.push(avg(r.hp71));
    }
    const tot=sk+wk;
    let sd=0;
    if(h71.length){const m=avg(h71);sd=Math.sqrt(avg(h71.map(function(x){return (x-m)*(x-m);})));}
    console.log(String(N).padEnd(6)+(interest?'开':'关').padEnd(8)+pct(sk/tot).padEnd(11)+pct(wk/tot).padEnd(11)+pct(pre/T).padEnd(23)+avg(h71).toFixed(1).padEnd(17)+sd.toFixed(2));
  }
}
