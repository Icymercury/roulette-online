/* ============================================================
 * 生死转盘 · 规则引擎  engine.js  v3.1
 * ------------------------------------------------------------
 * 唯一职责：把「规则」和「表现」彻底分开。
 *
 *   本文件里没有 DOM、没有 setTimeout、没有 Math.random。
 *   随机源必须由调用方注入（rng）；时间戳必须由调用方注入（now）。
 *   所以同一段代码：
 *     · 在服务端跑 = 权威判定
 *     · 在客户端跑 = 本地对局（死亡轮盘）/ 预测 / 回放
 *
 * 三种模式（id 不变，中文名见 MODE_LABEL）：
 *   solo  死亡轮盘   单机，客户端本地跑，概率随转数递增（V5 原样）
 *   race  死神追猎   竞速，各自独立轮盘，目标 100 转，比用时
 *   turn  对赌轮盘   共享轮盘轮流转动，镰刀按全局转数，无 100 转上限
 *
 * 对外 API：
 *   MODES / MODE_LABEL / EVENTS / SHOP / NUM / PRESETS / RULES
 *   preset(mode) / modeLabel(mode)
 *   probs(n) / probsFor(match, n) / doomProbs(n) / pickIndex(p, rng)
 *   createMatch({ mode, players, startedAt }) / newPlayer(id, name, mode)
 *   applyAction(match, action, rng, now) -> { match, events }
 *   leaveMatch(match, playerId, now) -> { match, events, seat }   退出本局（转观战）
 *   pauseMatch(match, now) / resumeMatch(match, now) / elapsedMs(match, now)
 *   publicView(match) / readout(match, player) / scytheFor(match, player)
 *   priceOf(match, player, shopItem, targetId?) / shopFor(match, player)
 *
 * 设计约定：
 *   · applyAction 是纯函数 —— 不改传入的 match，返回全新对象。
 *   · 所有对局变化都通过 events 数组表达；客户端只认 events 播动画，
 *     绝不自己算结果 —— 这是联机防作弊和防不同步的关键。
 *   · now 不传就是 null：对局照常推进，只是不产生「存活时间」。
 *   · 「封存」：freeze=true 时一切动作被拒，且封存时长不计入存活时间。
 *     谁都可以调 pauseMatch/resumeMatch，引擎不关心是谁掉线了。
 *     注意「退出本局」（leaveMatch）在封存中依然允许 —— 否则有人掉线时
 *     其他人就被锁死了。
 * ============================================================ */

(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else global.RREngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ============================ 模式 ============================ */

  const MODES = ['solo', 'race', 'turn'];

  const MODE_LABEL = {
    solo: '死亡轮盘',
    race: '死神追猎',
    turn: '对赌轮盘',
  };

  /* ============================ 事件表 ============================ */
  /* 顺序与 probs() 的返回值一一对应，不可调换。
     minus1 / plus1 / minus2 / plus2 / gold */
  const EVENTS = [
    { key: 'minus1', label: '扣 1 滴血', dmg: 1,  color: '#c9452f' },
    { key: 'plus1',  label: '加 1 滴血', heal: 1, color: '#52b788' },
    { key: 'minus2', label: '扣 2 滴血', dmg: 2,  color: '#e5383b' },
    { key: 'plus2',  label: '加 2 滴血', heal: 2, color: '#4d8fd6' },
    { key: 'gold',   label: '50 金币',            color: '#e8c26a' },
  ];

  /* ============================ 道具总表 ============================ */
  /* 具体某个模式能买哪些，看 PRESETS[mode].shop */
  const SHOP = {
    charm: {
      id: 'charm', name: '免死护符', price: 100,
      desc: '挡下一次致命伤，血量锁在 1',
    },
    potion: {
      id: 'potion', name: '生命药水', price: 300,
      desc: '立刻回满血',
    },
    rewind: {
      id: 'rewind', name: '减少转数', price: 200, limit: 3, step: 5,
      desc: '轮盘读数 −5（最多买 3 次）。只有死亡轮盘买得到',
    },
    banana: {
      id: 'banana', name: '香蕉皮', price: 150, spins: 5, needTarget: true,
      desc: '指定一名对手：其接下来 5 次转动「转数不涨」，但转盘效果照常结算',
    },
  };

  const NUM = {
    GOLD_PER_PICK: 50,      // 转到金币格的收益
    INTEREST_PER: 10,       // 利息：每持有 10 金
    INTEREST_GAIN: 1,       //      → 额外 +1 金
    PROBS_FIXED: [30, 30, 10, 10, 20],   // 概率不再随转数变化
  };

  /* ============================ 三套模式规则 ============================ */

  const PRESETS = {
    /* 死亡轮盘：单机，与 V5 逐字段一致，一行数值都没动 */
    solo: {
      label: MODE_LABEL.solo,
      hpMax: 7,
      growingProbs: true,        // 概率随转数递增
      doomAt: 100,               // 第 100 转：三条正面线归零 = 绝境
      nodeFirst: 31,             // 第一次死神造访
      nodeScythe: 71,            // 第二次（挥镰）
      scythe: { tiers: [{ from: 71, dmg: 1 }], clock: 'own', gate: 'ms71' },
      healAtNode: true,          // 节点回满血
      clearItemsAtScythe: true,  // 71 转夺走未使用的道具
      interest: { mode: 'full' },// 利息不封顶
      inflationFrom: null,       // 道具不涨价
      shop: ['charm', 'potion', 'rewind'],
      target: null,
      ending: 'solo',
    },

    /* 对赌轮盘：共享轮盘，镰刀按全局转数，无 100 转上限 */
    turn: {
      label: MODE_LABEL.turn,
      hpMax: 15,
      growingProbs: false,
      doomAt: null,
      nodeFirst: null,
      nodeScythe: 71,
      scythe: { tiers: [{ from: 71, dmg: 1 }, { from: 81, dmg: 2 }, { from: 91, dmg: 3 }], clock: 'shared' },
      healAtNode: false,
      clearItemsAtScythe: false,
      interest: { mode: 'principal', cap: 500 },
      inflationFrom: 71,         // 71 转后每买一次翻倍
      shop: ['charm', 'potion'], // 「减少转数」已从对赌轮盘移除：共享轮盘的档位是全场共担的，谁买谁把所有人往后拖
      target: null,
      ending: 'lastStanding',
    },

    /* 死神追猎：各自独立轮盘，镰刀按各自转数，目标 100 转 */
    race: {
      label: MODE_LABEL.race,
      hpMax: 10,
      growingProbs: false,
      doomAt: null,
      nodeFirst: null,
      nodeScythe: 71,
      scythe: { tiers: [{ from: 71, dmg: 1 }, { from: 81, dmg: 2 }, { from: 91, dmg: 3 }], clock: 'own' },
      healAtNode: false,
      clearItemsAtScythe: false,
      interest: { mode: 'principal', cap: 500 },
      inflationFrom: 71,
      shop: ['charm', 'potion', 'banana'],
      target: 100,
      ending: 'race',
    },
  };

  function preset(mode) { return PRESETS[mode] || PRESETS.turn; }
  function modeLabel(mode) { return preset(mode).label; }
  function ruleOf(m) { return preset(m.mode); }

  /* ============================ 规则改写（V16） ============================
     房主可以在管理台里改数值（血上限、概率、道具价格…）。引擎这边提供一个注入口。

     实现要点：
       · **就地改** SHOP / NUM / PRESETS 的属性 —— 三个表里所有的读取点
         （priceOf / probsFor / newPlayer…）都读的是这几个对象，就地改就自动生效，
         不用去动几十处引用。
       · 改之前先**从原始快照还原**，所以反复 configure 不会累积。
       · **只认白名单字段**，并做钳制（概率之和必须 = 100 等），不合法就整条拒绝，
         保证引擎永远处在自洽状态 —— 手改坏掉的 rules.json 不会让它算出鬼数值。
       · 不传 / 传 null = 恢复默认。 */

  const ORIGINAL = JSON.parse(JSON.stringify({ SHOP: SHOP, NUM: NUM, PRESETS: PRESETS }));

  /* 允许房主改的字段（白名单之外的一律忽略） */
  const EDITABLE = {
    num: ['GOLD_PER_PICK', 'INTEREST_PER', 'INTEREST_GAIN', 'PROBS_FIXED'],
    preset: ['hpMax', 'nodeFirst', 'nodeScythe', 'inflationFrom', 'doomAt', 'target',
             'growingProbs', 'healAtNode', 'clearItemsAtScythe'],
    item: ['price', 'limit', 'step', 'spins'],
  };

  function restoreOriginal() {
    Object.keys(ORIGINAL.SHOP).forEach(k => {
      if (!SHOP[k]) return;
      Object.keys(ORIGINAL.SHOP[k]).forEach(f => { SHOP[k][f] = ORIGINAL.SHOP[k][f]; });
    });
    Object.keys(ORIGINAL.NUM).forEach(k => { NUM[k] = ORIGINAL.NUM[k]; });
    Object.keys(ORIGINAL.PRESETS).forEach(m => {
      const p = PRESETS[m];
      Object.keys(ORIGINAL.PRESETS[m]).forEach(f => {
        /* 数组（shop / scythe.tiers）和对象要换新的，别共用引用 */
        p[f] = JSON.parse(JSON.stringify(ORIGINAL.PRESETS[m][f]));
      });
    });
  }

  function clampNum(v, lo, hi, dflt) {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  /* 返回 { rules, errors } —— errors 非空表示这一条被拒（其余照常应用） */
  function sanitize(ov) {
    const errors = [];
    const out = { shop: {}, num: {}, presets: {}, scythe: {}, interest: {} };

    if (ov.num) {
      EDITABLE.num.forEach(f => {
        const v = ov.num[f];
        if (v == null) return;
        if (f === 'PROBS_FIXED') {
          if (!Array.isArray(v) || v.length !== 5) { errors.push('概率必须是 5 个数'); return; }
          const arr = v.map(x => Math.max(0, Number(x) || 0));
          const sum = arr.reduce((a, b) => a + b, 0);
          if (Math.abs(sum - 100) > 0.01) { errors.push('概率之和必须是 100（现在是 ' + Math.round(sum) + '）'); return; }
          out.num[f] = arr;
        } else {
          out.num[f] = clampNum(v, 0, 100000, ORIGINAL.NUM[f]);
        }
      });
    }

    if (ov.shop) {
      Object.keys(ov.shop).forEach(id => {
        if (!ORIGINAL.SHOP[id]) { errors.push('没有这个道具：' + id); return; }
        const src = ov.shop[id];
        const dst = {};
        EDITABLE.item.forEach(f => {
          if (src[f] == null) return;
          if (!(f in ORIGINAL.SHOP[id])) return;      /* 该道具本来就没这个字段就别编 */
          dst[f] = clampNum(src[f], 0, 99999, ORIGINAL.SHOP[id][f]);
        });
        if (Object.keys(dst).length) out.shop[id] = dst;
      });
    }

    if (ov.presets) {
      Object.keys(ov.presets).forEach(m => {
        if (!ORIGINAL.PRESETS[m]) { errors.push('没有这个模式：' + m); return; }
        const src = ov.presets[m] || {};
        const dst = {};
        EDITABLE.preset.forEach(f => {
          if (src[f] == null) return;
          if (typeof ORIGINAL.PRESETS[m][f] === 'boolean') { dst[f] = !!src[f]; return; }
          if (f === 'hpMax') { dst[f] = Math.round(clampNum(src[f], 1, 99, ORIGINAL.PRESETS[m][f])); return; }
          dst[f] = src[f] === null ? null : Math.round(clampNum(src[f], 0, 999, ORIGINAL.PRESETS[m][f] || 0));
        });
        if (Array.isArray(src.shop)) {
          const list = src.shop.filter(id => !!ORIGINAL.SHOP[id]);
          if (list.length) dst.shop = list;
        }
        if (Array.isArray(src.scytheTiers)) {
          const tiers = src.scytheTiers
            .filter(t => t && isFinite(Number(t.from)) && isFinite(Number(t.dmg)))
            .map(t => ({ from: Math.round(clampNum(t.from, 0, 999, 71)), dmg: Math.round(clampNum(t.dmg, 0, 99, 1)) }))
            .sort((a, b) => a.from - b.from);
          if (tiers.length) out.scythe[m] = tiers;
        }
        if (src.interest && typeof src.interest === 'object') {
          const cap = src.interest.cap;
          if (cap != null) out.interest[m] = { mode: src.interest.mode === 'full' ? 'full' : 'principal',
                                               cap: Math.round(clampNum(cap, 0, 100000, 500)) };
        }
        if (Object.keys(dst).length) out.presets[m] = dst;
      });
    }

    return { rules: out, errors: errors };
  }

  /* 对外：configure(覆盖对象) → { ok, errors }；不传 / null → 恢复默认 */
  function configure(ov) {
    restoreOriginal();
    if (!ov || typeof ov !== 'object') return { ok: true, errors: [], custom: false };
    const s = sanitize(ov);
    /* 校验有错就整条不应用 —— 宁可保持默认，也不让引擎跑在半套规则上 */
    if (s.errors.length) { restoreOriginal(); return { ok: false, errors: s.errors, custom: false }; }

    Object.keys(s.rules.num).forEach(f => { NUM[f] = s.rules.num[f]; });
    Object.keys(s.rules.shop).forEach(id => {
      Object.keys(s.rules.shop[id]).forEach(f => { SHOP[id][f] = s.rules.shop[id][f]; });
    });
    Object.keys(s.rules.presets).forEach(m => {
      Object.keys(s.rules.presets[m]).forEach(f => { PRESETS[m][f] = s.rules.presets[m][f]; });
    });
    Object.keys(s.rules.scythe).forEach(m => { PRESETS[m].scythe.tiers = s.rules.scythe[m]; });
    Object.keys(s.rules.interest).forEach(m => { PRESETS[m].interest = s.rules.interest[m]; });

    return { ok: true, errors: [], custom: true };
  }

  /* 当前生效的规则（给客户端拉快照用）。默认是 null = 内置默认 */
  function currentRules(ov) { return ov ? JSON.parse(JSON.stringify(ov)) : null; }

  /* 兼容旧代码：RULES 暴露的是单机（V5）那一套 */
  const RULES = {
    MAX_HP: PRESETS.solo.hpMax,
    MAX_SPIN: PRESETS.solo.doomAt,
    NODE_FIRST: PRESETS.solo.nodeFirst,
    NODE_SCYTHE: PRESETS.solo.nodeScythe,
    SCYTHE_DAMAGE: PRESETS.solo.scythe.tiers[0].dmg,
    GOLD_PER_PICK: NUM.GOLD_PER_PICK,
    INTEREST_PER: NUM.INTEREST_PER,
    INTEREST_GAIN: NUM.INTEREST_GAIN,
  };

  /* ============================ 概率 ============================ */

  /* V5 曲线（仅单机使用）：增量按初始权重等比分配
     扣血端 +0.4 / +0.2，回血端 −0.3 / −0.1，金币 −0.2
     → 任意 n 下五项之和恒为 100；n=100 时三条正面线同时归零。 */
  function probs(n) {
    n = Math.max(0, Math.min(Number(n) || 0, 100));
    return [
      30 + 0.4 * n,
      Math.max(0, 30 - 0.3 * n),
      10 + 0.2 * n,
      Math.max(0, 10 - 0.1 * n),
      Math.max(0, 20 - 0.2 * n),
    ];
  }

  /* 按模式取概率：单机走 V5 曲线，其余固定 */
  function probsFor(m, n) {
    return ruleOf(m).growingProbs ? probs(n) : NUM.PROBS_FIXED.slice();
  }

  /* 扣 1 血 + 扣 2 血 的合计概率（单机的第二条结束条件） */
  function doomProbs(n) {
    const p = probs(n);
    return p[0] + p[2];
  }

  function pickIndex(p, rng) {
    const r = rng() * 100;
    let acc = 0;
    for (let i = 0; i < p.length; i++) {
      acc += p[i];
      if (r < acc) return i;
    }
    return p.length - 1;
  }

  /* ============================ 构造 ============================ */

  function newPlayer(id, name, mode) {
    const R = preset(mode || 'solo');
    return {
      id: String(id),
      name: name || ('玩家 ' + id),
      hp: R.hpMax,
      gold: 0,
      spins: 0,          // 有效转数（对赌轮盘里仅作统计；香蕉皮会压住它）
      charms: 0,
      potions: 0,
      rewinds: 0,
      bananas: 0,        // 身上还挂着几次「转数不涨」
      bought: { charm: 0, potion: 0, rewind: 0, banana: 0 },  // 涨价计数（仅 71 转后的购买）
      spent: 0,
      earned: 0,
      interest: 0,
      charmUsed: 0,
      alive: true,
      finished: false,   // 已完成目标转数（死神追猎）
      connected: true,
      ms31: false,       // 单机：31 转赠礼是否已用掉
      ms71: false,       // 单机：71 转镰刀是否已挥下
      finishedAt: null,  // 完成目标那一刻（毫秒时间戳）
      diedAt: null,
      survivalMs: null,  // 存活时间：从开局到死亡/完成
      tally: { minus1: 0, plus1: 0, minus2: 0, plus2: 0, gold: 0 },
    };
  }

  function createMatch(opts) {
    opts = opts || {};
    const mode = MODES.indexOf(opts.mode) >= 0 ? opts.mode : 'solo';
    const R = preset(mode);
    const list = opts.players || [{ id: '1' }];
    const players = {};
    const order = [];

    list.forEach(function (raw, i) {
      const id = String(raw.id != null ? raw.id : i + 1);
      const p = newPlayer(id, raw.name, mode);
      p.hp = R.hpMax;
      if (raw.connected === false) p.connected = false;
      /* 重连凭证必须跟着座位走：换模式/重开一局都是拿旧名单重建对局的，
         这里漏了的话，所有人的凭证都会在下一局失效 */
      if (raw.token) p.token = String(raw.token);
      players[id] = p;
      order.push(id);
    });

    return {
      mode: mode,
      k: 0,               // 共享轮盘读数（对赌轮盘）
      turn: 0,            // 当前轮到 order 里的第几位（对赌轮盘）
      order: order,
      players: players,
      phase: 'playing',   // 'playing' | 'over'
      winner: null,
      reason: null,
      ranking: null,      // 死神追猎：完成 100 转的先后名次
      turnCount: 0,
      startedAt: opts.startedAt != null ? opts.startedAt : null,
      endedAt: null,
      /* ---- 封存（掉线等待） ---- */
      frozen: false,       // 封存中：所有动作被拒
      frozenSince: null,   // 本次封存的开始时刻
      pausedMs: 0,         // 历次封存累计时长 —— 从「存活时间」里扣掉
    };
  }

  /* 深拷贝 —— 状态结构固定，手写比 structuredClone 快且无兼容问题 */
  function cloneMatch(m) {
    const players = {};
    for (const id in m.players) {
      const p = m.players[id];
      players[id] = {
        id: p.id, name: p.name,
        hp: p.hp, gold: p.gold, spins: p.spins,
        charms: p.charms, potions: p.potions, rewinds: p.rewinds, bananas: p.bananas,
        bought: {
          charm: p.bought.charm, potion: p.bought.potion,
          rewind: p.bought.rewind, banana: p.bought.banana,
        },
        spent: p.spent, earned: p.earned, interest: p.interest,
        charmUsed: p.charmUsed,
        alive: p.alive, finished: p.finished, connected: p.connected,
        token: p.token,
        ms31: p.ms31, ms71: p.ms71,
        finishedAt: p.finishedAt, diedAt: p.diedAt, survivalMs: p.survivalMs,
        tally: {
          minus1: p.tally.minus1, plus1: p.tally.plus1,
          minus2: p.tally.minus2, plus2: p.tally.plus2, gold: p.tally.gold,
        },
      };
    }
    return {
      mode: m.mode, k: m.k, turn: m.turn,
      order: m.order.slice(), players: players,
      phase: m.phase, winner: m.winner, reason: m.reason,
      ranking: m.ranking ? m.ranking.slice() : null,
      turnCount: m.turnCount,
      startedAt: m.startedAt, endedAt: m.endedAt,
      frozen: !!m.frozen, frozenSince: m.frozenSince == null ? null : m.frozenSince,
      pausedMs: m.pausedMs || 0,
    };
  }

  /* 该玩家当前面对的「轮盘读数」。
     对赌轮盘共享一个轮盘；其余各转各的。 */
  function readout(m, p) {
    return m.mode === 'turn' ? m.k : p.spins;
  }

  /* ============================ 封存与计时 ============================ */

  /* 对局已进行的时长（毫秒）—— 封存的那段时间不算。
     「存活时间」以它为准：掉线等待不该算进任何人的成绩。 */
  function elapsedMs(m, now) {
    if (m.startedAt == null || now == null) return null;
    let ms = now - m.startedAt - (m.pausedMs || 0);
    if (m.frozen && m.frozenSince != null) ms -= (now - m.frozenSince);
    return Math.max(0, ms);
  }

  /* 封存：停表、拒绝一切动作。返回新对局，不改传进来的那份。 */
  function pauseMatch(m, now) {
    const next = cloneMatch(m);
    if (next.frozen) return next;
    next.frozen = true;
    next.frozenSince = now == null ? null : now;
    return next;
  }

  /* 解封：把封存时长记进账，表接着走。 */
  function resumeMatch(m, now) {
    const next = cloneMatch(m);
    if (!next.frozen) return next;
    if (now != null && next.frozenSince != null) next.pausedMs += Math.max(0, now - next.frozenSince);
    next.frozen = false;
    next.frozenSince = null;
    return next;
  }

  /* ============================ 镰刀 ============================ */

  /* 本次转动要「转动前先扣」的血量，0 表示镰刀还没落下。
     单机走 ms71 粘性标志（与 V5 完全一致，减少转数也关不掉）；
     对赌轮盘按全局 k、死神追猎按各自转数，逐档叠加。 */
  function scytheFor(m, p) {
    const R = ruleOf(m);
    if (!R.scythe || !R.scythe.tiers || !R.scythe.tiers.length) return 0;
    if (R.scythe.gate === 'ms71') return p.ms71 ? R.scythe.tiers[0].dmg : 0;
    const c = R.scythe.clock === 'shared' ? m.k : p.spins;
    let d = 0;
    for (let i = 0; i < R.scythe.tiers.length; i++) {
      if (c >= R.scythe.tiers[i].from) d = R.scythe.tiers[i].dmg;
    }
    return d;
  }

  /* 时间打点：把「存活时间」落成毫秒数。now 为 null 时不产生时间。
     注意用的是 elapsedMs —— 封存等待的时长不算成绩。 */
  function stampEnd(m, p, kind, now) {
    if (now == null) return null;
    if (kind === 'finish') p.finishedAt = now; else p.diedAt = now;
    p.survivalMs = elapsedMs(m, now);
    return p.survivalMs;
  }

  /* ============================ 道具价格 ============================ */

  /* 71 转后每买一次翻倍涨。价格按玩家各自记账，也按各模式的读数基准。 */
  function priceOf(m, p, it) {
    const R = ruleOf(m);
    if (R.inflationFrom == null) return it.price;
    if (readout(m, p) < R.inflationFrom) return it.price;
    const n = (p.bought && p.bought[it.id]) || 0;
    return it.price * Math.pow(2, n);
  }

  function shopFor(m, p) {
    const R = ruleOf(m);
    return R.shop.map(function (sid) {
      const s = SHOP[sid];
      return {
        id: s.id, name: s.name, desc: s.desc,
        price: priceOf(m, p, s), base: s.price,
        limit: s.limit == null ? null : s.limit,
        needTarget: !!s.needTarget,
      };
    });
  }

  /* ============================ 动作入口 ============================ */

  function applyAction(match, action, rng, now) {
    const next = cloneMatch(match);
    const ev = [];
    const r = typeof rng === 'function' ? rng : Math.random;
    const t = now == null ? null : now;

    if (!action || !action.type) return { match: next, events: [reject('bad-action')] };
    if (next.phase !== 'playing') return { match: next, events: [reject('game-over')] };
    /* 封存期间一切动作无效：哪怕客户端绕过禁用的按钮硬发指令也进不来 */
    if (next.frozen) return { match: next, events: [reject('frozen')] };

    const pid = action.playerId != null ? String(action.playerId) : next.order[0];
    const p = next.players[pid];
    if (!p) return { match: next, events: [reject('no-such-player')] };

    if (action.type === 'spin') {
      if (next.mode === 'turn' && next.order[next.turn] !== pid)
        return { match: next, events: [reject('not-your-turn', pid)] };
      if (!p.alive || p.finished)
        return { match: next, events: [reject('not-in-play', pid)] };
      doSpin(next, p, r, ev, t);

    } else if (action.type === 'buy') {
      doBuy(next, p, action.itemId, action.targetId, ev, t);

    } else if (action.type === 'usePotion') {
      doPotion(next, p, ev);

    } else {
      return { match: next, events: [reject('unknown-action')] };
    }

    next.turnCount += 1;
    settle(next, ev, t);
    return { match: next, events: ev };
  }

  function reject(reason, playerId, itemId) {
    return { t: 'rejected', reason: reason, playerId: playerId || null, itemId: itemId || null };
  }

  /* ============================ 转动 ============================ */

  function doSpin(m, p, rng, ev, now) {
    const spinsBefore = readout(m, p);
    const scy = scytheFor(m, p);

    /* ① 死神的镰刀：转动前先扣。血量不够时转动即死 —— 除非手上还有护符。 */
    if (scy > 0 && p.hp > 0) {
      if (p.hp - scy <= 0 && p.charms > 0) {
        p.charms -= 1;
        p.charmUsed += 1;
        p.hp = 1;
        ev.push({ t: 'scythe', playerId: p.id, amount: scy, blockedByCharm: true, hp: p.hp });
      } else {
        p.hp -= scy;
        if (p.hp <= 0) {
          p.hp = 0;
          p.alive = false;
          ev.push({ t: 'scythe', playerId: p.id, amount: scy, blockedByCharm: false, hp: 0 });
          ev.push({ t: 'death', playerId: p.id, cause: 'scythe', spins: spinsBefore, at: now, survivalMs: stampEnd(m, p, 'death', now) });
          return;   // 没撑到转盘停稳
        }
        ev.push({ t: 'scythe', playerId: p.id, amount: scy, blockedByCharm: false, hp: p.hp });
      }
    }

    /* ② 掷骰 —— 服务端权威的根基，客户端永远拿不到 rng */
    const idx = pickIndex(probsFor(m, spinsBefore), rng);
    const e = EVENTS[idx];
    const goldBefore = p.gold;          // 利息只认「转动前」的本金

    p.tally[e.key] += 1;

    /* ③ 香蕉皮：转数不涨，但这一转照常结算 */
    const slipped = p.bananas > 0;
    if (slipped) {
      p.bananas -= 1;
      ev.push({ t: 'slip', playerId: p.id, left: p.bananas });
    } else if (m.mode === 'turn') {
      m.k += 1;
    } else {
      p.spins += 1;
    }
    const spinsAfter = readout(m, p);

    ev.push({
      t: 'roll', playerId: p.id, idx: idx, key: e.key, label: e.label,
      spins: spinsAfter, counted: !slipped,
      probs: probsFor(m, spinsBefore),
    });

    /* ④ 结算 */
    if (e.dmg) {
      if (p.hp - e.dmg <= 0 && p.charms > 0) {
        p.charms -= 1; p.charmUsed += 1; p.hp = 1;
        ev.push({ t: 'damage', playerId: p.id, amount: e.dmg, blockedByCharm: true, hp: p.hp });
      } else {
        p.hp -= e.dmg;
        const dead = p.hp <= 0;
        if (dead) { p.hp = 0; p.alive = false; }
        ev.push({ t: 'damage', playerId: p.id, amount: e.dmg, blockedByCharm: false, hp: p.hp });
        if (dead) {
          ev.push({ t: 'death', playerId: p.id, cause: 'wheel', spins: spinsAfter, at: now, survivalMs: stampEnd(m, p, 'death', now) });
          return;   // 死了就不结算利息、不触发节点
        }
      }
    } else if (e.heal) {
      const before = p.hp;
      p.hp = Math.min(ruleOf(m).hpMax, p.hp + e.heal);
      ev.push({
        t: 'heal', playerId: p.id, amount: e.heal,
        from: before, to: p.hp, overflow: p.hp === before,
      });
    } else {
      p.gold += NUM.GOLD_PER_PICK;
      p.earned += NUM.GOLD_PER_PICK;
      ev.push({ t: 'gold', playerId: p.id, amount: NUM.GOLD_PER_PICK, gold: p.gold });
    }

    /* ⑤ 死神利息 */
    const itr = interestFor(m, goldBefore);
    if (itr > 0) {
      p.gold += itr;
      p.earned += itr;
      p.interest += itr;
      ev.push({ t: 'interest', playerId: p.id, principal: goldBefore, amount: itr, gold: p.gold });
    }

    /* ⑥ 死神的造访 */
    const R = ruleOf(m);
    if (R.nodeFirst && !p.ms31 && spinsAfter >= R.nodeFirst) {
      doMilestone(m, p, R.nodeFirst, ev);
    } else if (R.nodeScythe && !p.ms71 && spinsAfter >= R.nodeScythe) {
      doMilestone(m, p, R.nodeScythe, ev);
    } else if (m.mode !== 'solo') {
      /* 对赌轮盘 / 死神追猎：镰刀换档要播一次演出 */
      const after = scytheFor(m, p);
      if (after > scy) ev.push({ t: 'scytheArmed', playerId: p.id, dmg: after, previous: scy });
    }
  }

  function interestFor(m, goldBefore) {
    const R = ruleOf(m);
    if (!R.interest || R.interest.mode === 'off') return 0;
    let base = goldBefore;
    if (R.interest.mode === 'principal' && R.interest.cap != null) base = Math.min(base, R.interest.cap);
    const itr = Math.floor(base / NUM.INTEREST_PER) * NUM.INTEREST_GAIN;
    return itr > 0 ? itr : 0;
  }

  function doMilestone(m, p, n, ev) {
    const R = ruleOf(m);
    const lost = R.clearItemsAtScythe || n === R.nodeFirst ? (p.charms + p.potions) : 0;
    if (R.healAtNode) p.hp = R.hpMax;                 // 生命补满
    if (R.clearItemsAtScythe || n === R.nodeFirst) {  // 未使用的道具被夺走
      p.charms = 0;
      p.potions = 0;
    }
    if (n === R.nodeFirst) p.ms31 = true; else p.ms71 = true;
    ev.push({
      t: 'milestone', playerId: p.id, n: n,
      lost: lost, hp: p.hp, scytheArmed: n === R.nodeScythe,
    });
  }

  /* ============================ 商场 ============================ */

  function doBuy(m, p, itemId, targetId, ev, now) {
    const R = ruleOf(m);
    const it = SHOP[itemId];
    if (!it) { ev.push(reject('no-such-item', p.id, itemId)); return; }
    if (R.shop.indexOf(itemId) < 0) { ev.push(reject('item-not-available', p.id, itemId)); return; }
    if (!p.alive || p.finished) { ev.push(reject('not-in-play', p.id)); return; }

    const price = priceOf(m, p, it);
    if (p.gold < price) { ev.push(reject('not-enough-gold', p.id, itemId)); return; }
    if (it.limit != null && p.rewinds >= it.limit) { ev.push(reject('limit-reached', p.id, itemId)); return; }

    let target = null;
    if (it.needTarget) {
      target = m.players[String(targetId != null ? targetId : '')];
      if (!target || target.id === p.id) { ev.push(reject('bad-target', p.id, itemId)); return; }
      if (!target.alive || target.finished) { ev.push(reject('target-not-in-play', p.id, itemId)); return; }
    }

    p.gold -= price;
    p.spent += price;
    if (R.inflationFrom != null && readout(m, p) >= R.inflationFrom) {
      p.bought[it.id] = (p.bought[it.id] || 0) + 1;
    }

    if (it.id === 'charm') {
      p.charms += 1;
      ev.push({ t: 'buy', playerId: p.id, itemId: it.id, cost: price, count: p.charms });

    } else if (it.id === 'potion') {
      p.potions += 1;
      ev.push({ t: 'buy', playerId: p.id, itemId: it.id, cost: price, count: p.potions });

    } else if (it.id === 'banana') {
      target.bananas += it.spins;
      ev.push({ t: 'buy', playerId: p.id, itemId: it.id, cost: price, targetId: target.id });
      ev.push({ t: 'banana', playerId: p.id, targetId: target.id, added: it.spins, left: target.bananas });

    } else {
      /* 减少转数：只回退轮盘读数，不回退 ms31 / ms71 —— 
         「已用掉的赠礼不会再触发第二次」是刻意的规则。 */
      const before = readout(m, p);
      p.rewinds += 1;
      if (m.mode === 'turn') m.k = Math.max(0, m.k - it.step);
      else p.spins = Math.max(0, p.spins - it.step);
      ev.push({ t: 'buy', playerId: p.id, itemId: it.id, cost: price });
      ev.push({
        t: 'rewind', playerId: p.id,
        from: before, to: readout(m, p),
        used: p.rewinds, limit: it.limit,
      });
    }
  }

  function doPotion(m, p, ev) {
    const R = ruleOf(m);
    if (!p.alive || p.finished) { ev.push(reject('not-in-play', p.id)); return; }
    if (p.potions <= 0) { ev.push(reject('no-potion', p.id)); return; }
    if (p.hp >= R.hpMax) { ev.push(reject('hp-full', p.id)); return; }
    const before = p.hp;
    p.potions -= 1;
    p.hp = R.hpMax;
    ev.push({ t: 'potion', playerId: p.id, from: before, to: p.hp });
  }

  /* ============================ 结算与结束 ============================ */

  function settle(m, ev, now) {
    if (m.mode === 'solo') { settleSolo(m, ev, now); return; }
    if (m.mode === 'turn') { settleTurn(m, ev, now); return; }
    settleRace(m, ev, now);
  }

  function closeMatch(m, winnerId, reason, ev, now, extra) {
    m.phase = 'over';
    m.winner = winnerId;
    m.reason = reason;
    if (now != null) m.endedAt = now;
    const payload = { t: 'over', reason: reason, winnerId: winnerId };
    if (extra) for (const k2 in extra) payload[k2] = extra[k2];
    ev.push(payload);
  }

  /* ---- 死亡轮盘：单人死亡 / 第 100 转绝境通关 ---- */
  function settleSolo(m, ev, now) {
    const R = preset('solo');
    const p = m.players[m.order[0]];
    if (!p) { closeMatch(m, null, 'all-left', ev, now, {}); return; }

    if (!p.alive) {
      closeMatch(m, null, 'death', ev, now, { spins: p.spins });
      return;
    }
    if (p.spins >= R.doomAt || doomProbs(p.spins) >= 100) {
      p.finished = true;
      stampEnd(m, p, 'finish', now);
      closeMatch(m, p.id, 'doom', ev, now, { spins: p.spins });
    }
  }

  /* ---- 对赌轮盘：只剩一个人活着（没有 100 转上限） ---- */
  function settleTurn(m, ev, now) {
    advanceTurn(m);
    settleTurnEnd(m, ev, now);
  }

  /* 只看「还有人吗」，不推进轮次 —— 「有人退出本局」时专用。
     退场不该把轮次往前推一格，否则会白送一个人一次机会。 */
  function settleTurnEnd(m, ev, now) {
    const active = m.order.filter(function (id) {
      const p = m.players[id];
      return p && p.alive && !p.finished;
    });

    if (active.length <= 1) {
      if (active.length === 1) closeMatch(m, active[0], 'last-standing', ev, now, { k: m.k });
      else closeMatch(m, null, m.order.length === 0 ? 'all-left' : 'all-dead', ev, now, { k: m.k });
    }
  }

  /* ---- 死神追猎：① 只剩一人存活  ② 完成 100 转比用时 ---- */
  function settleRace(m, ev, now) {
    const R = preset('race');

    /* 撞线：完成目标转数 */
    for (let i = 0; i < m.order.length; i++) {
      const p = m.players[m.order[i]];
      if (p.alive && !p.finished && p.spins >= R.target) {
        p.finished = true;
        stampEnd(m, p, 'finish', now);
        ev.push({ t: 'finished', playerId: p.id, spins: p.spins, at: p.finishedAt, survivalMs: p.survivalMs });
      }
    }

    const finished = m.order.map(function (id) { return m.players[id]; })
      .filter(function (p) { return p && p.finished; });
    const active = m.order.map(function (id) { return m.players[id]; })
      .filter(function (p) { return p && p.alive && !p.finished; });

    /* 结束条件②：两人以上完成 100 转 → 用时最短者获胜 */
    if (finished.length >= 2) {
      const ranked = finished.slice().sort(function (a, b) {
        const ta = a.survivalMs, tb = b.survivalMs;
        if (ta != null && tb != null && ta !== tb) return ta - tb;
        if (ta != null && tb == null) return -1;
        if (ta == null && tb != null) return 1;
        return m.order.indexOf(a.id) - m.order.indexOf(b.id);
      });
      m.ranking = ranked.map(function (p) { return p.id; });
      closeMatch(m, ranked[0].id, 'fastest-finish', ev, now, { ranking: m.ranking });
      return;
    }

    if (active.length === 0) {
      if (finished.length === 1) {
        m.ranking = [finished[0].id];
        closeMatch(m, finished[0].id, 'sole-finisher', ev, now, { ranking: m.ranking });
      } else {
        closeMatch(m, null, m.order.length === 0 ? 'all-left' : 'all-dead', ev, now, {});
      }
      return;
    }

    /* 结束条件①：只剩一个人还活着 */
    if (active.length === 1 && finished.length === 0) {
      closeMatch(m, active[0].id, 'last-standing', ev, now, {});
    }
  }

  /* 轮到下一个还活着的人。全都不在了就原地不动。 */
  function advanceTurn(m) {
    const n = m.order.length;
    if (n === 0) return;
    for (let i = 1; i <= n; i++) {
      const idx = (m.turn + i) % n;
      const p = m.players[m.order[idx]];
      if (p && p.alive && !p.finished) { m.turn = idx; return; }
    }
  }

  /* ============================ 退出本局 ============================ */

  /* 「退出本局」：人走，局照打 —— 他从这一局里摘掉，房间席位（id / 名字 / 凭证）原样还回去，
     由调用方把他转成观战者。这样他随时能回来继续看，下一局回大厅时又自动回名单。
     · 退场不推进轮次：否则等于白送下一个人一次机会。
     · 退场后立刻复查结束条件：2 人局里走一个，剩下的那个当场胜出，不会把房间吊住。
     · 允许在「封存」中退场：否则有人掉线时别人就被锁死了。 */
  function leaveMatch(m, playerId, now) {
    const next = cloneMatch(m);
    const ev = [];
    const pid = playerId == null ? null : String(playerId);
    const p = pid != null ? next.players[pid] : null;
    if (!p) return { match: next, events: [reject('no-such-player')], seat: null };
    if (next.phase !== 'playing') return { match: next, events: [reject('game-over')], seat: null };

    const seat = { id: p.id, name: p.name, token: p.token, connected: p.connected };
    const idx = next.order.indexOf(pid);
    delete next.players[pid];
    if (idx >= 0) next.order.splice(idx, 1);

    /* 修正「轮到谁」：被摘掉的人如果排在前面，后面的整体左移一格 */
    if (next.order.length === 0) next.turn = 0;
    else {
      if (idx >= 0 && idx < next.turn) next.turn -= 1;
      if (next.turn >= next.order.length) next.turn = 0;
    }

    ev.push({ t: 'leave', playerId: pid, name: seat.name, left: next.order.length });

    const t = now == null ? null : now;
    if (next.mode === 'solo') settleSolo(next, ev, t);
    else if (next.mode === 'turn') settleTurnEnd(next, ev, t);
    else settleRace(next, ev, t);

    return { match: next, events: ev, seat: seat };
  }

  /* ============================ 视图 ============================ */

  function publicView(m) {
    const R = ruleOf(m);
    return {
      mode: m.mode,
      modeLabel: R.label,
      k: m.k,
      turn: m.turn,
      turnPlayerId: m.order[m.turn] || null,
      order: m.order.slice(),
      phase: m.phase,
      winner: m.winner,
      reason: m.reason,
      ranking: m.ranking ? m.ranking.slice() : null,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      rules: {
        hpMax: R.hpMax,
        target: R.target,
        doomAt: R.doomAt,
        nodeFirst: R.nodeFirst,
        nodeScythe: R.nodeScythe,
        scytheTiers: R.scythe.tiers.map(function (t) { return { from: t.from, dmg: t.dmg }; }),
        scytheClock: R.scythe.clock,
        interestCap: R.interest && R.interest.cap != null ? R.interest.cap : null,
        inflationFrom: R.inflationFrom,
        shop: R.shop.slice(),
      },
      /* ---- 封存状态：客户端据此显示「赌局已封存，等待 XX 重连」 ---- */
      frozen: !!m.frozen,
      frozenSince: m.frozenSince == null ? null : m.frozenSince,
      pausedMs: m.pausedMs || 0,
      events: EVENTS.map(function (e) { return { key: e.key, label: e.label, color: e.color }; }),
      players: m.order.map(function (id) {
        const p = m.players[id];
        return {
          id: p.id, name: p.name,
          hp: p.hp, gold: p.gold, spins: p.spins,
          charms: p.charms, potions: p.potions, rewinds: p.rewinds, bananas: p.bananas,
          alive: p.alive, finished: p.finished, connected: p.connected,
          ms31: p.ms31, ms71: p.ms71,
          spent: p.spent, earned: p.earned, interest: p.interest, charmUsed: p.charmUsed,
          finishedAt: p.finishedAt, diedAt: p.diedAt, survivalMs: p.survivalMs,
          tally: {
            minus1: p.tally.minus1, plus1: p.tally.plus1,
            minus2: p.tally.minus2, plus2: p.tally.plus2, gold: p.tally.gold,
          },
          readout: readout(m, p),
          scythe: scytheFor(m, p),
          shop: shopFor(m, p),
        };
      }),
    };
  }

  /* ============================ 导出 ============================ */

  return {
    MODES: MODES,
    MODE_LABEL: MODE_LABEL,
    RULES: RULES,
    PRESETS: PRESETS,
    NUM: NUM,
    EVENTS: EVENTS,
    SHOP: SHOP,
    preset: preset,
    modeLabel: modeLabel,
    probs: probs,
    probsFor: probsFor,
    doomProbs: doomProbs,
    pickIndex: pickIndex,
    createMatch: createMatch,
    cloneMatch: cloneMatch,
    applyAction: applyAction,
    leaveMatch: leaveMatch,
    pauseMatch: pauseMatch,
    resumeMatch: resumeMatch,
    elapsedMs: elapsedMs,
    readout: readout,
    scytheFor: scytheFor,
    priceOf: priceOf,
    shopFor: shopFor,
    publicView: publicView,
    newPlayer: newPlayer,
    /* V16 规则改写：configure(覆盖) / 不传 = 恢复默认 */
    configure: configure,
    currentRules: currentRules,
    EDITABLE: EDITABLE,
  };
});

/* ============================================================
 * EVENT TYPES —— 客户端只认这些，不自己算结果
 * ------------------------------------------------------------
 *  rejected      { reason, playerId, itemId? }   动作被拒（不改状态）
 *  scythe        { playerId, amount, blockedByCharm, hp }  转动前的镰刀扣血
 *  scytheArmed   { playerId, dmg, previous }      镰刀换到更重的档位
 *  roll          { playerId, idx, key, label, spins, probs }  转盘结果
 *  slip          { playerId, left }               香蕉皮：这一转转数不涨
 *  damage        { playerId, amount, blockedByCharm, hp }
 *  heal          { playerId, amount, from, to, overflow }
 *  gold          { playerId, amount, gold }
 *  interest      { playerId, principal, amount, gold }
 *  milestone     { playerId, n, lost, hp, scytheArmed }       单机节点
 *  buy           { playerId, itemId, cost, count?, targetId? }
 *  banana        { playerId, targetId, added, left }
 *  rewind        { playerId, from, to, used, limit }
 *  potion        { playerId, from, to }
 *  death         { playerId, cause:'wheel'|'scythe', spins, at, survivalMs }
 *  finished      { playerId, spins, at, survivalMs }  死神追猎撞线
 *  over          { reason, winnerId, ranking?, k?, spins? }
 *  freeze        { offline: [playerId] }          掉线封存：计时停摆、动作全拒
 *  thaw          { pausedMs }                     全员回来，解封继续
 *  leave         { playerId, name, left }         有人退出本局（房间还留着，转观战）
 *
 *  rejected.reason 取值：
 *   bad-action / game-over / frozen / no-such-player / not-your-turn / not-in-play
 *   item-not-available / no-such-item / not-enough-gold / limit-reached
 *   bad-target / target-not-in-play / no-potion / hp-full / unknown-action
 *
 *  over.reason 取值：
 *   solo：death（死亡）/ doom（走到绝境通关）/ all-left（人退光了）
 *   对赌轮盘：last-standing / all-dead / all-left
 *   死神追猎：fastest-finish / sole-finisher / last-standing / all-dead / all-left
 * ============================================================ */
