/* ============================================================
 * 端到端测试 —— 拉起 server.js，用真 WebSocket 客户端跑完整流程
 * 用法：node test-online.js
 *
 * 覆盖：静态服务 / 握手 / 加入 / 房主权限 / 开局 / 回合锁 /
 *       服务端权威（客户端无法注入状态）/ 商场 / 边界 / 重连
 * ============================================================ */

const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8123;
/* 测试用的独立存档，绝不碰真实 state.json —— 否则跑一次测试就把人家的局冲了。
   🔴 标记必须在**同一次运行内稳定**（服务端重启要靠它验"恢复"），又要**跨运行唯一**：
   只用 process.pid 的话，Windows 上 PID 很快就会被复用 ⇒ 新的一轮捡到上一轮的脏存档
   （里面可能还停在"局中"）⇒ 新连接拿不到 welcome，只收到观战邀请，报成
   「等待超时：A 收到 welcome」这种看着像网络炸了的红。 */
const RUN_TAG = process.pid + '-' + Date.now().toString(36);
const STATE = path.join(os.tmpdir(), 'rr-test-state-' + RUN_TAG + '.json');
/* V16.1：默认关掉服务端的默认房间码（584520）—— 这套测试全程假设「无码直接进房」 */
/* RR_SEED：固定服务端掷骰序列，让「转若干次攒够 150 金币」这类
   依赖概率结果的断言可复现 —— 否则同一提交在本地过、在 CI 上红。 */
const SRV_ENV = Object.assign({}, process.env, {
  RR_STATE: STATE, RR_ROOM_CODE: '', RR_SEED: '20260930',
});

function spawnServer(port) {
  return spawn(process.execPath, [__dirname + '/server.js', String(port)], {
    stdio: 'ignore', env: SRV_ENV,
  });
}

const srv = spawnServer(PORT);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
let versionAtFourth = 0;   // 第四阶段结束时的状态版本号，供第八阶段比对
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  →  ' + extra : '')); }
}

/* ---------- HTTP 工具 ---------- */
function httpGet(p, port) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: port || PORT, path: p }, r => {
      let s = ''; r.setEncoding('utf8');
      r.on('data', d => s += d);
      r.on('end', () => res({ code: r.statusCode, body: s }));
    }).on('error', rej);
  });
}

/* ---------- 原生 WebSocket 客户端 ---------- */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  if (buf.length < off + len) return null;
  return { opcode: buf[0] & 0x0f, payload: buf.slice(off, off + len), total: off + len };
}

function wsConnect(port) {
  const P = port || PORT;
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port: P, path: '/',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13,
      },
    });
    req.on('upgrade', (res, socket) => {
      const api = {
        socket, msgs: [], waiters: [],
        send(obj) {
          const payload = Buffer.from(JSON.stringify(obj), 'utf8');
          const mask = crypto.randomBytes(4);
          const masked = Buffer.from(payload);
          for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
          let head;
          if (payload.length < 126) head = Buffer.from([0x81, 0x80 | payload.length]);
          else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
          socket.write(Buffer.concat([head, mask, masked]));
        },
        /* 等一条满足 type + 可选 cond 的消息（按内容断言，避开重复广播的竞态） */
        wait(type, cond, timeout = 2000) {
          const hit0 = api.msgs.find(m => m.type === type && (!cond || cond(m)));
          if (hit0) return Promise.resolve(hit0);
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('等待 ' + type + ' 超时')), timeout);
            api.waiters.push(m => {
              if (m.type === type && (!cond || cond(m))) { clearTimeout(t); res(m); return true; }
              return false;
            });
          });
        },
        clear() { api.msgs.length = 0; },
        /* 最近一次收到的对局视图（clear() 之后也还记得） */
        lastView() { return api.lastViewEver || null; },
        close() { socket.destroy(); },
      };
      let buf = Buffer.alloc(0);
      socket.on('error', () => {});   // 拔线时会有 ECONNRESET，测试里忽略即可
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        while (true) {
          const f = decodeFrame(buf);
          if (!f) break;
          buf = buf.slice(f.total);
          if (f.opcode === 1) {
            const m = JSON.parse(f.payload.toString('utf8'));
            if (m.view) api.lastViewEver = m.view;
            api.msgs.push(m);
            api.waiters = api.waiters.filter(h => !h(m));
          }
        }
      });
      resolve(api);
    });
    req.on('error', reject);
    req.end();
  });
}

/* ============================ 测试主体 ============================ */

(async () => {
  console.log('\n生死转盘 · 联机端到端测试 v2（端口 ' + PORT + '）\n');
  await sleep(800);

  console.log('① 静态服务');
  try {
    /* V16：/ 现在是启动页（选单人 / 联机）。要验联机客户端就显式点名 client.html。 */
    const r = await httpGet('/client.html');
    ok('GET /client.html 返回 200', r.code === 200, 'code=' + r.code);
    /* V11 起入口页重做成「服务器列表 + 房间码」，按钮文案变了 ——
       判据改成结构：这确实是那一份联机客户端，不是别的页面。 */
    ok('返回的是正式联机客户端（M2）',
      r.body.includes('生 死 转 盘') && r.body.includes('engine.js') &&
      r.body.includes('srvList') && r.body.includes('manualBox') &&
      r.body.includes('codeOverlay'));
    const r2 = await httpGet('/roulette-wheel.html');
    ok('顺带服务原单机版页面', r2.code === 200);
    const r2b = await httpGet('/online-test.html');
    ok('旧的联机验证页仍可访问（保留作对照）', r2b.code === 200);
    const r3 = await httpGet('/engine.js');
    ok('浏览器也能直接取到 engine.js（UMD 双端共用）',
      r3.code === 200 && r3.body.includes('RREngine'), 'code=' + r3.code);
    const r4 = await httpGet('/../server.js');
    ok('目录穿越被拒绝', r4.code === 403 || r4.code === 404, 'code=' + r4.code);
    /* 白名单：服务端自己的状态与备忘绝不能外发 */
    const r5 = await httpGet('/state.json');
    ok('存档文件不外发（state.json → 404）', r5.code === 404, 'code=' + r5.code);
    const r6 = await httpGet('/.workbuddy/memory/MEMORY.md');
    ok('隐藏目录不外发（.workbuddy → 404）', r6.code === 404, 'code=' + r6.code);
    const r7 = await httpGet('/server.js');
    ok('服务端源码不外发（server.js → 404）', r7.code === 404, 'code=' + r7.code);
    const r8 = await httpGet('/engine-test.js');
    ok('测试脚本不外发（engine-test.js → 404）', r8.code === 404, 'code=' + r8.code);
  } catch (e) { fail++; console.log('  \u2717 静态服务异常: ' + e.message); }

  console.log('\n② 握手与加入');
  let A, B, ATOK, BTOK;
  try {
    A = await wsConnect();
    A.send({ type: 'join', name: '阿红' });
    const wa = await A.wait('welcome');
    ok('A 收到 welcome', !!wa);
    ok('A 拿到编号 1', wa.you === '1', 'you=' + wa.you);
    ok('A 看到房间里只有自己', wa.view.match.players.length === 1);
    ok('A 被自动设为房主', wa.view.room.hostId === '1', 'hostId=' + wa.view.room.hostId);
    ok('初始处于大厅阶段', wa.view.room.phase === 'lobby', wa.view.room.phase);
    ok('welcome 带重连凭证', typeof wa.token === 'string' && wa.token.length === 32, String(wa.token).length);
    ok('首次加入标记为非恢复', wa.resumed === false, String(wa.resumed));
    ok('凭证不出现在广播视图里（防别人偷看）',
      !JSON.stringify(wa.view).includes(wa.token));
    ATOK = wa.token;

    B = await wsConnect();
    B.send({ type: 'join', name: '阿赐' });
    const wb = await B.wait('welcome');
    ok('B 拿到编号 2', wb.you === '2', 'you=' + wb.you);
    ok('B 看到 2 人', wb.view.match.players.length === 2);
    ok('两人的凭证不相同', wb.token !== wa.token);
    BTOK = wb.token;

    const ra = await A.wait('sync', m => m.view.match.players.length === 2);
    ok('A 收到 B 加入的广播', ra.view.match.players.length === 2);
    ok('名字正确传递',
      wb.view.match.players.map(p => p.name).join(',') === '阿红,阿赐',
      wb.view.match.players.map(p => p.name).join(','));
  } catch (e) { fail++; console.log('  \u2717 连接阶段异常: ' + e.message); }

  console.log('\n③ 房主权限');
  try {
    await sleep(120);
    B.clear();
    B.send({ type: 'setMode', mode: 'turn' });
    const rb = await B.wait('rejected');
    ok('非房主不能切换模式', rb.reason === 'not-host', rb.reason);

    await sleep(120);
    A.clear(); B.clear();
    A.send({ type: 'setMode', mode: 'turn' });
    const ra = await A.wait('sync', m => m.view.room.mode === 'turn');
    ok('房主可以切换模式', ra.view.room.mode === 'turn');

    B.clear();
    B.send({ type: 'start' });
    const rb2 = await B.wait('rejected');
    ok('非房主不能开局', rb2.reason === 'not-host', rb2.reason);
  } catch (e) { fail++; console.log('  \u2717 房主权限异常: ' + e.message); }

  console.log('\n④ 开局与回合锁（turn 模式）');
  try {
    await sleep(120);
    A.clear(); B.clear();
    A.send({ type: 'start' });
    const st = await A.wait('sync', m => m.events.some(e => e.t === 'start'));
    ok('开局广播携带 start 事件', !!st);
    ok('阶段切到 playing', st.view.room.phase === 'playing', st.view.room.phase);
    ok('开局后血量重置为对赌轮盘的 15',
      st.view.match.players.every(p => p.hp === 15 && p.spins === 0));
    ok('轮盘从第 1 位开始', st.view.match.turnPlayerId === '1', st.view.match.turnPlayerId);

    // 不是自己的回合
    B.clear();
    B.send({ type: 'spin' });
    const rNot = await B.wait('rejected');
    ok('轮不到自己时转动被拒（not-your-turn）', rNot.reason === 'not-your-turn', rNot.reason);

    // 自己的回合
    A.clear();
    A.send({ type: 'spin' });
    const rA = await A.wait('sync', m => m.events.some(e => e.t === 'roll'));
    const rollA = rA.events.find(e => e.t === 'roll');
    ok('A 转动成功，拿到 roll 事件', !!rollA);
    ok('roll 的下标合法（0~4）', rollA.idx >= 0 && rollA.idx <= 4, 'idx=' + rollA.idx);
    ok('roll 带回当时的概率快照', Array.isArray(rollA.probs) && rollA.probs.length === 5);
    ok('共享轮盘读数 +1', rA.view.match.k === 1, 'k=' + rA.view.match.k);
    ok('回合交给 B', rA.view.match.turnPlayerId === '2', rA.view.match.turnPlayerId);

    // 转完一轮又轮回自己。这里必须按 playerId 断言 ——
    // A 上一步的广播可能比 clear() 晚到，只按「有 roll」匹配会抓到旧消息。
    await sleep(120);
    B.clear();
    B.send({ type: 'spin' });
    const rB = await B.wait('sync', m => m.events.some(e => e.t === 'roll' && e.playerId === '2'));
    ok('B 轮到后转动成功', !!rB);
    ok('轮盘读数累加到 2', rB.view.match.k === 2, 'k=' + rB.view.match.k);
    ok('回合轮回 A', rB.view.match.turnPlayerId === '1', rB.view.match.turnPlayerId);
    versionAtFourth = rB.view.room.version;
  } catch (e) { fail++; console.log('  \u2717 开局/回合异常: ' + e.message); }

  console.log('\n⑤ 服务端权威（客户端无法注入状态）');
  try {
    await sleep(150);
    A.clear();
    // 恶意客户端：试图直接指定血量、事件和转数
    A.send({ type: 'spin', idx: 1, key: 'plus2', hp: 99, gold: 999999, spins: 500 });
    const r = await A.wait('sync', m => m.events.some(e => e.playerId === '1'));
    const me = r.view.match.players.find(p => p.id === '1');
    ok('客户端伪造的 hp 被忽略', me.hp !== 99, 'hp=' + me.hp);
    ok('客户端伪造的 gold 被忽略', me.gold !== 999999, 'gold=' + me.gold);
    ok('客户端伪造的 spins 被忽略', me.spins !== 500, 'spins=' + me.spins);
    ok('服务端自己决定转盘结果（roll 事件由服务端产生）',
      r.events.some(e => e.t === 'roll'));
    ok('事件里带服务端权威标记 playerId',
      r.events.some(e => e.playerId === '1'));
  } catch (e) { fail++; console.log('  \u2717 权威性测试异常: ' + e.message); }

  console.log('\n⑥ 商场');
  try {
    await sleep(150);
    A.clear();
    A.send({ type: 'buy', itemId: 'charm' });     // 0 金买 100 金的东西
    const r1 = await A.wait('rejected');
    ok('钱不够时购买被拒（not-enough-gold）', r1.reason === 'not-enough-gold', r1.reason);

    A.clear();
    A.send({ type: 'usePotion' });                 // 没有药水
    const r2 = await A.wait('rejected');
    ok('没有药水时使用被拒（no-potion）', r2.reason === 'no-potion', r2.reason);

    B.clear();
    B.send({ type: 'buy', itemId: 'nonexistent' }); // 不存在的商品
    const r3 = await B.wait('rejected');
    ok('不存在的商品被拒（no-such-item）', r3.reason === 'no-such-item', r3.reason);
  } catch (e) { fail++; console.log('  \u2717 商场测试异常: ' + e.message); }

  console.log('\n⑦ 边界情况');
  try {
    const C = await wsConnect();
    C.send({ type: 'spin' });
    await sleep(250);
    const rej = C.msgs.find(m => m.type === 'rejected');
    ok('未加入的裸连接不能转动', !!rej && rej.reason === 'not-joined', JSON.stringify(rej));

    C.clear();
    C.send({ type: 'join', name: '闯进来的' });
    const rj = await C.wait('rejected');
    ok('对局进行中不接受新玩家（game-in-progress）',
      rj.reason === 'game-in-progress', rj.reason);
    C.close();
  } catch (e) { fail++; console.log('  \u2717 边界测试异常: ' + e.message); }

  console.log('\n⑧ 掉线封存 · 重连恢复 · 凭证防顶号');
  let A2;
  try {
    const beforeClose = JSON.parse(JSON.stringify(B.lastView().match));

    A.close();                                    // 拔线
    await sleep(400);

    const frozen = await B.wait('sync', m => m.events.some(e => e.t === 'freeze'));
    const fev = frozen.events.find(e => e.t === 'freeze');
    ok('A 掉线后 B 收到「封存」事件', !!fev);
    ok('封存事件点出掉线的人', fev && fev.offline.join(',') === '1', JSON.stringify(fev && fev.offline));
    ok('对局被标记为封存', frozen.view.match.frozen === true, String(frozen.view.match.frozen));
    ok('掉线的人被标记为离线',
      frozen.view.match.players.find(p => p.id === '1').connected === false);
    ok('封存不动任何数值（全场读数 k 不变）',
      frozen.view.match.k === beforeClose.k,
      beforeClose.k + ' → ' + frozen.view.match.k);
    ok('封存不动任何数值（双方血量不变）',
      JSON.stringify(frozen.view.match.players.map(p => p.hp)) ===
      JSON.stringify(beforeClose.players.map(p => p.hp)));

    /* 封存期间谁都不能动手 —— 连服务端都拒，不只是按钮变灰 */
    B.clear();
    B.send({ type: 'spin' });
    const rejFrozen = await B.wait('rejected');
    ok('封存期间转动被服务端拒绝（frozen）', rejFrozen.reason === 'frozen', rejFrozen.reason);
    B.clear();
    B.send({ type: 'buy', itemId: 'charm' });
    const rejFrozen2 = await B.wait('rejected');
    ok('封存期间购买也被拒（frozen）', rejFrozen2.reason === 'frozen', rejFrozen2.reason);

    /* 顶号：光知道编号，进不来 */
    const thief = await wsConnect();
    thief.send({ type: 'join', id: '1', name: '顶号的' });
    const rThief = await thief.wait('rejected');
    ok('只知道编号顶不了号（game-in-progress）', rThief.reason === 'game-in-progress', rThief.reason);
    thief.close();

    /* 伪造凭证同样进不来 */
    const fake = await wsConnect();
    fake.send({ type: 'join', token: 'deadbeef'.repeat(4), name: '伪造凭证的' });
    const rFake = await fake.wait('rejected');
    ok('伪造凭证被拒（bad-token）', rFake.reason === 'bad-token', rFake.reason);
    fake.close();

    /* 本人拿真凭证回来 */
    const spinsBefore = frozen.view.match.players.find(p => p.id === '1').spins;
    A2 = await wsConnect();
    A2.send({ type: 'join', token: ATOK, name: '阿红' });
    const wa2 = await A2.wait('welcome');
    ok('带凭证重连：恢复原座位', wa2.you === '1', 'you=' + wa2.you);
    ok('welcome 标记为「恢复」', wa2.resumed === true, String(wa2.resumed));
    ok('重连不新开人（仍是 2 人）', wa2.view.match.players.length === 2,
      String(wa2.view.match.players.length));
    ok('重连后原状态完整保留（转数不变）',
      wa2.view.match.players.find(p => p.id === '1').spins === spinsBefore,
      'spins=' + wa2.view.match.players.find(p => p.id === '1').spins);
    ok('重连后标记为在线',
      wa2.view.match.players.find(p => p.id === '1').connected === true);
    /* 房主迁移：A 掉线那一刻，房主就转给了在线且编号最小的 B。
       他回来也不自动回任 —— 免得两人来回换。 */
    ok('房主在掉线时已迁移给 B', wa2.view.room.hostId === '2', wa2.view.room.hostId);
    ok('原房主回来不自动回任', wa2.view.room.hostId !== '1', wa2.view.room.hostId);
    ok('重连后凭证不变（还是原来那枚）', wa2.token === ATOK);

    const thawed = await B.wait('sync', m => m.events.some(e => e.t === 'thaw'));
    ok('全员回来自动解封', thawed.view.match.frozen === false, String(thawed.view.match.frozen));
    ok('解封时把封存时长记进账（不计入成绩）',
      typeof thawed.view.match.pausedMs === 'number' && thawed.view.match.pausedMs >= 0,
      String(thawed.view.match.pausedMs));

    /* 解封后照常继续 */
    B.clear();
    B.send({ type: 'spin' });
    const rB = await B.wait('sync', m => m.events.some(e => e.t === 'roll' && e.playerId === '2'));
    ok('解封后能继续转动', !!rB);
    ok('版本号随状态变化递增', rB.view.room.version > versionAtFourth,
      versionAtFourth + ' → ' + rB.view.room.version);
    A2.close();
  } catch (e) { fail++; console.log('  \u2717 封存/重连异常: ' + e.message); }

  console.log('\n⑨ 新模式：死神追猎 / 对赌轮盘 / 本地死亡轮盘');
  try {
    // 以房主身份重连（房间还停在上一局的 playing），再复位回大厅
    const M = await wsConnect();
    M.send({ type: 'join', token: ATOK, name: '房主' });
    const wm = await M.wait('welcome');

    // 服务端只提供多人模式，死亡轮盘不出现在列表里
    ok('服务端模式列表只有 死神追猎 与 对赌轮盘',
      JSON.stringify(wm.view.modes.map(m => m.id)) === JSON.stringify(['race', 'turn']),
      JSON.stringify(wm.view.modes));
    ok('模式列表带中文名',
      wm.view.modes[0].label === '死神追猎' && wm.view.modes[1].label === '对赌轮盘',
      JSON.stringify(wm.view.modes.map(m => m.label)));
    ok('快照里带服务端时间（存活时间的基准）',
      typeof wm.view.serverNow === 'number' && wm.view.serverNow > 0);
    ok('快照里带房间模式中文名（与当前模式一致）',
      wm.view.room.modeLabel === (wm.view.room.mode === 'turn' ? '对赌轮盘' : '死神追猎'),
      wm.view.room.mode + '/' + wm.view.room.modeLabel);

    M.clear();
    /* 房主现在是 B（A 掉线那一刻迁移过去的）—— 特权动作要走 B 这条连接 */
    B.clear();
    B.send({ type: 'reset' });
    await B.wait('sync', m => m.view.room.phase === 'lobby');
    ok('房主可以把对局复位回大厅', true);

    B.clear();
    B.send({ type: 'setMode', mode: 'solo' });
    const rj = await B.wait('rejected');
    ok('死亡轮盘不能开在服务端（bad-mode）', rj.reason === 'bad-mode', rj.reason);

    B.clear();
    B.send({ type: 'setMode', mode: 'race' });
    const sr = await B.wait('sync', m => m.view.room.mode === 'race');
    ok('切到死神追猎成功', sr.view.room.modeLabel === '死神追猎', sr.view.room.modeLabel);
    ok('死神追猎玩家血量 10', sr.view.match.players.every(p => p.hp === 10),
      JSON.stringify(sr.view.match.players.map(p => p.hp)));
    ok('死神追猎商城不含减少转数、含香蕉皮',
      sr.view.match.players[0].shop.some(s => s.id === 'banana') &&
      !sr.view.match.players[0].shop.some(s => s.id === 'rewind'),
      JSON.stringify(sr.view.match.players[0].shop.map(s => s.id)));

    M.clear(); B.clear();
    B.send({ type: 'start' });
    const started = await M.wait('sync', m => m.events.some(e => e.t === 'start'));
    ok('死神追猎开局记录服务端起始时间',
      typeof started.view.match.startedAt === 'number' && started.view.match.startedAt > 0,
      String(started.view.match.startedAt));
    ok('开局两人都是 10 血',
      started.view.match.players.every(p => p.hp === 10),
      JSON.stringify(started.view.match.players.map(p => p.hp)));

    // 攒钱：死神追猎里金币只能靠转盘攒（金币格 20%，所以转数是随机的 ——
    //   上限给到 60 次而不是 25 次：25 次里只中 2 格金币的概率约 6%，
    //   这个测试会**间歇性假失败**，排查起来极贵。对局一旦结束就停手，
    //   免得为了攒钱把人转死。）
    let gold = 0, guard = 0;
    while (gold < 150 && guard++ < 60) {
      M.clear();
      M.send({ type: 'spin' });
      const s = await M.wait('sync', m => m.events.some(e => e.t === 'roll' && e.playerId === '1'));
      if (s.view.match.phase === 'over') break;
      gold = s.view.match.players.find(p => p.id === '1').gold;
    }
    ok('在死神追猎里转若干次后攒够买香蕉皮的钱', gold >= 150,
      'gold=' + gold + '（转了 ' + guard + ' 次）');

    // 香蕉皮必须指定目标（此时钱够了，所以拒因是 bad-target 而不是钱不够）
    M.clear();
    M.send({ type: 'buy', itemId: 'banana' });
    const rb1 = await M.wait('rejected');
    ok('香蕉皮不带目标被拒（bad-target）', rb1.reason === 'bad-target', rb1.reason);

    // 香蕉皮走一遍完整链路
    M.clear();
    M.send({ type: 'buy', itemId: 'banana', targetId: '2' });
    const bought = await M.wait('sync', m => m.events.some(e => e.t === 'banana'));
    ok('香蕉皮指定对手后购买成功（对手挂 5 次）',
      bought.view.match.players.find(p => p.id === '2').bananas === 5,
      String(bought.view.match.players.find(p => p.id === '2').bananas));
    ok('香蕉皮价格 150', bought.events.find(e => e.t === 'buy').cost === 150,
      JSON.stringify(bought.events.find(e => e.t === 'buy')));

    await sleep(150);
    B.clear();
    B.send({ type: 'spin' });
    const slipped = await B.wait('sync', m => m.events.some(e => e.t === 'slip' && e.playerId === '2'));
    ok('被扔香蕉皮的人转动时转数不涨',
      slipped.view.match.players.find(p => p.id === '2').spins === 0,
      String(slipped.view.match.players.find(p => p.id === '2').spins));
    ok('但转盘效果照常结算（roll 事件仍在，且 counted=false）',
      slipped.events.some(e => e.t === 'roll') &&
      slipped.events.find(e => e.t === 'roll').counted === false);

    ok('视图暴露存活时间字段（未定局时为 null）',
      slipped.view.match.players.every(p => p.survivalMs === null),
      JSON.stringify(slipped.view.match.players.map(p => p.survivalMs)));

    M.close();
  } catch (e) {
    fail++;
    console.log('  \u2717 新模式测试异常: ' + e.message);
    console.log('    B 收到：' + JSON.stringify(B.msgs.map(m => m.type + '/'
      + (m.view ? ('host=' + m.view.room.hostId + ',phase=' + m.view.room.phase) : m.reason))));
  }

  console.log('\n⑩ 掉线的人不在场，不许开局 · 房主自动迁移');
  let H;
  try {
    H = await wsConnect();
    H.send({ type: 'join', token: ATOK, name: '阿红' });
    await H.wait('welcome');

    /* 房主现在是 B（座位 2）—— 收回大厅的特权动作得由它发 */
    B.clear();
    B.send({ type: 'reset' });
    const backToLobby = await B.wait('sync', m => m.view.room.phase === 'lobby');
    ok('房主把对局收回大厅', backToLobby.view.room.phase === 'lobby', backToLobby.view.room.phase);

    /* 房主掉线 → 房主必须自动转给还在线的人，否则全房间没人能收尾（v3 的死锁） */
    H.clear();
    B.close();
    const mig = await H.wait('sync', m => m.view.room.hostId === '1');
    ok('房主掉线 → 房主自动迁移给在线的玩家', mig.view.room.hostId === '1', mig.view.room.hostId);
    await sleep(250);

    H.clear();
    H.send({ type: 'start' });
    const rOff = await H.wait('rejected');
    ok('有人掉线时开局被拒（player-offline）', rOff.reason === 'player-offline', rOff.reason);

    const B3 = await wsConnect();
    B3.send({ type: 'join', token: BTOK, name: '阿赐' });
    await B3.wait('welcome');
    H.clear();
    H.send({ type: 'start' });
    const started = await H.wait('sync', m => m.events.some(e => e.t === 'start'));
    ok('人到齐后可以正常开局', !!started);
    ok('开局时没有封存（全员在线）', started.view.match.frozen === false,
      String(started.view.match.frozen));
    /* 关掉这条连接 = 座位 2 掉线，对局会立刻封存。等它落定，下一节再连回来解封。 */
    B3.close();
    await sleep(300);
  } catch (e) { fail++; console.log('  \u2717 掉线开局异常: ' + e.message); }

  console.log('\n⑪ 存档：服务重启后原地继续');
  let srv2, B4;
  try {
    /* 座位 2 刚掉线，对局是封存状态。先把它连回来解封，否则下面转动会被 frozen 拒掉。
       （这不是产品问题：封存本来就该拒绝一切动作。是本节测试自己没考虑到封存。） */
    B4 = await wsConnect();
    B4.send({ type: 'join', token: BTOK, name: '阿赐' });
    await B4.wait('welcome');

    /* 先制造一点进度，重启后才有东西可验 */
    H.clear();
    H.send({ type: 'spin' });
    const spun = await H.wait('sync', m => m.events.some(e => e.t === 'roll' && e.playerId === '1'));
    const before = JSON.parse(JSON.stringify(spun.view.match));
    const mySpins = before.players.find(p => p.id === '1').spins;
    ok('重启前已有进度（转数有记录）', mySpins >= 1, 'spins=' + mySpins + ' k=' + before.k);

    await sleep(400);                 // 等合并写盘落下来
    srv.kill();
    await sleep(600);

    srv2 = spawnServer(PORT + 1);
    await sleep(900);

    const R = await wsConnect(PORT + 1);
    R.send({ type: 'join', token: ATOK, name: '房主' });
    const wr = await R.wait('welcome');
    ok('重启后带凭证仍能回到自己的座位', wr.you === '1', 'you=' + wr.you);
    ok('重启后对局还是「进行中」', wr.view.room.phase === 'playing', wr.view.room.phase);
    ok('重启后转数还原', wr.view.match.players.find(p => p.id === '1').spins === mySpins,
      mySpins + ' → ' + wr.view.match.players.find(p => p.id === '1').spins);
    ok('重启后血量还原',
      JSON.stringify(wr.view.match.players.map(p => p.hp)) ===
      JSON.stringify(before.players.map(p => p.hp)),
      JSON.stringify(before.players.map(p => p.hp)) + ' → ' +
      JSON.stringify(wr.view.match.players.map(p => p.hp)));
    ok('重启后金币/道具等明细还原',
      JSON.stringify(wr.view.match.players.map(p => [p.gold, p.charms, p.potions, p.spins])) ===
      JSON.stringify(before.players.map(p => [p.gold, p.charms, p.potions, p.spins])));
    ok('重启后没有人回来，自动处于封存状态', wr.view.match.frozen === true,
      String(wr.view.match.frozen));
    ok('重启后模式也还原', wr.view.room.mode === before.mode,
      before.mode + ' → ' + wr.view.room.mode);
    R.close();
    srv2.kill();
  } catch (e) { fail++; console.log('  \u2717 存档恢复异常: ' + e.message); }

  /* ============ ⑫ 退出本局 · 观战 · 房间成员（独立房间） ============ */
  console.log('\n⑫ 退出本局 · 观战 · 房间成员（独立房间，端口 ' + (PORT + 2) + '）');
  const P3 = PORT + 2;
  const STATE3 = STATE + '.3';
  let srv3;
  try {
    srv3 = spawn(process.execPath, [__dirname + '/server.js', String(P3)], {
      stdio: 'ignore', env: Object.assign({}, process.env, { RR_STATE: STATE3, RR_ROOM_CODE: '' }),
    });
    await sleep(900);

    /* 三人进房 */
    const J1 = await wsConnect(P3);
    J1.send({ type: 'join', name: '甲' });
    const w1 = await J1.wait('welcome');
    const T1 = w1.token;
    ok('甲 进房拿到编号 1 与房主', w1.you === '1' && w1.view.room.hostId === '1');
    ok('大厅阶段是「玩家」身份而不是观战', w1.spectator === false, String(w1.spectator));
    ok('视图里带观战名单字段（初始为空）',
      Array.isArray(w1.view.watchers) && w1.view.watchers.length === 0,
      JSON.stringify(w1.view.watchers));

    const J2 = await wsConnect(P3);
    J2.send({ type: 'join', name: '乙' });
    const w2 = await J2.wait('welcome');
    const J3 = await wsConnect(P3);
    J3.send({ type: 'join', name: '丙' });
    const w3 = await J3.wait('welcome');
    const T3 = w3.token;
    ok('三人都在名单里', w3.view.match.players.length === 3, String(w3.view.match.players.length));

    J1.clear();
    J1.send({ type: 'setMode', mode: 'turn' });
    await J1.wait('sync', m => m.view.room.mode === 'turn');
    J1.clear();
    J1.send({ type: 'start' });
    const st = await J1.wait('sync', m => m.events.some(e => e.t === 'start'));
    ok('对赌轮盘开局（3 人）',
      st.view.match.players.length === 3 && st.view.room.phase === 'playing');

    /* ① 丙 退出本局 → 转观战 */
    J1.clear();
    J3.send({ type: 'leave' });
    const lv = await J1.wait('sync', m => m.events.some(e => e.t === 'leave'));
    const lev = lv.events.find(e => e.t === 'leave');
    ok('退出本局广播 leave 事件', !!lev);
    ok('leave 事件点出是谁走的', lev && lev.playerId === '3' && lev.name === '丙',
      lev ? (lev.playerId + '/' + lev.name) : '—');
    ok('退出的人从对局名单里摘掉', !lv.view.match.players.some(p => p.id === '3'));
    ok('场上还剩 2 人', lv.view.match.order.length === 2, String(lv.view.match.order.length));
    ok('走了一个人，对局照常继续（没被吊住）', lv.view.match.phase === 'playing', lv.view.match.phase);
    ok('退出本局的人进观战名单', lv.view.watchers.some(w => w.id === '3'),
      JSON.stringify(lv.view.watchers.map(w => w.id)));
    ok('房主身份跟着人走（甲 仍是房主）', lv.view.room.hostId === '1', lv.view.room.hostId);

    /* ② 观战者不能动手 —— 服务端拒，不只是按钮变灰 */
    J3.clear();
    J3.send({ type: 'spin' });
    const rj1 = await J3.wait('rejected');
    ok('观战者不能转动（not-in-play）', rj1.reason === 'not-in-play', rj1.reason);
    J3.clear();
    J3.send({ type: 'buy', itemId: 'charm' });
    const rj2 = await J3.wait('rejected');
    ok('观战者不能购物（not-in-play）', rj2.reason === 'not-in-play', rj2.reason);

    /* ③ 观战者也拿凭证：刷新页面能回到观战席 */
    J1.clear();
    J3.close();
    await sleep(300);
    const J3b = await wsConnect(P3);
    J3b.send({ type: 'join', token: T3, name: '丙' });
    const w3b = await J3b.wait('welcome');
    ok('观战凭证能恢复观战身份', w3b.resumed === true && w3b.spectator === true,
      JSON.stringify({ resumed: w3b.resumed, spectator: w3b.spectator }));
    ok('恢复观战不新开人（还是编号 3）', w3b.you === '3', w3b.you);
    ok('恢复时告知「你上次是退出本局的」', w3b.leftMatch === true, String(w3b.leftMatch));
    ok('观战不算选手（对局仍是 2 人）', w3b.view.match.players.length === 2,
      String(w3b.view.match.players.length));

    /* ④ 对局进行中进来的新人，可以选择观战 */
    const G = await wsConnect(P3);
    G.send({ type: 'join', name: '路人' });
    const ro = await G.wait('rejected');
    ok('对局中进房被拒，但给了观战选项',
      ro.reason === 'game-in-progress' && ro.canSpectate === true,
      JSON.stringify({ reason: ro.reason, canSpectate: ro.canSpectate }));
    ok('拒信里带了模式与场上名单（客户端好显示）',
      typeof ro.modeLabel === 'string' && Array.isArray(ro.players) && ro.players.length === 2,
      JSON.stringify(ro.players));

    G.clear();
    G.send({ type: 'join', name: '路人', spectate: true });
    const wg = await G.wait('welcome');
    const GID = wg.you;
    ok('选择观战后以观战身份进入', wg.spectator === true && wg.resumed === false,
      JSON.stringify({ spectator: wg.spectator, resumed: wg.resumed }));
    ok('观战者也有自己的编号与凭证',
      typeof wg.token === 'string' && wg.token.length === 32 && !!GID);
    ok('路人 出现在观战名单里', wg.view.watchers.some(w => w.name === '路人'),
      JSON.stringify(wg.view.watchers.map(w => w.name)));
    ok('观战者不进对局名单', !wg.view.match.players.some(p => p.name === '路人'));
    ok('对局人数没被观战者顶掉（仍 2 人）', wg.view.match.players.length === 2);

    G.clear();
    G.send({ type: 'spin' });
    const rg = await G.wait('rejected');
    ok('中途进来的观战者同样不能转动', rg.reason === 'not-in-play', rg.reason);

    /* ⑤ 退出观战 = 真的离开房间 */
    J2.clear();
    G.clear();
    G.send({ type: 'quit' });
    const lr = await G.wait('left-room');
    ok('退出观战：服务端确认离开房间', !!lr);
    const afterQuit = await J2.wait('sync', m => !m.view.watchers.some(w => w.id === GID));
    ok('退出观战后观战名单里没有他了', afterQuit.view.watchers.every(w => w.id !== GID),
      JSON.stringify(afterQuit.view.watchers.map(w => w.id)));

    /* ⑥ 甲（房主）掉线 → 房主迁移给还在打的 乙 */
    J2.clear();
    J1.close();
    const mig1 = await J2.wait('sync', m => m.view.room.hostId === '2');
    ok('房主掉线 → 房主迁移给对局里的 乙', mig1.view.room.hostId === '2', mig1.view.room.hostId);
    const froz1 = await J2.wait('sync', m => m.view.match.frozen === true);
    ok('房主掉线照样触发封存（他人还在对局里）', froz1.view.match.frozen === true,
      String(froz1.view.match.frozen));

    /* ⑦ 乙 退出本局：对局里只剩 1 个在册选手 → 本局立刻定局 */
    J2.clear();
    J2.send({ type: 'leave' });
    const lv2 = await J2.wait('sync', m => m.events.some(e => e.t === 'leave'));
    ok('乙 退出后对局结束', lv2.view.match.phase === 'over', lv2.view.match.phase);
    ok('只剩一个在册选手 → 按「最后一个站着的人」胜出',
      lv2.view.match.reason === 'last-standing', lv2.view.match.reason);
    ok('退出本局的人保住房主身份（乙 仍是房主）',
      lv2.view.room.hostId === '2', lv2.view.room.hostId);

    /* ⑧ 房主成了观战者、而且他掉线 → 房主继续迁移给还在线的观战者 */
    J3b.clear();
    J2.close();
    const mig2 = await J3b.wait('sync', m => m.view.room.hostId === '3');
    ok('观战者房主掉线 → 房主继续迁移给在线的观战者',
      mig2.view.room.hostId === '3', mig2.view.room.hostId);

    /* ⑨ 甲 连回来解封；房主（观战者丙）点回大厅 → 观战者自动回名单 */
    const J1b = await wsConnect(P3);
    J1b.send({ type: 'join', token: T1, name: '甲' });
    const w1b = await J1b.wait('welcome');
    ok('掉线的人拿凭证回来仍是选手身份', w1b.spectator === false && w1b.you === '1',
      JSON.stringify({ spectator: w1b.spectator, you: w1b.you }));

    J3b.clear();
    J3b.send({ type: 'reset' });
    const back = await J3b.wait('sync', m => m.view.room.phase === 'lobby');
    ok('观战者当房主也能把房间收回大厅', back.view.room.phase === 'lobby', back.view.room.phase);
    ok('回大厅后观战者自动回到选手名单',
      back.view.match.players.some(p => p.id === '3') && back.view.match.players.some(p => p.id === '1'),
      JSON.stringify(back.view.match.players.map(p => p.id)));
    ok('回大厅后观战名单清空', back.view.watchers.length === 0,
      JSON.stringify(back.view.watchers));
    ok('回大厅后名单按编号排序', back.view.match.order[0] === '1',
      JSON.stringify(back.view.match.order));

    /* ⑩ 选手直接退房（大厅里）—— 座位一并清掉，不留「掉线」幽灵。
       客户端大厅是个全屏遮罩，没有这个出口就再也够不到连接栏了。 */
    J3b.clear();
    J1b.clear();
    J1b.send({ type: 'quit' });
    const q1 = await J1b.wait('left-room');
    ok('选手也能用 quit 直接退房（不再被 not-watching 拒掉）', !!q1);
    const gone1 = await J3b.wait('sync', m => !m.view.match.players.some(p => p.id === '1'));
    ok('退房后 1 号从选手名单里彻底消失', gone1.view.match.players.every(p => p.id !== '1'),
      JSON.stringify(gone1.view.match.players.map(p => p.id)));
    ok('退房后名单顺序里也没有他了', gone1.view.match.order.indexOf('1') < 0,
      JSON.stringify(gone1.view.match.order));
    ok('房主没变（走的人不是房主）', gone1.view.room.hostId === '3', gone1.view.room.hostId);

    J1b.close(); J3b.close();
  } catch (e) { fail++; console.log('  \u2717 退出本局/观战异常: ' + e.message); }
  finally { if (srv3) srv3.kill(); try { fs.unlinkSync(STATE3); } catch (e) {} }

  /* ---------- 命令行参数不再互相抢（V18.2） ----------
     🔴 曾经 argv[3] 同时是**房间码**（:44）和**管理台端口**（`Number(argv[3]) || PORT+1000`）。
     于是 `node server.js 8080 584520`（命令行带码开房）会让管理台去 listen 584520，
     直接 ERR_SOCKET_BAD_PORT —— 服务端压根起不来，只能绕道 RR_ROOM_CODE 环境变量。
     现在分工：argv[3] = 房间码，argv[4] / RR_ADMIN_PORT = 管理台端口（默认 PORT+1000）。 */
  console.log('\n  命令行参数：房间码 / 管理台端口\n');
  {
    const P = 8188;
    const srvCode = spawn(process.execPath, [__dirname + '/server.js', String(P), '584520'], {
      stdio: 'ignore', env: Object.assign({}, SRV_ENV, { RR_STATE: STATE + '-code.json' }),
    });
    let info = null;
    for (let i = 0; i < 80 && !info; i++) {
      await sleep(100);
      try {
        const r = await httpGet('/api/info', P + 1000);
        if (r.code === 200) info = JSON.parse(r.body);
      } catch (e) {}
    }
    ok('★ 命令行带房间码启动 → 服务端起得来（不再 ERR_SOCKET_BAD_PORT）', !!info,
      info ? '' : '管理台端口被房间码抢走了 ⇒ 服务端没起来');
    ok('★ 管理台端口回到默认（游戏端口 + 1000），不再被房间码抢走',
      !!info && info.adminPort === P + 1000, info ? 'adminPort=' + info.adminPort : '—');
    ok('★ argv[3] 依然是房间码（门禁照旧）',
      !!info && info.code === '584520', info ? 'code=' + info.code : '—');
    srvCode.kill();

    /* 多开实例时要能指定管理台端口（否则只能靠默认的 PORT+1000） */
    const P2 = 8189, ADM = 9190;
    const srvEnv = spawn(process.execPath, [__dirname + '/server.js', String(P2), '', String(ADM)], {
      stdio: 'ignore',
      env: Object.assign({}, SRV_ENV, { RR_STATE: STATE + '-adm.json' }),
    });
    let info2 = null;
    for (let i = 0; i < 80 && !info2; i++) {
      await sleep(100);
      try {
        const r = await httpGet('/api/info', ADM);
        if (r.code === 200) info2 = JSON.parse(r.body);
      } catch (e) {}
    }
    ok('★ argv[4] 也能指定管理台端口（命令行这条路没被堵死）',
      !!info2 && info2.adminPort === ADM, info2 ? 'adminPort=' + info2.adminPort : '—');
    srvEnv.kill();

    /* 环境变量那条路也要通（脚本里起服通常用环境变量，比数第几个参数清楚） */
    /* 🔴 ADM2 必须**不等于** P3b+1000（默认值）—— 否则这条断言在「环境变量根本没生效」
       时也照样是绿的，等于没测。有牙验证时它必须跟着红。 */
    const P3b = 8191, ADM2 = 9299;
    const srvEnv2 = spawn(process.execPath, [__dirname + '/server.js', String(P3b)], {
      stdio: 'ignore',
      env: Object.assign({}, SRV_ENV,
        { RR_STATE: STATE + '-adm2.json', RR_ADMIN_PORT: String(ADM2) }),
    });
    let info3 = null;
    for (let i = 0; i < 80 && !info3; i++) {
      await sleep(100);
      try {
        const r = await httpGet('/api/info', ADM2);
        if (r.code === 200) info3 = JSON.parse(r.body);
      } catch (e) {}
    }
    ok('★ RR_ADMIN_PORT 环境变量也能指定管理台端口',
      !!info3 && info3.adminPort === ADM2, info3 ? 'adminPort=' + info3.adminPort : '—');
    srvEnv2.kill();
    try { fs.unlinkSync(STATE + '-code.json'); } catch (e) {}
    try { fs.unlinkSync(STATE + '-adm.json'); } catch (e) {}
    try { fs.unlinkSync(STATE + '-adm2.json'); } catch (e) {}
  }

  console.log('\n────────────────────────');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('────────────────────────\n');

  try { A && A.close(); B && B.close(); B4 && B4.close(); H && H.close(); } catch (e) {}
  srv.kill();
  if (srv2) srv2.kill();
  try { fs.unlinkSync(STATE); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n测试崩溃：' + e.message);
  srv.kill();
  try { fs.unlinkSync(STATE); } catch (e2) {}
  process.exit(1);
});
