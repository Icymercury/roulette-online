/* ============================================================
 * UDP 发现协议 · 端到端测试
 * 用法：node discovery-test.js
 *
 * 覆盖：服务器编号的派生与稳定性 / DISCOVER 广播与单播回复 /
 *       卡片字段（不含房间码本身）/ 房主改名称与房间码 /
 *       非房主改配置被拒 / 房间码真的挡住新加入 / RR_NO_DISCOVERY 开关
 *
 * 全程用真 UDP socket 对真 server.js 说话 —— 不 mock 网络。
 * ============================================================ */

const { spawn } = require('child_process');
const dgram = require('dgram');
const os = require('os');
const path = require('path');

const DIR = __dirname;
const P_A = { http: 8131, disc: 8132 };
const P_B = { http: 8133, disc: 8134 };   // 只用来验证「同机同编号」
const P_C = { http: 8135, disc: 8136 };   // 关掉发现的对照
const P_D = { http: 8137, disc: 8138 };   // 验「默认房间码」，这一台**保留**默认码不关

const STATE = path.join(os.tmpdir(), 'rr-disc-test-' + process.pid + '-' + Date.now().toString(36) + '.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  →  ' + extra : '')); }
}

/* ---------------- 服务器进程 ---------------- */
/* V16.1：服务端现在**默认带房间码 584520**。绝大多数断言要的是「无码直接进房」，
   所以默认给这些测试服务端传 RR_ROOM_CODE='' 关掉它；
   要验「默认码 / 重启回默认」的那组传 { defaultCode: true } 保留默认行为。 */
function startServer(p, extraEnv, opts) {
  const o = opts || {};
  const env = Object.assign({}, process.env, {
    RR_STATE: STATE + '-' + p.http + '.json',
    RR_NO_OPEN: '1',
    RR_DISCOVERY_PORT: String(p.disc),
  }, extraEnv || {});
  if (!o.defaultCode) env.RR_ROOM_CODE = '';
  const child = spawn(process.execPath, [path.join(DIR, 'server.js'), String(p.http)], {
    cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'],
    env: env,
  });
  let out = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { out += d.toString(); });
  return { child, log: () => out };
}

async function waitUp(srv) {
  const t0 = Date.now();
  while (Date.now() - t0 < 9000) {
    /* 等横幅**最后一行**（「按 Ctrl+C 停止服务」）。
       stdout 是顺序流：末尾到了，就说明整块横幅都到了。
       🔴 不能只等「本机打开」—— 那一行在横幅中间，子进程的 stdout 分块
          可能正好把它和前面要解析的几行切开，于是后面 /服务器编号：/
          之类的正则匹配不到（V16 把横幅加长了几行之后踩到）。 */
    if (/按 Ctrl\+C 停止服务/.test(srv.log())) return true;
    await sleep(60);
  }
  /* 兜底：万一横幅改版没了那行，退回旧判据 */
  return /本机打开/.test(srv.log());
}

/* ---------------- 真 UDP 询问 ---------------- */
/* 从临时端口发 DISCOVER，只收单播回复（广播心跳落不到这个临时端口上）。
   host 用 rinfo.address —— 卡片里本来没有地址，地址来自「谁回的」。

   🔴 一次发问、只等 800ms 是不够的：广播包在真实网络里会丢（本机实测
      偶尔整轮都收不到回包），于是「重启后设置恢复」这类断言会**随机红**。
      现在改成：先问一次，没回音就再问（最多 3 次）—— 真机 App 本来也是
      每隔几秒反复扫的，重试才是对的行为，不是给测试放水。
      同一台服务器回多次没关系：**按 id 去重**，所以卡片数断言不变。 */
function discover(port, target, timeoutMs) {
  return new Promise(resolve => {
    const c = dgram.createSocket('udp4');
    const seen = new Map();          // id → 卡片（去重）
    let closed = false;
    function finish() {
      if (closed) return;
      closed = true;
      try { c.close(); } catch (e) {}
      resolve(Array.from(seen.values()));
    }
    c.on('message', (b, ri) => {
      try {
        const o = JSON.parse(b.toString('utf8'));
        if (o && o.RRSP === 1 && !o.q) {
          o.host = ri.address;
          if (!seen.has(o.id)) seen.set(o.id, o);
        }
      } catch (e) { /* 不是我们的包 */ }
    });
    c.on('error', () => {});
    const q = Buffer.from(JSON.stringify({ RRSP: 1, q: 'who' }), 'utf8');
    const dest = target || '255.255.255.255';
    c.bind(0, '0.0.0.0', () => {
      try { c.setBroadcast(true); } catch (e) {}
      /* 只问一次（正常情况一次就有回音）；没回音再补两次，别动不动就等满 2 秒 */
      const ask = () => { try { c.send(q, 0, q.length, port, dest, () => {}); } catch (e) {} };
      ask();
      setTimeout(() => {
        if (seen.size || closed) return finish();
        ask();
        setTimeout(() => {
          if (seen.size || closed) return finish();
          ask();
          setTimeout(finish, 400);
        }, 400);
      }, timeoutMs || 800);
    });
  });
}

/* ---------------- 真 WebSocket 客户端 ---------------- */
function openWs(port, host) {
  const H = host || '127.0.0.1';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://' + H + ':' + port);
    const msgs = [];
    ws.addEventListener('message', ev => {
      try { msgs.push(JSON.parse(String(ev.data))); } catch (e) {}
    });
    ws.addEventListener('open', () => resolve({
      msgs,
      send(o) { ws.send(JSON.stringify(o)); },
      async waitFor(fn, ms) {
        const t0 = Date.now();
        while (Date.now() - t0 < (ms || 3000)) {
          const v = fn();
          if (v) return v;
          await sleep(15);
        }
        return null;
      },
      last(type) { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].type === type) return msgs[i]; return null; },
      view() { const m = this.last('sync'); return m ? m.view : null; },
      close() { try { ws.close(); } catch (e) {} },
    }));
    ws.addEventListener('error', () => reject(new Error('WebSocket 连不上 ' + H + ':' + port)));
  });
}

/* ============================================================ */
(async function main() {
  console.log('\n\u2460 服务器起来 & 横幅身份\n');
  const A = startServer(P_A);
  const B = startServer(P_B);
  const C = startServer(P_C, { RR_NO_DISCOVERY: '1' });
  ok('A / B / C 三个服务端都起来了', (await waitUp(A)) && (await waitUp(B)) && (await waitUp(C)));

  const bannerA = A.log();
  ok('横幅印出「服务器编号」', /服务器编号：\s*\S+/.test(bannerA));
  ok('横幅印出「服务器名称」', /服务器名称：\s*\S+/.test(bannerA));
  const idA = (bannerA.match(/服务器编号：\s*(\S+)/) || [])[1] || '';
  /* B32 字母表去掉了 0/1/I/O，格式是 XXX-XXX */
  ok('编号格式是 XXX-XXX 且不含易混字符', /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/.test(idA), '实际 ' + JSON.stringify(idA));

  const idB = ((B.log().match(/服务器编号：\s*(\S+)/) || [])[1]) || '';
  ok('同一台机器上的两个服务端编号相同（编号由设备决定）', idA && idA === idB, idA + ' vs ' + idB);

  console.log('\n\u2461 DISCOVER 广播 → 单播回复\n');
  const c1 = await discover(P_A.disc, '255.255.255.255');
  ok('广播一次收到 1 张卡片', c1.length === 1, '实际 ' + c1.length);
  const card = c1[0] || {};
  ok('卡片带 RRSP 版本号', card.RRSP === 1);
  ok('卡片带服务器编号（与横幅一致）', card.id === idA, card.id + ' vs ' + idA);
  ok('卡片带服务器名称', typeof card.name === 'string' && card.name.length > 0, JSON.stringify(card.name));
  ok('卡片带 HTTP 端口', card.port === P_A.http, String(card.port));
  ok('卡片带人数与状态', typeof card.players === 'number' && card.phase === 'lobby',
    'players=' + card.players + ' phase=' + card.phase);
  ok('卡片带模式名', typeof card.modeLabel === 'string' && card.modeLabel.length > 0, JSON.stringify(card.modeLabel));
  ok('未设房间码时 needCode=false', card.needCode === false, String(card.needCode));
  ok('★ 卡片里没有房间码本身（只告诉「要不要」）', !('code' in card) && !JSON.stringify(card).includes('"code"'));
  ok('★ 回复来源是真实存在的局域网 IPv4（客户端要拿它去连）',
    /^\d+\.\d+\.\d+\.\d+$/.test(card.host || '') && card.host !== '0.0.0.0', String(card.host));

  /* 地址来自「谁回的包」，卡片本身不带地址 —— 换个源地址问，来源就跟着变 */
  const cLoop = await discover(P_A.disc, '127.0.0.1');
  ok('换成回环询问时，来源地址就是 127.0.0.1（地址由回复方决定，不是卡片字段）',
    cLoop.length === 1 && cLoop[0].host === '127.0.0.1',
    JSON.stringify(cLoop.map(x => x.host)));

  console.log('\n\u2462 RR_NO_DISCOVERY=1 → 不回话\n');
  const cC = await discover(P_C.disc, '255.255.255.255', 900);
  ok('关掉发现的服务端不回复 DISCOVER', cC.length === 0, '实际 ' + cC.length + ' 张');
  ok('关掉发现也不影响它正常起服', /本机打开/.test(C.log()));

  console.log('\n\u2463 房主改服务器名称 / 房间码\n');
  const H = await openWs(P_A.http);
  H.send({ type: 'join', name: '房主甲' });
  const w = await H.waitFor(() => H.last('welcome'), 3000);
  ok('房主甲进了房', !!w, JSON.stringify(H.last('rejected')));
  ok('自己是房主', !!(w && w.view && w.view.room.hostId === '1'), w ? JSON.stringify(w.view.room) : '(无 welcome)');

  const G = await openWs(P_A.http);
  G.send({ type: 'join', name: '路人乙' });
  const w2 = await G.waitFor(() => G.last('welcome'), 3000);
  ok('路人乙也进了房', !!w2, JSON.stringify(G.last('rejected')));

  /* 非房主改配置 → 拒 */
  G.send({ type: 'config', name: '我说了算' });
  const rj = await G.waitFor(() => G.last('rejected') && G.last('rejected').reason === 'not-host', 2500);
  ok('★ 非房主改服务器设置被拒（not-host）', !!rj, JSON.stringify(G.last('rejected')));

  /* 房主改：名称 + 房间码 */
  H.send({ type: 'config', name: '阿红的房间', code: '7788' });
  const cfg = await H.waitFor(() => {
    const v = H.view();
    return v && v.room && v.room.name === '阿红的房间' && v.room.code === '7788' ? v : null;
  }, 3000);
  ok('★ 房主改完名称与房间码，视图已同步', !!cfg,
    cfg ? JSON.stringify(cfg.room) : JSON.stringify(H.view() && H.view().room));
  ok('房间码「需要」标志跟着变 true', !!(cfg && cfg.room.needCode === true));
  ok('服务器编号没有被改（它由设备决定，不是设置项）', !!(cfg && cfg.room.serverId === idA),
    cfg ? String(cfg.room.serverId) : '');
  const evCfg = await H.waitFor(() => H.msgs.find(m => (m.events || []).some(e => e.t === 'config')), 2500);
  ok('广播了 config 事件（客户端要往日志里写一条）', !!evCfg);

  /* 改完再问一次：卡片要跟着变 */
  console.log('\n\u2464 改完之后卡片跟着变\n');
  const c2 = await discover(P_A.disc, '255.255.255.255');
  const card2 = c2[0] || {};
  ok('卡片里的名称变成新的', card2.name === '阿红的房间', JSON.stringify(card2.name));
  ok('★ 卡片 now needCode=true（App 会因此弹房间码输入框）', card2.needCode === true, String(card2.needCode));
  ok('★ 卡片仍然不含房间码本身', !JSON.stringify(card2).includes('7788'));
  ok('人数跟着涨到 2', card2.players === 2, String(card2.players));

  /* 房间码真的挡住新人 */
  console.log('\n\u2465 房间码真的挡住新加入的人\n');
  const X = await openWs(P_A.http);
  X.send({ type: 'join', name: '没带码的人' });
  const rj2 = await X.waitFor(() => X.last('rejected') && X.last('rejected').reason === 'bad-room-code', 2500);
  ok('★ 不带码加入被打回（bad-room-code）', !!rj2, JSON.stringify(X.last('rejected')));

  const X2 = await openWs(P_A.http);
  X2.send({ type: 'join', name: '带对码的人', pass: '7788' });
  const w3 = await X2.waitFor(() => X2.last('welcome'), 3000);
  ok('带对的码就能进', !!w3, JSON.stringify(X2.last('rejected')));

  /* 已经在房里的人不受改码影响（他们早就进来了） */
  console.log('\n\u2466 改码不影响已在房里的人\n');
  H.send({ type: 'config', code: '' });
  const cfg2 = await H.waitFor(() => {
    const v = H.view();
    return v && v.room && v.room.needCode === false ? v : null;
  }, 3000);
  ok('房主可以把房间码清空（needCode 变回 false）', !!cfg2);
  ok('清空后名称保留（只改了码）', !!(cfg2 && cfg2.room.name === '阿红的房间'),
    cfg2 ? JSON.stringify(cfg2.room.name) : '');
  ok('已有成员一直在房里没被踢', !!(cfg2 && cfg2.match.players.length >= 3),
    cfg2 ? String(cfg2.match.players.length) : '');

  /* 房间码会落盘 */
  console.log('\n\u2467 设置会落盘\n');
  H.send({ type: 'config', name: '落盘测试房', code: 'AB12' });
  await H.waitFor(() => {
    const v = H.view();
    return v && v.room && v.room.code === 'AB12' ? v : null;
  }, 3000);
  await sleep(500);          // 等 saveState 写盘
  let saved = null;
  try { saved = JSON.parse(require('fs').readFileSync(STATE + '-' + P_A.http + '.json', 'utf8')); } catch (e) {}
  ok('存档里写了服务器名称', !!(saved && saved.name === '落盘测试房'), saved ? JSON.stringify(saved.name) : '(没读到存档)');
  ok('存档里写了房间码', !!(saved && saved.code === 'AB12'), saved ? JSON.stringify(saved.code) : '(没读到存档)');

  H.close(); G.close(); X.close(); X2.close();
  await sleep(200);

  console.log('\n\u2468 重启后设置要能恢复\n');
  A.child.kill();
  await sleep(600);
  const A2 = startServer(P_A);
  ok('A 重启起来了', await waitUp(A2));
  await sleep(200);
  /* 把「广播包丢了」和「UDP 端口压根没起来」分开 —— 后者是僵尸进程占着端口，
     重发多少次都没用，会让后面的断言红得莫名其妙。 */
  ok('A 的 UDP 发现端口起来了（没被上一个进程占着）',
    !/UDP 发现起不来/.test(A2.log()), (A2.log().match(/UDP[^\n]*/) || [''])[0]);
  const c3 = await discover(P_A.disc, '255.255.255.255');
  const card3 = c3[0] || {};
  ok('★ 重启后名称从存档恢复', card3.name === '落盘测试房', JSON.stringify(card3.name));
  /* V16.1 起房间码**不再从存档恢复**（重启回默认码，见 §⑪）。这台服务端起时传了
     RR_ROOM_CODE='' ⇒ 重启后应该是「无码」。 */
  ok('★ 重启后房间码不沿用旧值（改为回默认，这台被设成无码）', card3.needCode === false,
    String(card3.needCode));
  ok('重启后编号不变（还是那台设备）', card3.id === idA, card3.id + ' vs ' + idA);

  /* ---------- 10. 整条链路：扫到地址 → 拿去连上 ----------
     这是整套方案的价值所在。前面都在验「卡片对不对」，
     这里验「真的能用这张卡片连进去」—— 扫描 → 连接 → 进房。 */
  console.log('\n\u2469 扫到的地址真的能连上（扫描 → 连接整条链路）\n');
  A2.child.kill();
  await sleep(500);
  try { require('fs').unlinkSync(STATE + '-' + P_A.http + '.json'); } catch (e) {}
  const A3 = startServer(P_A);
  ok('新服务端起来了（空存档）', await waitUp(A3));
  await sleep(200);
  ok('新服务端的 UDP 发现端口起来了', !/UDP 发现起不来/.test(A3.log()),
    (A3.log().match(/UDP[^\n]*/) || [''])[0]);
  const c4 = await discover(P_A.disc, '255.255.255.255');
  const card4 = c4[0] || {};
  ok('广播后拿到卡片', c4.length === 1, '实际 ' + c4.length);
  let joined = false, why = '';
  try {
    const D = await openWs(card4.port, card4.host);
    D.send({ type: 'join', name: '扫进来的' });
    const wD = await D.waitFor(() => D.last('welcome'), 3000);
    joined = !!wD;
    why = JSON.stringify(D.last('rejected'));
    D.close();
  } catch (e) { why = e.message; }
  ok('★ 用「广播扫到的地址」真的连上并进了房', joined, why);

  A3.child.kill();
  try { require('fs').unlinkSync(STATE + '-' + P_A.http + '.json'); } catch (e) {}
  await sleep(400);

  /* ---------- 11. 默认房间码（V16.1，赐红定）----------
     开房就带 584520；房主能改；**重启回到默认**（不记住改过的那个）。 */
  console.log('\n\u246A 默认房间码 584520 / 可改 / 重启重置\n');
  const D1 = startServer(P_D, null, { defaultCode: true });
  ok('开了默认码的服务端起来了', await waitUp(D1));
  await sleep(200);
  const cD = await discover(P_D.disc, '255.255.255.255');
  const cardD = cD[0] || {};
  ok('★ 默认就带房间码（卡片 needCode=true，App 会弹输入框）', cardD.needCode === true,
    String(cardD.needCode));
  ok('★ 卡片里仍然不含房间码本身', !JSON.stringify(cardD).includes('584520'),
    JSON.stringify(cardD).slice(0, 120));

  const Dd = await openWs(P_D.http);
  Dd.send({ type: 'join', name: '不带码的' });
  const rjD = await Dd.waitFor(() => Dd.last('rejected') && Dd.last('rejected').reason === 'bad-room-code', 2500);
  ok('★ 不带码进不去（默认码真的生效，不是摆设）', !!rjD, JSON.stringify(Dd.last('rejected')));
  Dd.close();

  const Dd2 = await openWs(P_D.http);
  Dd2.send({ type: 'join', name: '带默认码的', pass: '584520' });
  const wD2 = await Dd2.waitFor(() => Dd2.last('welcome'), 3000);
  ok('★ 带 584520 就能进', !!wD2, JSON.stringify(Dd2.last('rejected')));

  /* 房主改成别的码 */
  Dd2.send({ type: 'config', code: '13579' });
  const cfgD = await Dd2.waitFor(() => {
    const v = Dd2.view();
    return v && v.room && v.room.code === '13579' ? v : null;
  }, 3000);
  ok('房主可以把默认码改成别的', !!cfgD, cfgD ? JSON.stringify(cfgD.room.code) : '');
  Dd2.close();
  await sleep(400);

  /* 🔴 重启 → 回到 584520（不复用改过的 13579，也不因为存档里有码就恢复） */
  D1.child.kill();
  await sleep(600);
  const D2 = startServer(P_D, null, { defaultCode: true });
  ok('带默认码的服务端重启起来了', await waitUp(D2));
  await sleep(200);
  const cD2 = await discover(P_D.disc, '255.255.255.255');
  ok('★ 重启后仍是「要房间码」状态', (cD2[0] || {}).needCode === true, String((cD2[0] || {}).needCode));

  const Dd3 = await openWs(P_D.http);
  Dd3.send({ type: 'join', name: '拿旧码来的', pass: '13579' });
  const rjD3 = await Dd3.waitFor(() => Dd3.last('rejected') && Dd3.last('rejected').reason === 'bad-room-code', 2500);
  ok('★ 重启后改过的旧码 13579 失效（不记住改过的）', !!rjD3, JSON.stringify(Dd3.last('rejected')));
  Dd3.close();

  const Dd4 = await openWs(P_D.http);
  Dd4.send({ type: 'join', name: '拿默认码来的', pass: '584520' });
  const wD4 = await Dd4.waitFor(() => Dd4.last('welcome'), 3000);
  ok('★ 重启后 584520 又能进了（回到默认）', !!wD4, JSON.stringify(Dd4.last('rejected')));
  Dd4.close();

  D2.child.kill(); B.child.kill(); C.child.kill();
  try { require('fs').unlinkSync(STATE + '-' + P_B.http + '.json'); } catch (e) {}
  try { require('fs').unlinkSync(STATE + '-' + P_C.http + '.json'); } catch (e) {}
  try { require('fs').unlinkSync(STATE + '-' + P_D.http + '.json'); } catch (e) {}

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n\u2717 测试中断：' + (e && e.stack ? e.stack : e));
  console.log('\n=== 结果：' + pass + ' 通过 / ' + (fail + 1) + ' 失败 ===\n');
  process.exit(1);
});
