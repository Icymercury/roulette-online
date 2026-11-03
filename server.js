/* ============================================================
 * 生死转盘 · 联机服务器 v6
 * ------------------------------------------------------------
 *   node server.js [端口] [房间码]
 *
 * 相比 v5 的变化（让手机「一个地址都不用输」）：
 *   · UDP 发现：客户端广播 {RRSP:1,q:"who"} 到 :8099，本服务端单播回一张小卡片
 *     （编号 / 名称 / 人数 / 状态 / 要不要房间码）；本服务端每 3 秒也主动广播一次。
 *     ⇒ 手机 App 打开就列出局域网里的服务器，点一下就能连。
 *     设 RR_NO_DISCOVERY=1 关掉；RR_DISCOVERY_PORT 改端口。
 *   · 服务器编号：由设备自己算（主机名 + 物理网卡 MAC → `K7Q2-M4`），重启不变。
 *     ⚠ 编号只是「名字」不是「地址」，不能拿来直接连 —— 它是列表上的一个显示字段。
 *   · 服务器名称：房主可在大厅里改（默认「<主机名> 的房间」），落盘。
 *   · 房间码：房主可在大厅里改/清空（默认无）。改掉只影响**新加入**的人。
 *
 * 相比 v3 的变化：
 *   · 观战：房间成员分两种 —— 有座位的「玩家」和没座位的「观战者」。
 *     观战者能看全场，不能转动、不能买东西，随时可以退出观战离开房间。
 *   · 退出本局：对局中任何玩家都能主动退出 —— 人离开这一局，席位留在房间里
 *     （id / 名字 / 重连凭证都保留），转为观战者。回大厅时自动回到名单。
 *     ⚠ 退出本局后这一局就真的没了：2 人局里走一个，剩下的当场胜出。
 *   · 房主自动迁移：房主掉线（或退出房间）时，房主自动转给「在线且编号最小」的
 *     房间成员，并广播一条日志。原房主回来不会自动拿回房主 —— 避免来回打架。
 *     这是 v3 封存机制的必要补丁：v3 里房主掉线就没人能「放弃本局」，全房间死锁。
 *   · 对局中进房的新人可以选「观战」，不必再被硬拒（game-in-progress）。
 *
 * v3 已有：
 *   · 重连凭证 / 掉线封存 / 落盘 / 静态白名单 / 45 秒看门狗 / 60 条每秒限流
 *
 * 规则全部交给 engine.js —— 本文件不含任何游戏数值。
 * 仍然零依赖（Node 内置模块 + engine.js），监听 0.0.0.0。
 * ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
/* 打包版会把引擎内联成 EMBEDDED_ENGINE（见下方说明），源码版才 require 文件 */
const Engine = (typeof EMBEDDED_ENGINE !== 'undefined') ? EMBEDDED_ENGINE : require('./engine.js');

const PORT = Number(process.argv[2]) || 8080;
/* 命令行第 3 个参数 = 房间码（V18.2 起它**只**管房间码；
   管理端口挪到了 argv[4] / RR_ADMIN_PORT，见下方 ADMIN_PORT 处的说明） */
const ROOM_CODE = process.argv[3] || null;

/* ------------------------------------------------------------
 * 默认房间码（V16.1，赐红定）
 * ------------------------------------------------------------
 * 开房就带一个码（584520），房主随时能在管理台改；
 * 🔴 但**重启服务端一律回到这个默认码** —— 不记住上一次改的那个。
 *   理由：赐红记不住临时设的码，重启后对着旧码干瞪眼不如回到一个已知值。
 *
 * 优先级：命令行 argv[3] > 环境变量 RR_ROOM_CODE > 内置默认 584520。
 * 🔴 测试要「无码直接进房」的，给测试服务端传 RR_ROOM_CODE=''（空串 = 无房间码）。 */
const DEFAULT_ROOM_CODE = '584520';
function initialCode() {
  if (ROOM_CODE) return ROOM_CODE;
  if (process.env.RR_ROOM_CODE !== undefined) return process.env.RR_ROOM_CODE || null;
  return DEFAULT_ROOM_CODE;
}

/* ------------------------------------------------------------
 * UDP 发现（让手机 App「一个字符都不用输地址」）
 * ------------------------------------------------------------
 * 端口固定是刻意的：客户端要在「还不知道服务器在哪」的前提下找到它。
 * 流程：
 *   客户端 → 广播 {RRSP:1, q:"who"} 到 255.255.255.255:8099
 *   服务端 → 单播回一张小卡片（编号 / 名称 / 人数 / 状态 / 要不要房间码）
 * 另外服务端每 3 秒主动广播一次同一张卡片 —— 两个方向互为备份：
 * 客户端的广播进不来（防火墙），靠收服务端的心跳也能看见本机。
 *
 * ⚠️ 浏览器 / WebView 里的 JS **发不了 UDP**（安全沙箱不允许）。
 *    所以「扫描服务器」必须由原生层做：安卓壳用 Java、PC 客户端用 Node，
 *    扫到结果再喂给页面。网页方式打开时没有扫描能力，只能手输地址。
 * ------------------------------------------------------------ */
const DISCOVERY_PORT = Number(process.env.RR_DISCOVERY_PORT) || 8099;
const DISCOVERY_BEACON_MS = 3000;

/* ------------------------------------------------------------
 * 打包（单文件 exe）说明
 * ------------------------------------------------------------
 * build/build-pc.js 会把 engine.js 与所有静态资源内联成两个常量
 *   EMBEDDED_ENGINE / EMBEDDED_ASSETS
 * 然后原样拼在本文件前面。下面两行用 typeof 探测：
 *   · node server.js 直接跑 → 两个常量都不存在 → 走磁盘，行为完全不变
 *   · 打包后的 exe          → 常量存在 → 走内嵌资源，exe 旁边啥都不用放
 * 这样同一份源码既能开发又能打包，不需要任何字符串替换式的补丁。
 * ------------------------------------------------------------ */
const BUNDLE = (typeof EMBEDDED_ASSETS !== 'undefined') ? EMBEDDED_ASSETS : null;

/* 打包成 exe 后 __dirname 不是 exe 所在目录，存档得跟着 exe 走 */
const ROOT = BUNDLE ? path.dirname(process.execPath) : __dirname;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/* 状态封存文件 —— 与 token 一起落盘，所以绝不能出现在静态白名单里。
   测试可以设 RR_STATE 指到别处，避免覆盖真实存档。 */
const STATE_FILE = process.env.RR_STATE
  ? path.resolve(process.env.RR_STATE)
  : path.join(ROOT, 'state.json');
const STATE_TTL_MS = 12 * 60 * 60 * 1000;    // 超过 12 小时的旧存档不再自动恢复

/* 房主改过的规则（V16）。单独一个文件，跟对局存档分开 ——
   换规则不该动存档，清存档也不该把规则弄丢。
   🔴 它**不进静态白名单**（白名单只发页面和素材），但服务端会主动把它
   通过 WebSocket / /rules.json 发给客户端 —— 那是给玩家看的，不含任何隐私。 */
const RULES_FILE = process.env.RR_RULES
  ? path.resolve(process.env.RR_RULES)
  : path.join(ROOT, 'rules.json');
let rulesOverride = null;      // null = 用引擎内置默认值

/* 客户端操作日志（V18.2）：玩家在页面上点「发给房主」送来的日志落在这里。
   跟存档同目录（测试用 RR_STATE 指到别处时它也跟着走，不会污染真实数据）。
   🔴 文件名一律服务端自己生成（时间戳），**绝不用玩家传来的名字当文件名**
      —— 否则玩家能靠名字里的 ../ 把文件写到任何地方。名字只写进文件正文。 */
const CLIENTLOG_DIR = process.env.RR_CLIENTLOG_DIR
  ? path.resolve(process.env.RR_CLIENTLOG_DIR)
  : path.join(path.dirname(STATE_FILE), 'clientlogs');
const CLIENTLOG_MAX = 30;             // 只留最近 30 份，多了把最老的删掉
const CLIENTLOG_BODY_MAX = 262144;    // 单份最多 256 KB
const CLIENTLOG_NAME_RE = /^\d{8}-\d{6}\.txt$/;   // 文件名只许长这样

function pruneClientLogs() {
  try {
    const files = fs.readdirSync(CLIENTLOG_DIR).filter(f => CLIENTLOG_NAME_RE.test(f)).sort();
    for (let i = 0; i < files.length - CLIENTLOG_MAX; i++) {
      try { fs.unlinkSync(path.join(CLIENTLOG_DIR, files[i])); } catch (e) {}
    }
  } catch (e) {}
}
function saveClientLog(msg) {
  try {
    const text = String((msg && msg.text) || '').slice(0, 200000);
    if (!text.trim()) return { ok: false, err: '日志是空的' };
    /* 名字只用于显示在文件里：去掉路径分隔符和控制字符，再截断 */
    let nm = String((msg && msg.name) || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!nm) nm = '无名';
    fs.mkdirSync(CLIENTLOG_DIR, { recursive: true });
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const file = path.join(CLIENTLOG_DIR,
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
      + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.txt');
    fs.writeFileSync(file, '# 玩家 ' + nm + '   上报于 ' + d.toLocaleString() + '\n' + text, 'utf8');
    pruneClientLogs();
    log('📥 收到一份操作日志：' + nm + '（' + text.length + ' 字）');
    return { ok: true, file: path.basename(file), name: nm };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  }
}
function listClientLogs() {
  try {
    return fs.readdirSync(CLIENTLOG_DIR)
      .filter(f => CLIENTLOG_NAME_RE.test(f))
      .sort().reverse()
      .slice(0, CLIENTLOG_MAX)
      .map(f => {
        const st = fs.statSync(path.join(CLIENTLOG_DIR, f));
        /* 只抠开头 200 字节拿玩家名 —— 列表是每几秒刷一次的，别整份读进来 */
        let nm = '—';
        try {
          const fd = fs.openSync(path.join(CLIENTLOG_DIR, f), 'r');
          try {
            const buf = Buffer.alloc(200);
            const got = fs.readSync(fd, buf, 0, 200, 0);
            const first = buf.slice(0, got).toString('utf8').split('\n')[0] || '';
            nm = (first.replace(/^#\s*玩家\s*/, '').split('   ')[0] || '—').trim() || '—';
          } finally { try { fs.closeSync(fd); } catch (e) {} }
        } catch (e) {}
        return { file: f, name: nm, size: st.size, mtime: st.mtimeMs };
      });
  } catch (e) { return []; }
}

function applyRules(ov) {
  const prev = rulesOverride;
  const r = Engine.configure(ov || null);
  if (!ov) {
    rulesOverride = null;                 /* 显式传 null = 恢复默认 */
  } else if (r && r.ok) {
    rulesOverride = ov;
  } else {
    /* 不合法：保持**上一套**合法规则，别把已经设好的清空。
       configure 失败时引擎已经还原成默认了，所以要把上一套重新灌回去，
       否则会出现「房间说自己在用自定义规则、引擎其实跑默认」的不一致。 */
    if (prev) Engine.configure(prev);
  }
  return r;
}
function loadRules() {
  try {
    if (!fs.existsSync(RULES_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    const ov = raw && raw.rules ? raw.rules : raw;
    const r = applyRules(ov);
    if (r && r.ok && rulesOverride) log('· 已载入房主改过的规则（rules.json）');
    else if (r && !r.ok) log('! rules.json 里有不合法的数值，已按默认规则启动：' + r.errors.join('；'));
  } catch (e) {
    log('! rules.json 读不出来，按默认规则启动：' + e.message);
  }
}
function saveRules() {
  try {
    const payload = { v: 1, savedAt: Date.now(), rules: rulesOverride };
    fs.writeFileSync(RULES_FILE, JSON.stringify(payload, null, 1), 'utf8');
  } catch (e) { log('! 规则存盘失败：' + e.message); }
}

/* ============================ 房间状态 ============================ */

/* 大厅里的「对局」只是个占位：phase 标成 lobby。
   否则 createMatch 的初始 phase 是 playing，客户端就看不出「在大厅」和「在局中」的区别。 */
function lobbyMatch(mode, seats) {
  const m = Engine.createMatch({ mode: mode, players: seats });
  m.phase = 'lobby';
  return m;
}

const room = {
  code: initialCode(),
  /* 服务器名称：房主可改（客户端大厅里有输入框），落盘。null = 用默认名 */
  name: process.env.RR_NAME || null,
  mode: 'race',
  phase: 'lobby',        // 'lobby' | 'playing'
  hostId: null,
  match: lobbyMatch('race', []),
  watchers: [],          // 观战者：房间成员，但没有本局座位
  version: 0,            // 每次状态变化 +1。纯调试/排查用 —— WebSocket 走 TCP 有序可靠，
                         // 且每条 sync 都带完整视图，所以客户端并不需要它来"发现丢包"。
};

let nextId = 1;
let nextWatch = 1;       // 只用来给观战者发key，纯显示用

/* 观战者上限：防的是有人开一堆标签页把房间撑爆 */
const MAX_WATCHERS = 20;

const clients = new Set();

function bump() { room.version += 1; return room.version; }

/* 权威随机源 —— 客户端拿不到这个，所以无法预知结果 */
function secureRng() {
  return crypto.randomBytes(4).readUInt32BE(0) / 4294967296;
}

function newToken() { return crypto.randomBytes(16).toString('hex'); }

/* 当前座位的「身份证」列表。重建对局时必须原样带上 token 和在线状态，
   否则一换模式/一回大厅，所有人就都回不来了。 */
function seatList() {
  return room.match.order
    .filter(id => room.match.players[id])
    .map(id => {
      const p = room.match.players[id];
      return { id: id, name: p.name, token: p.token, connected: p.connected };
    });
}

/* 观战者：id / token 与座位共用同一套。（退出本局的人就是把原 id 原 token 带过来的，
   这样房主身份、重连凭证、下一局回名单全都不用特殊处理。） */
function newWatcher(id, name, token) {
  const w = {
    key: 'w' + (nextWatch++),
    id: String(id),
    name: String(name || ('观战者' + id)).slice(0, 12),
    token: token || newToken(),
    connected: true,
  };
  room.watchers.push(w);
  return w;
}

function watcherById(id) {
  if (id == null) return null;
  return room.watchers.find(w => w.id === String(id)) || null;
}

/* 按 token 找人 —— 无论是座位上的人还是观战的人。
   这是唯一的「我是谁」判定依据：光知道编号顶不了号。 */
function memberByToken(token) {
  if (!token || typeof token !== 'string') return null;
  const ids = Object.keys(room.match.players);
  for (let i = 0; i < ids.length; i++) {
    const p = room.match.players[ids[i]];
    if (p.token && p.token === token) return { kind: 'player', id: p.id, name: p.name, ref: p };
  }
  for (let i = 0; i < room.watchers.length; i++) {
    const w = room.watchers[i];
    if (w.token && w.token === token) return { kind: 'watcher', id: w.id, name: w.name, ref: w };
  }
  return null;
}

/* 房间成员在不在线（座位或观战席都算）—— 房主迁移用它判断 */
function memberOnline(id) {
  if (id == null) return false;
  const p = room.match.players[id];
  if (p && p.connected) return true;
  const w = watcherById(id);
  return !!(w && w.connected);
}

function offlineIds() {
  return room.match.order.filter(id => room.match.players[id] && !room.match.players[id].connected);
}

function nameOf(id) {
  const p = room.match.players[id];
  if (p) return p.name;
  const w = watcherById(id);
  return w ? w.name : id;
}

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] ${msg}`);
}

/* 🔴 V18：把这条连接占着的身份收干净 —— 座位也好，观战席也好。
   为什么必须有这一步：一条连接可以在「还开着」的时候再发一次 join
   （典型路径：对局中进房 → 弹窗点「进来观战」，前端没有断开旧连接）。
   服务器如果不回收旧身份，那个人的座位就留在名单里没人认领 ——
   界面上他好好地「在场上」，实际既转不了盘，也退不出本局（服务端只认新身份）。
   返回被清掉的座位信息，交给调用方决定要不要接着当观战者。 */
function releaseIdentity(client) {
  let evs = [];
  const pid = client.id;

  if (client.role === 'player' && pid && room.match.players[pid]) {
    if (room.phase === 'playing') {
      /* 局中：走一遍 leaveMatch —— 它会重判「只剩一人即结束」，不会白送别人一个回合，
         顺带把他的存活时间收尾。局面必须自洽。 */
      const out = Engine.leaveMatch(room.match, pid, Date.now());
      room.match = out.match;
      evs = out.events || [];
    }
    /* 大厅里没有真对局，直接抹座位即可 */
    delete room.match.players[pid];
    const i = room.match.order.indexOf(pid);
    if (i >= 0) room.match.order.splice(i, 1);
  }
  if (client.role === 'watcher') room.watchers = room.watchers.filter(w => w.id !== pid);
  client.role = null;
  client.id = null;
  return evs;
}

/* 同一座位不允许两条连接同时认领 —— 否则先关掉的那条会把座位判成掉线，
   触发没必要的封存；手感上是「我明明在线，全场却卡住等我了」。
   做法是：新认领者到货，就把那条旧连接请出去。 */
function evictTwins(pid, keep) {
  if (pid == null) return;
  [...clients].forEach(c => {
    if (c !== keep && c.id === pid && (c.role === 'player' || c.role === 'watcher')) {
      c.role = null; c.id = null;
      try { c.socket.end(); } catch (e) {}
    }
  });
}

/* ============================ 房主 ============================ */

/* 房主掉线 / 退出房间 → 立刻转给「在线且编号最小」的房间成员。
   这是掉线封存机制的必要补丁：没有它，房主一掉线就没人能「放弃本局」，全房间死锁。
   原房主回来不自动回任 —— 单纯为了不来回打架。 */
function ensureHost(actorId) {
  if (memberOnline(room.hostId)) return false;

  const from = room.hostId;
  let pick = null;
  /* 先在座位里挑（真正在打的人优先管事），再退而求其次找观战者 */
  const cand = room.match.order
    .filter(id => room.match.players[id] && room.match.players[id].connected)
    .concat(room.watchers.filter(w => w.connected).map(w => w.id))
    .filter(id => id != null)
    .sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
  if (cand.length) pick = cand[0];

  if (pick === from) return false;
  room.hostId = pick;
  bump();
  log(pick
    ? `★ 房主迁移：${from ? nameOf(from) : '（无）'} → ${nameOf(pick)}`
    : `★ 房主迁移：房间空了，房主位暂时悬空`);
  return true;
}

/* ============================ 身份 ============================ */

/* 服务器编号：**由设备自己决定** —— 主机名 + 一块物理网卡 MAC 做哈希，
   取 6 位 base32（去掉 0/O/1/I 这些容易看错的字符），形如 `K7Q2-M4`。
   同一台机器重启不变；换机器才变。不用手输、不用注册。

   ⚠️ 它只是「名字」，不是「地址」。客户端拿到 `K7Q2-M4` 没有任何办法推出
      `10.113.132.95:8080` —— 中间必须有「查号台」。所以我们走的是：
       · 同网段：UDP 广播发现（编号只是卡片上的一个显示字段）
       · 异地：手输一次地址（Tailscale 等）
     编号的用处是「认人」：一眼看出还是昨天那台服务器。 */
const B32 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
let _sid = null;
function serverId() {
  if (_sid) return _sid;
  const PHYS = /wlan|wi-?fi|wireless|以太网|ethernet|^en\d|^eth\d|wlp/i;
  let mac = '';
  try {
    const ifs = os.networkInterfaces();
    const names = Object.keys(ifs).sort();     // 排序保证结果稳定
    /* 优先物理网卡；退而求其次用排序后的第一块非零 MAC */
    for (const wantPhys of [true, false]) {
      for (const n of names) {
        if (PHYS.test(n) !== wantPhys) continue;
        for (const a of (ifs[n] || [])) {
          if (a.mac && a.mac !== '00:00:00:00:00:00') { mac = a.mac; break; }
        }
        if (mac) break;
      }
      if (mac) break;
    }
  } catch (e) { /* 拿不到 MAC 就只用主机名 */ }
  const h = crypto.createHash('sha1').update(os.hostname() + '|' + mac, 'utf8').digest();
  let s = '';
  for (let i = 0; i < 6; i++) s += B32[h[i] % B32.length];
  _sid = s.slice(0, 3) + '-' + s.slice(3);
  return _sid;
}

/* 服务器名称：房主可改；没设就用「<主机名> 的房间」 */
function serverName() {
  if (room.name) return room.name;
  let hn = '本机';
  try { hn = String(os.hostname() || '本机').slice(0, 16); } catch (e) {}
  return hn + ' 的房间';
}

/* ============================ UDP 发现 ============================ */

/* 给「还不知道服务器在哪」的客户端看的一张小卡片：
   够它把服务器显示出来，并判断要不要弹房间码输入框。
   注意**不含房间码本身** —— 只告诉「要不要」。 */
function discoveryCard() {
  return {
    RRSP: 1,
    id: serverId(),
    name: serverName(),
    port: PORT,
    players: Object.keys(room.match.players).length,
    watchers: room.watchers.length,
    phase: room.phase,                    // lobby | playing
    mode: room.mode,
    modeLabel: Engine.modeLabel(room.mode),
    needCode: !!room.code,
  };
}

let discoverySock = null;
function startDiscovery() {
  if (process.env.RR_NO_DISCOVERY) return null;
  /* reuseAddr：同一台机器可以同时跑多个服务端（测试就这么干），各回各的卡片 */
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let bound = false;

  sock.on('error', e => {
    console.log('  ! UDP 发现起不来（' + (e && e.code ? e.code : e) + '）——');
    console.log('    手机 App 可能搜不到本机。不影响联机：在 App 里点「异地加入」手输地址一样能玩。');
    try { sock.close(); } catch (e2) {}
  });

  sock.on('message', (buf, rinfo) => {
    let msg = null;
    try { msg = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
    if (!msg || msg.RRSP !== 1 || msg.q !== 'who') return;   // 心跳卡片会回到自己这儿，直接忽略
    const card = Buffer.from(JSON.stringify(discoveryCard()), 'utf8');
    sock.send(card, 0, card.length, rinfo.port, rinfo.address, () => {});
  });

  sock.bind(DISCOVERY_PORT, '0.0.0.0', () => {
    bound = true;
    try { sock.setBroadcast(true); } catch (e) {}
  });

  /* 主动心跳：就算客户端的 DISCOVER 进不来（防火墙拦了入站广播），
     只要客户端能收广播就能看见本机。 */
  const beat = setInterval(() => {
    if (!bound) return;
    const card = Buffer.from(JSON.stringify(discoveryCard()), 'utf8');
    try { sock.send(card, 0, card.length, DISCOVERY_PORT, '255.255.255.255', () => {}); } catch (e) {}
  }, DISCOVERY_BEACON_MS);
  if (beat.unref) beat.unref();      // 别因为心跳让进程退不掉

  discoverySock = sock;
  return sock;
}

/* ============================ 落盘 ============================ */

let saveTimer = null;

function writeStateNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const payload = {
    v: 3,
    savedAt: Date.now(),
    mode: room.mode,
    phase: room.phase,
    hostId: room.hostId,
    nextId: nextId,
    name: room.name,          // 房主改过的服务器名称
    code: room.code,          // 房主改过的房间码（**重启不恢复**，见 loadState 注释）
    tunnelBin: tunnelBinPath, // 房主选过的 cpolar.exe 位置（这个要记住，别再选第二遍）
    match: room.match,
  };
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, STATE_FILE);          // 原子替换，避免写一半崩掉
  } catch (e) {
    log('! 存档失败：' + e.message);
  }
}

/* 普通动作合并写盘（250ms 一次），关键转折立即写 */
function saveState(immediate) {
  if (immediate) { writeStateNow(); return; }
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeStateNow(); }, 250);
}

function loadState() {
  let raw;
  try {
    if (!fs.existsSync(STATE_FILE)) return false;
    raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    log('! 存档读不出来，按全新房间启动：' + e.message);
    return false;
  }
  if (!raw || raw.v !== 3 || !raw.match) return false;

  const age = Date.now() - (raw.savedAt || 0);
  if (age > STATE_TTL_MS) {
    log(`· 发现 ${Math.round(age / 3600000)} 小时前的旧存档，已忽略（不自动恢复）`);
    return false;
  }

  /* 恢复时没有任何人在线：全员标掉线，让封存逻辑接管 */
  const m = raw.match;
  m.order.forEach(id => { if (m.players[id]) m.players[id].connected = false; });
  if (raw.phase === 'playing' && !m.frozen) {
    m.frozen = true;
    m.frozenSince = Date.now();
  }

  room.mode = raw.mode || room.mode;
  room.phase = raw.phase === 'playing' ? 'playing' : 'lobby';
  room.hostId = raw.hostId || null;
  /* 服务器名称从存档恢复；🔴 **房间码不恢复** —— 重启一律回到默认码（V16.1，赐红定）。
     存档里那个旧码就此作废，免得房主拿旧码去问"怎么进不去"。 */
  if (typeof raw.name === 'string') room.name = raw.name || null;
  room.code = initialCode();
  /* cpolar 的位置要记住（选一次就够了）；没配过就等自动探测 */
  if (!tunnelBinPath && typeof raw.tunnelBin === 'string' && raw.tunnelBin) tunnelBinPath = raw.tunnelBin;
  room.match = m;
  /* 观战者也一起恢复（掉线状态，等他们自己回来） */
  room.watchers = Array.isArray(raw.watchers) ? raw.watchers.map(w => ({
    key: w.key || ('w' + (nextWatch++)),
    id: String(w.id),
    name: String(w.name || w.id).slice(0, 12),
    token: w.token,
    connected: false,
  })) : [];
  nextId = raw.nextId || (Math.max(0, ...Object.keys(m.players).map(Number)) + 1);
  nextWatch = Math.max(nextWatch, Number(raw.nextWatch) || 0,
    room.watchers.reduce((M, w) => Math.max(M, parseInt(String(w.key).slice(1), 10) || 0), 0) + 1);
  bump();

  const mins = Math.round(age / 60000);
  log(`· 已恢复上次的对局（${Engine.modeLabel(room.mode)} · ${room.phase === 'playing' ? '进行中已封存' : '大厅'} · 存于 ${mins} 分钟前）`);
  log('  拿原设备原浏览器打开即可回到自己的座位；房主也可在大厅重开一局');
  return true;
}

/* ============================ 封存逻辑 ============================ */

/* 掉线 → 封存；全员回来 → 解封。这两个事件必须广播给所有人。 */
function syncFreeze(actorId) {
  if (room.phase !== 'playing' || room.match.phase !== 'playing') return;

  const off = offlineIds();
  if (off.length && !room.match.frozen) {
    room.match = Engine.pauseMatch(room.match, Date.now());
    bump();
    log(`❄ 封存对局 · 等待 ${off.map(nameOf).join('、')} 重连`);
    broadcast({ type: 'sync', view: snapshot(), events: [{ t: 'freeze', offline: off }], actor: actorId || null });
    saveState(true);
    return;
  }
  if (!off.length && room.match.frozen) {
    const paused = room.match.pausedMs || 0;
    room.match = Engine.resumeMatch(room.match, Date.now());
    bump();
    log(`☀ 解封对局 · 全员在线，继续（刚才封存了 ${Math.round(paused / 1000)} 秒）`);
    broadcast({ type: 'sync', view: snapshot(), events: [{ t: 'thaw', pausedMs: paused }], actor: actorId || null });
    saveState(true);
  }
}

/* ============================ 视图快照 ============================ */

function snapshot() {
  return {
    /* 时间以服务端为准：客户端拿它算出场计时与存活时间 */
    serverNow: Date.now(),
    /* 服务端只提供多人模式；死亡轮盘在客户端本地跑 */
    modes: Engine.MODES
      .filter(function (m) { return m !== 'solo'; })
      .map(function (m) { return { id: m, label: Engine.modeLabel(m) }; }),
    room: {
      needCode: !!room.code,
      /* 房间码：已经进了房间的人本来就该知道（房主要在大厅里看到它才能改） */
      code: room.code || null,
      name: serverName(),
      serverId: serverId(),
      mode: room.mode,
      modeLabel: Engine.modeLabel(room.mode),
      phase: room.phase,
      hostId: room.hostId,
      version: room.version,
    },
    /* 观战者名单：客户端用来在房间里显示「👁 观战」一栏 */
    watchers: room.watchers.map(w => ({ key: w.key, id: w.id, name: w.name, connected: w.connected })),
    match: Engine.publicView(room.match),
    /* V16：房主改过的规则。null = 用引擎内置的默认规则。
       客户端拿它显示商城价格 / 血上限 / 概率，跟服务端保持一致。 */
    rules: rulesOverride,
  };
}

/* 房间成员（玩家 + 观战者）—— 广播、房主判定都看这个 */
function inRoom(client) { return client.role === 'player' || client.role === 'watcher'; }

/* ============================ HTTP 静态服务 ============================ */

/* 白名单：只发游戏自己的文件。
   页面/脚本按「精确文件名」放行，素材按扩展名放行。
   于是 server.js、测试脚本、state.json、备忘、隐藏目录 —— 一律取不到。
   （新增游戏文件时，记得往 SERVE_EXACT 里补名字。） */
const SERVE_EXACT = [
  'client.html', 'roulette-wheel.html', 'online-test.html', 'engine.js',
  /* V16 启动页：打开后先选「单人 / 联机」，单人模式压根不连服务端 */
  'start.html',
  /* 手机端「添加到主屏幕」用的外壳：没有它们，手机就只能当网页用 */
  'manifest.json', 'sw.js',
  /* 🔴 admin.html（房主管理台）**故意不在这里** —— 它只走 127.0.0.1 的管理端口。
     于是即便开着内网穿透，/admin.html 在公网上也是 404（双保险）。 */
];
const SERVE_ASSET_EXT = [
  '.css',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.mp3', '.ogg', '.wav', '.woff2', '.ttf',
];

/* 把 URL 映射成「白名单里的相对文件名」，取不到就返回 null。
   返回相对名（而不是绝对路径）是为了打包版能直接从内嵌资源表里查。 */
function resolveStatic(urlPath) {
  /* V16：根路径改成启动页 —— 打开先选「单人 / 联机」。
     ⚠ 改这一行会连锁到 verify-live.js / pc-client.js / 打包脚本，它们原本
     都假设「打开 / 就是游戏页」，已全部改成显式打开 /client.html。 */
  if (urlPath === '/') urlPath = '/start.html';
  if (urlPath.length > 200) return null;

  const rel = urlPath.replace(/^\/+/, '');
  if (!rel) return null;
  /* 任何以点开头的路径段（.workbuddy、.git、..）一律拒绝 */
  if (rel.split('/').some(seg => seg === '' || seg.startsWith('.'))) return null;

  const ext = path.extname(rel).toLowerCase();
  const allowed = SERVE_EXACT.indexOf(rel) >= 0 || SERVE_ASSET_EXT.indexOf(ext) >= 0;
  if (!allowed) return null;

  /* 再兜一层：解析后必须还在项目目录里 */
  const abs = path.resolve(ROOT, rel);
  const inside = path.relative(ROOT, abs);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return rel;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

/* 发文件：打包版读内嵌表（base64），源码版读磁盘 */
function sendAsset(rel, res) {
  const head = {
    'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  };

  if (BUNDLE) {
    const data = BUNDLE['/' + rel];
    if (data == null) { res.writeHead(404); res.end('404 not found: ' + rel); return; }
    head['Content-Length'] = Buffer.byteLength(data, 'base64');
    res.writeHead(200, head);
    res.end(Buffer.from(data, 'base64'));
    return;
  }

  fs.readFile(path.resolve(ROOT, rel), (err, buf) => {
    if (err) { res.writeHead(404); res.end('404 not found: ' + rel); return; }
    res.writeHead(200, head);
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { res.writeHead(400); res.end('bad request'); return; }

  /* V16：规则快照 —— 单人模式（在客户端本地跑）要拉到跟房主一样的规则。
     允许跨域：手机 App 里页面是 file://，那种来源的 Origin 是 null，
     不带这个头它根本读不到。规则里没有任何隐私（就是概率和价格）。 */
  if (urlPath === '/rules.json') {
    const body = JSON.stringify({ ok: true, custom: !!rulesOverride, rules: rulesOverride });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
    return;
  }

  /* V18.2：玩家上报操作日志（排查 bug 用）。
     它开在游戏端口上，所以走穿透进来的外地朋友也能发；但**看**只能在管理台
     （那个端口只 bind 127.0.0.1）⇒ 别人发得进来、看不到别人的。
     🔴 大小封顶、文件名自己生成、JSON 解析失败直接拒，写盘失败也不影响对局。 */
  if (urlPath === '/clientlog' && req.method === 'POST') {
    const jsonGame = (code, obj) => {
      const b = JSON.stringify(obj);
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*',
      });
      res.end(b);
    };
    let body = '', dead = false;
    req.on('data', d => {
      body += d.toString();
      if (body.length > CLIENTLOG_BODY_MAX) { dead = true; req.destroy(); }
    });
    req.on('end', () => {
      if (dead) { jsonGame(413, { ok: false, err: '日志太大了' }); return; }
      let msg = null;
      try { msg = JSON.parse(body || '{}'); }
      catch (e) { jsonGame(400, { ok: false, err: '不是合法 JSON' }); return; }
      jsonGame(200, saveClientLog(msg));
    });
    return;
  }

  const rel = resolveStatic(urlPath);
  if (!rel) { res.writeHead(404); res.end('404 not found'); return; }
  sendAsset(rel, res);
});

/* ===================== 房主管理台（V16） =====================
 * 一个只给「开着服务端的这台电脑」用的后台：显示穿透网址、改房间码 / 名称。
 *
 * 🔴 为什么它必须开在**独立端口且只监听 127.0.0.1**：
 *    赐红的要求是「管理台不让异地访问」。最简单的想法是判断来源 IP 是不是
 *    127.0.0.1 —— **这条路不通**：走内网穿透进来的请求，服务端看到的源地址
 *    同样是本机的 cpolar 客户端（127.0.0.1），按 IP 根本分不出是自己人还是陌生人。
 *    判 Host 头也不行（HTTP 头可以伪造）。
 *    唯一物理上可靠的就是：单独一个端口 + 只 bind 回环地址。
 *    穿透只转发游戏端口，这个端口压根不在转发链路上 ⇒ 异地绝对连不进来。
 *    再叠一层：admin.html 不在静态白名单里，/admin.html 在公网上也是 404。
 *
 * 端口：RR_ADMIN_PORT > argv[4] > 游戏端口 + 1000。设 RR_NO_ADMIN=1 可关。
 *
 * 🔴 V18.2 修的坑：这里原来读的是 **argv[3]** —— 而 argv[3] 同时是房间码。
 *    两个功能抢一个参数 ⇒ `node server.js 8080 584520`（命令行带码开房）会让管理台去
 *    listen 584520，直接 ERR_SOCKET_BAD_PORT，**服务端根本起不来**；
 *    想给命令行房间码就只能绕道 RR_ROOM_CODE 环境变量。
 *    现在分工：argv[3] = 房间码，argv[4] / RR_ADMIN_PORT = 管理台端口（默认 PORT+1000）。
 */
/* 默认取 PORT + 1000 而不是 PORT + 1：
   测试/排障时常会同时起好几个服务端（8091、8092…），PORT+1 正好会撞上下一个
   实例的游戏端口，那一个就起不来了。大号段基本不会撞，真撞了下面还会自动往后找。 */
let ADMIN_PORT = Number(process.env.RR_ADMIN_PORT || process.argv[4]) || (PORT + 1000);
const STARTED_AT = Date.now();
let tunnelUrl = '';          /* 抓到的穿透网址（公网给朋友的那个） */
let tunnelCheckedAt = 0;

/* 抓 cpolar 的公网网址。
   🔴 cpolar 的结构化 API 两条都不给数据（/api/tunnels 返回空、
      /api/v1/tunnels 带 token 返回 500），只能从控制台页面里抠 —— 那是控制台
      自己的数据源，稳。端口按版本不同可能是 4042 / 4040 / 9200，都试一遍。
   🔴 只有服务端（Node 侧）能做这件事：管理页在 https 下去 fetch
      http://127.0.0.1:4042 会被浏览器按「混合内容」拦掉。 */
async function grabTunnelUrl() {
  for (const p of [4042, 4040, 9200]) {
    try {
      const r = await fetch('http://127.0.0.1:' + p + '/', { signal: AbortSignal.timeout(2000) });
      if (!r.ok) continue;
      const html = await r.text();
      const m = html.match(/\\?"PublicUrl\\?"\s*:\s*\\?"([^"\\]+)\\?"/);
      if (m && /^https?:\/\//.test(m[1])) return m[1];
    } catch (e) { /* 这个端口没服务，试下一个 */ }
  }
  return '';
}

async function pollTunnel() {
  const u = await grabTunnelUrl();
  tunnelCheckedAt = Date.now();
  if (u && u !== tunnelUrl) {
    tunnelUrl = u;
    log('🌍 检测到穿透隧道：' + u);
    log('   外地朋友用这个网址进 —— 管理台里可以直接复制。');
  } else if (!u && tunnelUrl) {
    tunnelUrl = '';
    log('· 穿透隧道不见了（cpolar 关了？）—— 外地朋友现在只能走组网。');
  }
  /* 我们拉起来的那个 cpolar 死了（被关 / 崩了），把状态清掉 */
  if (!u && tunnelProc && tunnelProc.exitCode !== null) {
    tunnelProc = null; tunnelStartedAt = 0;
    log('· 穿透进程已退出 —— 需要的话在管理台重新点「开穿透」。');
  }
}

/* ============================================================
 * 一键穿透（V16.1，赐红要的：记不住 cpolar 命令）
 * ------------------------------------------------------------
 * 管理台上点「开穿透」→ 服务端自己去拉起 cpolar 并把本机端口映射出去。
 *
 * 为什么不干脆做成一启动就自动开：
 *   · 把 8080 暴露到公网是**对外动作**，得由人点一下（朋友局按需开就行）
 *   · cpolar 装在哪儿只有这台机器知道 ⇒ 路径让房主选一次，落盘记住
 *
 * 🔴 cpolar 的 authtoken 必须在外部配过一次（`cpolar authtoken <token>`），
 *    没配进程会立刻退出并打印「启动时没有 authtoken」—— 这里要把它的输出读出来
 *    告诉房主，而不是只报一句「启动失败」。
 * ============================================================ */

const TUNNEL_BIN_KEY = 'tunnelBin';        /* 存在 state.json 里的字段名 */
let tunnelBinPath = process.env.RR_CPOLAR || '';   /* cpolar.exe 的绝对路径 */
let tunnelProc = null;
let tunnelStartedAt = 0;
let tunnelLastErr = '';

/* 常见安装位置 + PATH 里的 cpolar。房主也可以在管理台里手选一个 exe。 */
function findCpolar() {
  if (tunnelBinPath && fs.existsSync(tunnelBinPath)) return tunnelBinPath;
  const cands = ['C:/Program Files/cpolar/cpolar.exe', 'C:/Program Files (x86)/cpolar/cpolar.exe',
    'E:/cpolar/cpolar.exe', 'D:/cpolar/cpolar.exe', 'C:/cpolar/cpolar.exe'];
  /* 从 PATH 里碰运气（本机 PATH 里 python 都没有，所以这只是补充） */
  const paths = (process.env.PATH || '').split(path.delimiter);
  paths.forEach(p => { if (p) cands.push(path.join(p, 'cpolar.exe'), path.join(p, 'cpolar')); });
  for (const c of cands) {
    try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch (e) {}
  }
  return '';
}

function setTunnelBin(p) {
  tunnelBinPath = p || '';
  saveState(true);          /* 立刻落盘，下次开服不用再选 */
  return tunnelBinPath;
}

/* 拉起 cpolar。用 detached + stdio pipe：能读它的输出（诊断 authtoken 问题），
   同时服务端退出时能把它一起收掉。 */
function startTunnel() {
  if (tunnelProc && tunnelProc.exitCode === null) return { ok: true, already: true };
  const bin = findCpolar();
  if (!bin) {
    return { ok: false, err: '没找到 cpolar.exe —— 在下面选一次它的位置（选完会记住）' };
  }
  tunnelLastErr = '';
  let proc;
  try {
    proc = require('child_process').spawn(bin, ['http', String(PORT)], {
      cwd: path.dirname(bin), detached: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { ok: false, err: '启动失败：' + e.message };
  }
  tunnelProc = proc;
  tunnelStartedAt = Date.now();
  let out = '';
  const eat = d => {
    out += d.toString();
    if (out.length > 4000) out = out.slice(-4000);
  };
  proc.stdout.on('data', eat);
  proc.stderr.on('data', eat);
  proc.on('exit', () => { tunnelLastErr = (out.match(/[^\n]*(authtoken|error|fail)[^\n]*/i) || [''])[0]; });
  proc.on('error', e => { tunnelLastErr = e.message; tunnelProc = null; });
  log('🌍 已拉起穿透：' + path.dirname(bin));
  return { ok: true };
}

function stopTunnel() {
  if (!tunnelProc) return { ok: true, already: true };
  try { tunnelProc.kill(); } catch (e) {}
  const dead = tunnelProc;
  tunnelProc = null; tunnelStartedAt = 0;
  /* Windows 上 cpolar 有时不随父进程一起退，补一刀（按 pid） */
  try { require('child_process').exec('taskkill /PID ' + dead.pid + ' /T /F', () => {}); } catch (e) {}
  log('· 穿透已关闭（外地朋友暂时连不进来）');
  return { ok: true };
}

/* 服务端退出时把穿透一起收掉 —— 别留一个还在公网上暴露 8080 的进程 */
function killTunnelOnExit() {
  if (!tunnelProc) return;
  try { tunnelProc.kill(); } catch (e) {}
  try { require('child_process').exec('taskkill /PID ' + tunnelProc.pid + ' /T /F', () => {}); } catch (e) {}
  tunnelProc = null;
}

function adminInfo() {
  const list = [];
  clients.forEach(c => {
    if (c.role === 'player') list.push({ id: c.id, name: nameOf(c.id) });
  });
  return {
    ok: true,
    name: serverName(), serverId: serverId(), code: room.code || '',
    port: PORT, adminPort: ADMIN_PORT,
    phase: room.phase, mode: room.mode, modeLabel: Engine.modeLabel(room.mode),
    hostId: room.hostId,
    players: list,
    watchers: room.watchers.length,
    tunnelUrl: tunnelUrl, tunnelCheckedAt: tunnelCheckedAt,
    tunnelOn: !!(tunnelProc && tunnelProc.exitCode === null),
    tunnelBin: tunnelBinPath || findCpolar() || '',
    tunnelAutoFound: !!findCpolar(),
    tunnelErr: tunnelLastErr,
    tunnelStartedAt: tunnelStartedAt,
    uptimeMs: Date.now() - STARTED_AT,
    bundle: !!BUNDLE,
  };
}

const adminServer = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  const json = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(body);
  };

  if (urlPath === '/' || urlPath === '/admin.html' || urlPath === '/index.html') {
    sendAsset('admin.html', res); return;
  }
  if (urlPath === '/api/info') { json(200, adminInfo()); return; }
  /* V18.2：玩家发来的操作日志。列表 + 读全文。
     🔴 文件名用白名单正则卡死（只许「时间戳.txt」）—— 杜绝 ../ 穿越读任意文件。 */
  if (urlPath === '/api/clientlogs') { json(200, { ok: true, logs: listClientLogs() }); return; }
  if (urlPath === '/api/clientlog') {
    const m = /[?&]f=([^&]+)/.exec(req.url || '');
    const f = m ? decodeURIComponent(m[1]) : '';
    if (!CLIENTLOG_NAME_RE.test(f)) { json(400, { ok: false, err: '文件名不认识' }); return; }
    try {
      json(200, { ok: true, file: f, text: fs.readFileSync(path.join(CLIENTLOG_DIR, f), 'utf8') });
    } catch (e) { json(404, { ok: false, err: '这份日志已经不在了' }); }
    return;
  }
  /* 只接 GET —— 写操作留给下面的 POST 分支（写反了的话 POST 会被这里吞掉） */
  if (urlPath === '/api/rules' && req.method !== 'POST' && req.method !== 'PUT') {
    json(200, { ok: true, custom: !!rulesOverride, rules: rulesOverride }); return;
  }

  if (urlPath === '/api/config' && (req.method === 'POST' || req.method === 'PUT')) {
    let body = '';
    req.on('data', d => { body += d.toString(); if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let msg = null;
      try { msg = JSON.parse(body || '{}'); } catch (e) { json(400, { ok: false, err: '不是合法 JSON' }); return; }
      let touched = false;
      if (typeof msg.name === 'string') {
        room.name = msg.name.trim().slice(0, 20) || null; touched = true;
      }
      if (typeof msg.code !== 'undefined') {
        const c = (msg.code == null ? '' : String(msg.code)).trim().slice(0, 12);
        room.code = c || null; touched = true;
      }
      if (!touched) { json(400, { ok: false, err: '没有要改的东西' }); return; }
      bump();
      log(`⚙ 管理台设置房间：名称「${serverName()}」` + (room.code ? `，房间码「${room.code}」` : '，无房间码'));
      /* 改完必须让房间里所有人立刻看到（尤其房间码：只挡新人，不影响在房里的人） */
      broadcast({ type: 'sync', view: snapshot(), events: [{ t: 'config', by: null }], actor: null });
      saveState(true);
      json(200, adminInfo());
    });
    return;
  }

  /* 改规则（V16）。传 null / {} 里的 rules:null = 恢复默认。
     🔴 引擎自己会把关：字段白名单 + 数值钳制 + 概率之和必须 100；
        不合法就整条拒绝，房间继续跑默认规则，绝不会跑在半套规则上。 */
  if (urlPath === '/api/rules' && (req.method === 'POST' || req.method === 'PUT')) {
    let body = '';
    req.on('data', d => { body += d.toString(); if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      let msg = null;
      try { msg = JSON.parse(body || '{}'); } catch (e) { json(400, { ok: false, err: '不是合法 JSON' }); return; }
      const r = applyRules(msg.rules || null);
      if (!r.ok) { json(400, { ok: false, errors: r.errors, custom: !!rulesOverride }); return; }
      saveRules();
      bump();
      log(rulesOverride ? '⚙ 管理台改了规则（下一局生效）' : '⚙ 管理台把规则恢复成默认');
      broadcast({ type: 'sync', view: snapshot(), events: [{ t: 'config', by: null }], actor: null });
      json(200, { ok: true, custom: !!rulesOverride, rules: rulesOverride });
    });
    return;
  }

  /* 穿透：action = start（拉起 cpolar）/ stop（关掉）/ refresh（只重抓网址，不改进程）。
     带 bin 字段 = 选一个 cpolar.exe 的位置（会落盘记住）。 */
  if (urlPath === '/api/tunnel' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d.toString(); if (body.length > 8192) req.destroy(); });
    req.on('end', async () => {
      let msg = {};
      try { msg = JSON.parse(body || '{}'); } catch (e) { /* 没带 body = refresh */ }
      const action = msg.action || 'refresh';

      if (typeof msg.bin === 'string' && msg.bin.trim()) {
        const p = msg.bin.trim().replace(/^"|"$/g, '');
        if (!fs.existsSync(p)) { json(400, { ok: false, err: '这个路径不存在：' + p }); return; }
        setTunnelBin(p);
        log('⚙ 穿透程序位置已记住：' + p);
      }

      if (action === 'start' && !(tunnelProc && tunnelProc.exitCode === null)) {
        const r = startTunnel();
        if (r.ok) {
          /* 给它 3 秒把隧道建起来，然后抓一次网址 —— 房主点完就能看到结果 */
          for (let i = 0; i < 6; i++) {
            await new Promise(res => setTimeout(res, 500));
            if (await grabTunnelUrl()) break;
          }
        }
      } else if (action === 'stop') {
        stopTunnel();
        tunnelUrl = '';
      }
      await pollTunnel();
      json(200, adminInfo());
    });
    return;
  }

  /* 让房主在资源管理器里挑 cpolar.exe（原生选择框只在这台机器上有意义） */
  if (urlPath === '/api/pick-cpolar' && req.method === 'POST') {
    const ps = [
      '$f = New-Object System.Windows.Forms.OpenFileDialog;',
      '$f.Filter = "cpolar (cpolar.exe)|cpolar.exe|所有程序 (*.exe)|*.exe";',
      '$f.Title = "选 cpolar.exe（穿透程序）";',
      'if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }',
    ].join(' ');
    require('child_process').exec(
      'powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; ' + ps + '"',
      { windowsHide: true, timeout: 120000 },
      (err, stdout) => {
        const picked = String(stdout || '').trim().split('\n').pop().trim();
        if (picked && fs.existsSync(picked)) {
          setTunnelBin(picked);
          log('⚙ 穿透程序位置已记住：' + picked);
          json(200, adminInfo());
        } else {
          json(200, Object.assign(adminInfo(), { picked: false }));
        }
      });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 not found');
});

/* ============================ WebSocket（原生实现） ============================ */

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f, off = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2)); off = 10;
  }

  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;

  const mask = masked ? buf.slice(off, off + 4) : null;
  const payload = Buffer.from(buf.slice(off + maskLen, off + maskLen + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

  return { opcode, payload, total: off + maskLen + len };
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendRaw(client, opcode, payload) {
  if (client.socket.destroyed) return;
  try { client.socket.write(encodeFrame(opcode, payload)); } catch (e) { drop(client); }
}

function sendJSON(client, obj) {
  sendRaw(client, 0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
}

/* 广播给所有「房间成员」（玩家 + 观战者） */
function broadcast(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  for (const c of clients) if (inRoom(c)) sendRaw(c, 0x1, payload);
}

function drop(client) {
  if (!clients.has(client)) return;
  clients.delete(client);
  clearInterval(client.pingTimer);

  let changed = false;

  if (client.id && client.role === 'player' && room.match.players[client.id]) {
    const p = room.match.players[client.id];
    /* 同一个人开了两个标签页时，关掉一个不该把人踢下线 */
    const stillOn = [...clients].some(c => c.id === client.id && c.role === 'player');
    if (!stillOn) {
      p.connected = false;
      log(`x ${p.name} 断开（状态已封存，等他重连）`);
      changed = true;
    }
  } else if (client.id && client.role === 'watcher') {
    const w = watcherById(client.id);
    const stillOn = [...clients].some(c => c.id === client.id && c.role === 'watcher');
    if (w && !stillOn) {
      w.connected = false;
      log(`x ${w.name}（观战）断开`);
      changed = true;
    }
  }

  if (changed) {
    bump();
    /* 房主可能就在刚断开的人里 —— 先迁移，再广播，免得大家看到一个不存在的房主 */
    ensureHost();
    broadcast({ type: 'sync', view: snapshot(), events: [], actor: null });
    syncFreeze(null);
    saveState(false);
  }

  try { client.socket.destroy(); } catch (e) {}
}

/* ============================ 消息处理 ============================ */

function onMessage(client, text) {
  /* 频率限制：正常操作远达不到每秒 60 条 */
  const now0 = Date.now();
  if (now0 - client.rateAt > 1000) { client.rateAt = now0; client.rateN = 0; }
  client.rateN += 1;
  if (client.rateN > 60) { log('! 消息过频，断开一个连接'); drop(client); return; }

  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  if (!msg || typeof msg.type !== 'string') return;

  /* ---------- 加入 / 重连 / 观战 ---------- */
  if (msg.type === 'join') {
    if (room.code && msg.pass !== room.code) {
      sendJSON(client, { type: 'rejected', reason: 'bad-room-code' });
      return;
    }

    /* 🔴 V18：二次 join 一律先回收旧身份。
       这条连接可能已经顶着一个座位或观战席（前端有一种路径会在 WebSocket 开着的时候
       再发一次 join）。不回收的话，那个座位就成了无人认领的孤魂：名单上他在场，
       实际既没有连接也没有资格做任何动作 —— 只能是重开客户端才恢复。
       回收发生在「认身份之前」，所以对下面三条分支一视同仁。 */
    const freed = inRoom(client) ? releaseIdentity(client) : [];

    /* ① 拿凭证回来 → 优先还原座位，其次还原观战席（凭证是唯一依据，id 只当提示） */
    const who = memberByToken(msg.token);
    if (who) {
      const newName = msg.name ? String(msg.name).slice(0, 12) : '';
      if (who.kind === 'player') {
        const seat = who.ref;
        client.id = seat.id;
        client.role = 'player';
        seat.connected = true;
        if (newName) seat.name = newName;
        /* V18：同一个座位只认最新这条连接 —— 旧的那条请出去。
           留着它的话，它一关就把座位判成掉线，全场跟着封存等「根本在线的人」。 */
        evictTwins(seat.id, client);
        log(`> ${seat.name} 重连（在线 ${clients.size} 人）`);
        bump();
        sendJSON(client, {
          type: 'welcome', you: seat.id, token: seat.token, resumed: true, spectator: false, view: snapshot(),
        });
        broadcast({ type: 'sync', view: snapshot(), events: freed, actor: seat.id });
        syncFreeze(seat.id);
        return;
      }
      /* 观战席：他上次是「退出本局」或者中途进来观战的 */
      const w = who.ref;
      client.id = w.id;
      client.role = 'watcher';
      w.connected = true;
      if (newName) w.name = newName;
      evictTwins(w.id, client);
      log(`> ${w.name} 以观战身份回来（在线 ${clients.size} 人）`);
      bump();
      ensureHost();
      sendJSON(client, {
        type: 'welcome', you: w.id, token: w.token, resumed: true, spectator: true,
        leftMatch: !!w.left, view: snapshot(),
      });
      broadcast({ type: 'sync', view: snapshot(), events: freed, actor: w.id });
      return;
    }

    /* ② 没有凭证（或凭证失效） */
    if (room.phase === 'playing') {
      /* 对局中：可以选择「观战」进来，而不是被硬拒 */
      if (msg.spectate) {
        if (room.watchers.length >= MAX_WATCHERS) {
          sendJSON(client, { type: 'rejected', reason: 'too-many-watchers' });
          return;
        }
        const id = String(nextId++);
        const name = String(msg.name || ('观战者' + id)).slice(0, 12);
        const w = newWatcher(id, name, null);
        w.left = false;
        client.id = w.id;
        client.role = 'watcher';
        log(`+ ${name} 以观战身份进入（在线 ${clients.size} 人）`);
        bump();
        sendJSON(client, {
          type: 'welcome', you: w.id, token: w.token, resumed: false, spectator: true, view: snapshot(),
        });
        broadcast({ type: 'sync', view: snapshot(), events: freed.concat([{ t: 'watch', name: w.name, joined: true }]), actor: w.id });
        saveState(true);
        return;
      }
      sendJSON(client, {
        type: 'rejected',
        reason: msg.token ? 'bad-token' : 'game-in-progress',
        canSpectate: room.watchers.length < MAX_WATCHERS,
        modeLabel: Engine.modeLabel(room.mode),
        players: room.match.order.map(id => nameOf(id)),
      });
      return;
    }

    /* ③ 大厅里开新座位 */
    const id = String(nextId++);
    const name = String(msg.name || ('玩家' + id)).slice(0, 12);
    const p = Engine.newPlayer(id, name, room.mode);
    p.token = newToken();
    room.match.players[id] = p;
    room.match.order.push(id);
    client.id = id;
    client.role = 'player';
    if (!room.hostId) room.hostId = id;
    log(`+ ${name} 加入（在线 ${clients.size} 人）`);

    bump();
    sendJSON(client, {
      type: 'welcome', you: id, token: p.token, resumed: false, spectator: false, view: snapshot(),
    });
    broadcast({ type: 'sync', view: snapshot(), events: freed, actor: id });
    saveState(true);
    return;
  }

  /* 以下动作都要求先是「房间成员」（玩家或观战者） */
  if (!inRoom(client)) { sendJSON(client, { type: 'rejected', reason: 'not-joined' }); return; }

  /* ---------- 离开房间：玩家和观战者都能用（彻底走人） ----------
     区别：`leave` = 退出本局但人留着转观战（座位保住，下一局还能上）；
           `quit`  = 连房间一起退，座位一并清掉，重进要重新报名。 */
  if (msg.type === 'quit') {
    const gone = nameOf(client.id);
    const wasPlayer = client.role === 'player';
    let evs = [];

    if (wasPlayer && room.match.players[client.id]) {
      /* 对局中：先走一遍 leaveMatch，让局面自洽 —— 它会保住回合指针不推进
         （否则等于白送下一个人一个回合），也会立刻重判结束条件（只剩一人即判胜）。
         大厅里没有对局，直接抹座位即可。 */
      if (room.phase === 'playing') {
        const out = Engine.leaveMatch(room.match, client.id, Date.now());
        room.match = out.match;
        evs = out.events;
      }
      if (room.match.players[client.id]) {
        delete room.match.players[client.id];
        const i = room.match.order.indexOf(client.id);
        if (i >= 0) room.match.order.splice(i, 1);
      }
    }

    room.watchers = room.watchers.filter(w => w.id !== client.id);
    client.role = null;
    client.id = null;
    bump();
    log(`- ${gone} 离开了房间`);
    ensureHost();
    sendJSON(client, { type: 'left-room' });
    broadcast({ type: 'sync', view: snapshot(), events: evs.concat([{ t: 'watch', name: gone, joined: false }]), actor: null });
    saveState(true);
    return;
  }

  /* ---------- 退出本局（玩家专用）：人留着，转观战 ---------- */
  if (msg.type === 'leave') {
    if (client.role !== 'player') { sendJSON(client, { type: 'rejected', reason: 'not-in-play' }); return; }
    if (room.phase !== 'playing') { sendJSON(client, { type: 'rejected', reason: 'not-playing' }); return; }

    const out = Engine.leaveMatch(room.match, client.id, Date.now());
    if (!out.seat) {
      sendJSON(client, { type: 'rejected', reason: (out.events[0] && out.events[0].reason) || 'bad-action' });
      return;
    }
    room.match = out.match;

    /* 原 id / 原名字 / 原凭证留成一个观战席 —— 他的人还在房间里，随时能接着看；
       下一局回大厅时又会自动回到名单（见 reset）。房主身份也一并保住。 */
    const w = watcherById(out.seat.id) || newWatcher(out.seat.id, out.seat.name, out.seat.token);
    w.connected = true;
    w.name = out.seat.name;
    w.token = out.seat.token;
    w.left = true;
    client.role = 'watcher';
    client.id = w.id;

    bump();
    log(`~ ${out.seat.name} 退出了本局，转观战（场上还剩 ${room.match.order.length} 人）`);
    broadcast({ type: 'sync', view: snapshot(), events: out.events, actor: client.id });
    /* 只剩一个活人时 leaveMatch 会直接判胜 —— 那要跟着封存语义一起广播 */
    saveState(true);
    return;
  }

  const boss = client.id === room.hostId;

  /* ---------- 改服务器名称 / 房间码（仅房主；大厅和局中都能改） ----------
     房间码是「门禁」：改掉之后，**已经在房里的人不受影响**（他们早就进来了），
     只有新加入的人要用新码。这比"踢人重进"友好得多。 */
  if (msg.type === 'config') {
    if (!boss) { sendJSON(client, { type: 'rejected', reason: 'not-host' }); return; }
    let touched = false;
    if (typeof msg.name === 'string') {
      room.name = msg.name.trim().slice(0, 20) || null;
      touched = true;
    }
    if (typeof msg.code !== 'undefined') {
      const c = (msg.code == null ? '' : String(msg.code)).trim().slice(0, 12);
      room.code = c || null;
      touched = true;
    }
    if (!touched) { sendJSON(client, { type: 'rejected', reason: 'nothing-to-change' }); return; }
    bump();
    log(`⚙ ${nameOf(client.id)} 设置房间：名称「${serverName()}」` +
      (room.code ? `，房间码「${room.code}」` : '，无房间码'));
    broadcast({ type: 'sync', view: snapshot(), events: [{ t: 'config', by: client.id }], actor: client.id });
    saveState(true);
    return;
  }

  /* ---------- 设置模式（仅大厅 + 仅房主） ---------- */
  if (msg.type === 'setMode') {
    if (room.phase !== 'lobby') { sendJSON(client, { type: 'rejected', reason: 'not-in-lobby' }); return; }
    if (!boss) { sendJSON(client, { type: 'rejected', reason: 'not-host' }); return; }
    /* solo（死亡轮盘）是本地模式，不经服务端 —— 这里直接拒掉 */
    if (Engine.MODES.indexOf(msg.mode) < 0 || msg.mode === 'solo') {
      sendJSON(client, { type: 'rejected', reason: 'bad-mode' }); return;
    }
    room.mode = msg.mode;
    // 重建大厅对局：不同模式血量/商城都不同，大厅里显示的必须跟着换
    room.match = lobbyMatch(msg.mode, seatList());
    bump();
    log(`~ 房主切换模式为 ${Engine.modeLabel(msg.mode)}（${msg.mode}）`);
    broadcast({ type: 'sync', view: snapshot(), events: [], actor: client.id });
    saveState(true);
    return;
  }

  /* ---------- 开局（仅大厅 + 仅房主） ---------- */
  if (msg.type === 'start') {
    if (room.phase !== 'lobby') { sendJSON(client, { type: 'rejected', reason: 'not-in-lobby' }); return; }
    if (!boss) { sendJSON(client, { type: 'rejected', reason: 'not-host' }); return; }
    if (room.match.order.length < 1) { sendJSON(client, { type: 'rejected', reason: 'no-players' }); return; }
    /* 有人不在线就别开局：否则一开就封存，等于白开 */
    const off = offlineIds();
    if (off.length) { sendJSON(client, { type: 'rejected', reason: 'player-offline', names: off.map(nameOf) }); return; }

    // 用当前大厅名单重建一份干净的对局（token 原样带过去）
    const seats = seatList().map(s => ({ id: s.id, name: s.name, token: s.token }));
    // startedAt 由服务端打点 —— 它是「存活时间」的起点
    room.match = Engine.createMatch({ mode: room.mode, players: seats, startedAt: Date.now() });
    room.phase = 'playing';
    bump();
    log(`= 开局：${Engine.modeLabel(room.mode)} · ${seats.map(p => p.name).join(', ')}`);
    broadcast({ type: 'sync', view: snapshot(), events: [{ t: 'start', mode: room.mode }], actor: client.id });
    saveState(true);
    return;
  }

  /* ---------- 回到大厅（仅房主） ---------- */
  if (msg.type === 'reset') {
    if (!boss) { sendJSON(client, { type: 'rejected', reason: 'not-host' }); return; }
    /* 观战者也是房间成员 —— 回大厅时一并回名单，下一局他们又是选手 */
    const seats = seatList()
      .concat(room.watchers.map(w => ({ id: w.id, name: w.name, token: w.token, connected: w.connected })))
      .filter(s => s.connected)
      .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
      .map(s => ({ id: s.id, name: s.name, token: s.token }));
    room.match = lobbyMatch(room.mode, seats);
    room.phase = 'lobby';
    room.watchers = [];
    /* 座位 id 沿用旧号，新玩家必须从最大号之后接着排，否则会撞号 */
    nextId = Math.max(nextId, 0, ...Object.keys(room.match.players).map(Number)) + 1;
    bump();
    log(`~ 回到大厅（${seats.length} 人在名单里）`);
    broadcast({ type: 'sync', view: snapshot(), events: [{ t: 'lobby' }], actor: client.id });
    saveState(true);
    return;
  }

  /* ---------- 对局动作（只有玩家能做；观战者到这儿一律被拒） ---------- */
  if (client.role !== 'player') { sendJSON(client, { type: 'rejected', reason: 'not-in-play' }); return; }
  const me = room.match.players[client.id];
  if (!me) { sendJSON(client, { type: 'rejected', reason: 'no-such-player' }); return; }
  if (room.phase !== 'playing') { sendJSON(client, { type: 'rejected', reason: 'not-playing' }); return; }

  let action = null;
  if (msg.type === 'spin') action = { type: 'spin', playerId: client.id };
  else if (msg.type === 'buy') action = { type: 'buy', playerId: client.id, itemId: msg.itemId, targetId: msg.targetId };
  else if (msg.type === 'usePotion') action = { type: 'usePotion', playerId: client.id };
  else return;

  // ★ 服务端权威：唯一产生随机数的地方；时间也以服务端为准
  const out = Engine.applyAction(room.match, action, secureRng, Date.now());

  if (out.events.length === 1 && out.events[0].t === 'rejected') {
    sendJSON(client, { type: 'rejected', reason: out.events[0].reason, itemId: msg.itemId, targetId: msg.targetId });
    return;
  }

  room.match = out.match;
  bump();
  broadcast({ type: 'sync', view: snapshot(), events: out.events, actor: client.id });
  saveState(false);
}

/* ============================ 连接建立 ============================ */

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const now = Date.now();
  const client = {
    socket, id: null, buf: Buffer.alloc(0), pingTimer: null,
    lastSeen: now, rateAt: now, rateN: 0,
  };
  clients.add(client);

  socket.on('data', chunk => {
    client.lastSeen = Date.now();
    client.buf = Buffer.concat([client.buf, chunk]);
    if (client.buf.length > 1024 * 1024) { drop(client); return; }
    while (true) {
      const f = decodeFrame(client.buf);
      if (!f) break;
      client.buf = client.buf.slice(f.total);
      if (f.opcode === 0x8) { drop(client); return; }
      if (f.opcode === 0x9) { sendRaw(client, 0xA, f.payload); continue; }
      if (f.opcode === 0x1) onMessage(client, f.payload.toString('utf8'));
    }
  });

  /* ⚠ 关键：HTTP upgrade 交出来的 socket 是「半开」的（allowHalfOpen）。
     对端关闭时只会触发 end，不会自动 close —— 不接它，服务端就永远
     察觉不到有人掉线（旧版 v2 就是栽在这里：掉线的人一直显示在线）。
     所以 end 也必须当掉线处理。 */
  socket.on('end', () => drop(client));
  socket.on('close', () => drop(client));
  socket.on('error', () => drop(client));

  client.pingTimer = setInterval(() => {
    if (socket.destroyed) { clearInterval(client.pingTimer); return; }
    /* 看门狗：45 秒一帧都没收到，说明连接已经死了，当掉线处理 */
    if (Date.now() - client.lastSeen > 45000) {
      log('! 连接超时（45 秒无响应），按掉线处理');
      drop(client);
      return;
    }
    sendRaw(client, 0x9, Buffer.alloc(0));
  }, 15000);
});

/* ============================ 启动 ============================ */

/* 本机的局域网 / 虚拟网 IPv4 —— 开局时直接印出来，朋友照着输就行，
   省得房主自己去查 ipconfig。 */
function lanAddrs() {
  const os = require('os');
  const out = [];
  const ifs = os.networkInterfaces();
  /* 虚拟 / 未插线的网卡：打分时一律垫底。
     Windows 上蓝牙、Hyper-V、WSL、VMware、没接网线的以太网口都会各占一条 IPv4，
     其中没拿到 DHCP 租约的会分到 169.254.x.x（APIPA）—— 这种地址永远连不上。 */
  const VIRTUAL = /vmware|virtualbox|hyper-?v|vethernet|wsl|docker|loopback|bluetooth|蓝牙|本地连接\s*\*|virtual|^tap|^tun|zerotier|radmin|hamachi|teredo|isatap|npcap/i;
  const PHYSICAL = /wlan|wi-?fi|wireless|以太网|ethernet|^en\d|^eth\d|wlp/i;
  for (const name in ifs) {
    for (const a of (ifs[name] || [])) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const ip = a.address;
      /* ★ 169.254/16 = 没租约的死地址。上一版把它印了出来，
         真地址反而排在最后 —— 用户照着第一条输，必然连不上。直接扔掉。 */
      if (/^169\.254\./.test(ip)) continue;
      if (/^(0|255)\./.test(ip)) continue;
      let score;
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) score = 60;   /* Tailscale：外网朋友靠它 */
      else if (/^192\.168\./.test(ip)) score = 72;
      else if (/^10\./.test(ip)) score = 70;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) score = 68;
      else score = 40;                                                      /* 公网 / 其他 */
      if (PHYSICAL.test(name)) score += 8;                                   /* 物理网卡优先 */
      if (VIRTUAL.test(name)) score -= 40;                                   /* 虚拟网卡垫底 */
      /* V14：异地组网（Tailscale / ZeroTier / WireGuard…）的虚拟网卡要单独成组。
         原因：局域网地址朋友在外地根本连不上，横幅却把它排在最显眼的位置，
         房主照着报，必然失败。虚拟网卡只能按名字认（ZeroTier 也发 192.168.x.x，
         跟家里路由器完全同形），所以名字 + Tailscale 的 CGNAT 段两条一起判。 */
      const isVpn = /zerotier|tailscale|wireguard|radmin|hamachi|openvpn|wg\d|^tun|^tap/i.test(String(name))
        || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
      out.push({ name: String(name), addr: ip, score: score, kind: isVpn ? 'vpn' : 'lan' });
    }
  }
  out.sort((x, y) => (y.score - x.score) || x.addr.localeCompare(y.addr));
  return out;
}

/* 先试着恢复上次的对局，再开始监听 */
const restored = loadState();
/* 房主改过的规则（没有 rules.json 就什么都不做，引擎保持在默认） */
loadRules();

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddrs();
  console.log('');
  console.log('  生死转盘 · 联机服务器 v6' + (BUNDLE ? '（单机 exe 版）' : ''));
  console.log('  ────────────────────────────────────────');
  console.log(`  服务器名称：    ${serverName()}`);
  console.log(`  服务器编号：    ${serverId()}          ← 手机 App 里认这个号`);
  console.log(`  房间码：        ${room.code || '（无，任何人可加入；房主可在管理台设）'}`
    + (room.code === DEFAULT_ROOM_CODE ? '        ← 默认码，可在管理台改（重启会回到这个）' : ''));
  if (restored) console.log('  上次对局：      已恢复（见上方日志）');
  console.log('');
  console.log('  手机 App 通常能自动搜到本机（走 UDP 广播），**一个地址都不用填**。');
  console.log('  搜不到、或要异地加入时，才手动填下面这一行：');
  console.log('');
  /* 注意：这一行的「本机打开」是三个脚本（client-mp-test / build-pc / verify-live）
     判断「服务已就绪」的哨兵字符串，改文案时别把它删掉。 */
  /* ⚠「本机打开：」是三个脚本判断「服务已就绪」的哨兵字符串 —— 这四个字不能动，
     后面的内容可以改。V16：双击打开的是房主管理台（游戏页从管理台里进）。 */
  console.log(`  本机打开：      http://127.0.0.1:${ADMIN_PORT}（双击本程序会自动开房主管理台）`);
  console.log('');
  /* V14：地址分两组。**局域网地址外地朋友连不上**，所以不能让它独霸这一块。
     「★ 别人连这一行」是 build/build-pc.js 冒烟用的哨兵，别删。 */
  const lans = addrs.filter(a => a.kind === 'lan');
  const vpns = addrs.filter(a => a.kind === 'vpn');

  if (lans.length) {
    const best = lans[0];
    console.log('  ★ 别人连这一行 —— 同一个 WiFi / 校园网下，照抄，不要加 http:// ：');
    console.log('');
    console.log('        ' + best.addr + ':' + PORT + '        ← 网卡：' + best.name);
    console.log('');
    if (lans.length > 1) {
      console.log('    其他网卡（一般用不上；上面那条连不通时再逐条试）：');
      lans.slice(1).forEach(a => console.log('        ' + a.addr + ':' + PORT + '     ← ' + a.name));
      console.log('');
    }
  } else {
    console.log('  ✗ 没找到可用的局域网地址 —— 检查网络（全是 169.254 就是没连上路由器）');
    console.log('');
  }

  console.log('  ── 外地的朋友怎么连 ────────────────────────────');
  if (vpns.length) {
    console.log('  ★ 异地朋友连这一行（虚拟网：Tailscale / ZeroTier 等）—— 整条抄走：');
    console.log('');
    vpns.forEach(a => console.log('        ' + a.addr + ':' + PORT + '        ← ' + a.name));
    console.log('');
    console.log('    朋友那边也要装同一个组网软件、加入同一个网络，否则这个地址对他不存在。');
  } else {
    console.log('  ○ 没检测到虚拟网卡 —— 外地朋友现在还连不进来。三条路任选其一：');
    console.log('');
    console.log('    ① 装 Tailscale（两边都装、登同一账号）→ 重启本程序，这里会多出一行地址；');
    console.log('    ② 装 ZeroTier（两边都装、加入同一个网络 ID）→ 同上；');
    console.log('    ③ 内网穿透（cpolar / 花生壳等），把本机的 ' + PORT + ' 端口映射出去 → 拿到一个公网网址，');
    console.log('       直接发给朋友：他用浏览器打开就能玩，点一下进房间。');
    console.log('       隧道一起来，本窗口和「房主管理台」会**自动**显示拿到的网址，不用手抄。');
  }
  console.log('  ────────────────────────────────────────────────');
  console.log('');
  console.log(`  · 手机和电脑连同一个地址 = 同一个房间。用的是同一套协议，天然互通 ——`);
  console.log(`    手机端不需要单独的服务端，PC 端也不需要单独的协议。`);
  console.log(`  · 手机连不上时先自检：用手机浏览器打开 http://<上面那个地址>`);
  console.log(`    打得开 = 网络通，问题在 App 里；打不开 = 防火墙或 Wi-Fi 隔离（见下）`);
  console.log(`  · 有些公共 Wi-Fi / 校园网开了「AP 隔离」，同一 Wi-Fi 下设备互相看不见 ——`);
  console.log(`    那种情况只能用手机热点（电脑连手机热点），或者走上面的「异地」那条路。`);
  console.log(`  · 走内网穿透时朋友**什么都不用装**：浏览器打开你给的网址即可（会走 https，`);
  console.log(`    页面里的 WebSocket 自动升级成 wss —— 代码已处理，不用改任何设置）。`);
  console.log(`  · 规则由 engine.js 提供，服务端权威掷骰`);
  console.log(`  · 掉线不踢人：自动封存对局，等本人重连回来接着打`);
  console.log(`  · 对局中任何玩家都能「退出本局」→ 转观战，房间席位保留`);
  console.log(`  · 房主掉线自动把房主转给在线编号最小的人（原房主回来不回任）`);
  console.log(`  · 对局状态实时写入 state.json，服务重启可续`);
  console.log(`  · 只对外发游戏自己的文件（state.json / .workbuddy 不外发）`);
  console.log(`  · 监听 0.0.0.0：同网段（局域网 / Tailscale 等虚拟网）都能连。`);
  console.log(`    这不会把服务开给整个互联网，但同网段的人能连上 —— 建议带上房间码。`);
  console.log(`  · Windows 防火墙弹窗务必点「允许」`);
  console.log(`  · 按 Ctrl+C 停止服务（会先存档）`);
  console.log('');

  /* 房间管理台：只监听 127.0.0.1 的独立端口 ⇒ 异地绝对连不进来。
     设 RR_NO_ADMIN=1 可关（测试环境端口冲突时用）。 */
  if (!process.env.RR_NO_ADMIN) {
    /* 端口被占就往后挪一格再试 —— 管理台起不来不影响游戏，但不该让房主干瞪眼。 */
    const listenAdmin = (port, triesLeft) => {
      const onErr = e => {
        adminServer.removeListener('error', onErr);
        if ((e && e.code === 'EADDRINUSE') && triesLeft > 0) {
          setTimeout(() => listenAdmin(port + 1, triesLeft - 1), 40);
          return;
        }
        console.log('  ! 房主管理台起不来（' + (e && e.code ? e.code : e) + '）——');
        console.log('    游戏照常能玩，只是没有那个后台页面。可以指定端口：node server.js ' + PORT + ' 9099');
      };
      adminServer.once('error', onErr);
      adminServer.listen(port, '127.0.0.1', () => {
        adminServer.removeListener('error', onErr);
        ADMIN_PORT = port;
        console.log(`  房主管理台：    http://127.0.0.1:${ADMIN_PORT}  ← 只有这台电脑打得开`);
        console.log('                  改房间码、看穿透网址，都在这个页面里。');
      });
    };
    listenAdmin(ADMIN_PORT, 40);
    /* 穿透网址：隧道一起来就自动抓到（10 秒一轮）。RR_NO_TUNNEL=1 关掉。 */
    if (!process.env.RR_NO_TUNNEL) {
      pollTunnel();
      setInterval(pollTunnel, 10000);
    }
  }

  /* 打包版是双击运行的，替房主把**管理台**开起来（房主就是开服务的那个人）；
     开发时不打扰。设 RR_NO_OPEN=1 可关掉（自动化测试、排障时用）。 */
  if (BUNDLE && process.platform === 'win32' && !process.env.RR_NO_OPEN) {
    try { require('child_process').exec(`start "" "http://127.0.0.1:${ADMIN_PORT}"`); } catch (e) {}
  }

  /* UDP 发现放最后起：上面横幅先印出来，出问题也好读 */
  startDiscovery();
});

function shutdown() {
  if (discoverySock) { try { discoverySock.close(); } catch (e) {} }
  /* 我们拉起来的穿透要一起收掉 —— 别留一个还在公网上暴露 8080 的 cpolar 进程 */
  killTunnelOnExit();
  writeStateNow();
  console.log('\n已存档，服务停止。');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', killTunnelOnExit);
