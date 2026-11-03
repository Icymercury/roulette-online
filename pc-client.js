/* ============================================================
 * 生死转盘 · PC 客户端 v1
 * ------------------------------------------------------------
 *   node pc-client.js
 *
 * 它是什么：一个「找服务器 + 开窗口」的小启动器。
 *   · 扫描局域网里的服务端（UDP 广播，服务端回一张卡片）
 *   · 把结果画成一个本地选择页
 *   · 点一台服务器 → 用 Edge/Chrome 的 --app 模式开一个**没有地址栏、
 *     没有标签页**的窗口，直接进那个服务器上的游戏页
 *
 * 为什么它不内置游戏页面：
 *   游戏页直接从服务器加载（http://<服务器>:<端口>/client.html），
 *   于是页面里的 location.host 天然就是对的 —— **地址一个都不用输**。
 *   客户端只管「找到谁、连谁」，游戏本体永远由服务端提供（天然同版本）。
 *
 * 为什么扫描必须在 Node 里做：
 *   浏览器（含 WebView）的 JS 发不了 UDP 广播。所以手机端由安卓壳的 Java 扫，
 *   PC 端由本文件扫。网页方式打开游戏页时没有扫描能力，只能手输地址。
 *
 * 扫描有**两条互相兜底的路**（见文件里「第二条路」那段注释）：
 *   ① 主动：我们广播「谁在？」→ 服务端单播回一张卡片
 *   ② 被动：服务端每 3 秒自己广播一次心跳 → 我们收着
 *   两条路的防火墙要求正好相反，所以都留着。
 *
 * 环境变量：
 *   RR_DISCOVERY_PORT  发现端口（默认 8099）
 *   RR_BROWSER         指定浏览器可执行文件
 *   RR_DRY_OPEN=1      只回报要开的网址，不真的开窗口（自动化测试用）
 *   RR_NO_OPEN=1       连选择页窗口也不开，只起本机服务
 *   RR_NO_ASK=1        只被动收心跳、不主动询问（专门用来验第二条路）
 * ============================================================ */

const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DISCOVERY_PORT = Number(process.env.RR_DISCOVERY_PORT) || 8099;
const CARD_TTL_MS = 9000;          // 超过这么久没再听到就认为它关了
const NO_ASK = !!process.env.RR_NO_ASK;   // 只被动听心跳、不主动询问（测试第二条路用）

/* ============================ ⓪ 日志 ============================
 * 打包成 exe 之后（GUI 子系统，见 build-pc-client.js 的 Subsystem 改写），
 * console.log 没有控制台可写 —— 输出会被静默丢掉。所以这里把全部输出
 * **同时**写一份到文件，玩家遇到问题能直接把日志发过来。
 *
 * 🔴 开关：RR_DEBUG_WINDOW=1 时，用 `cmd /c start` 给自己开一个真控制台
 *    再重跑一遍，让 console.log 有地方去（排障用，正常双击不弹窗）。
 * 日志文件：%TEMP%\生死转盘-客户端.log（每次启动截断，只留最近一次）。 */
const LOG_FILE = path.join(os.tmpdir(), '生死转盘-客户端.log');
const DEBUG_WINDOW = !!process.env.RR_DEBUG_WINDOW;
let logFd = null;
try { logFd = fs.openSync(LOG_FILE, 'w'); } catch (e) { logFd = null; }

/* 把原本的 console.log / console.error 包一层：既写文件、也照常打印。
   打印在没有控制台时无害（Node 只是哪也送不出去），
   有控制台（源码直跑 / RR_DEBUG_WINDOW）时照常可见。 */
const RAW_LOG = console.log.bind(console);
const RAW_ERR = console.error.bind(console);
function emit(orig, args) {
  const line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
  if (logFd !== null) { try { fs.writeSync(logFd, line + '\n'); } catch (e) {} }
  orig.apply(null, args);
}
console.log = (...a) => emit(RAW_LOG, a);
console.error = (...a) => emit(RAW_ERR, a);

/* 已经有一个真控制台了？源码直跑（node pc-client.js）算有；
   打包成 GUI exe 后没有，除非这次是被 RR_DEBUG_WINDOW 重新拉起来的。 */
function hasConsole() {
  try { return process.stdout.isTTY === true || !!process.env.RR_DEBUG_WINDOW; }
  catch (e) { return false; }
}

/* 没控制台又要看输出 ⇒ 用 cmd 开一个窗口跑自己，然后本进程静默退出。
   子进程带上 RR_DEBUG_WINDOW=1，它就知道「别再自己重开一次」。
   `start` 的第一个参数是窗口标题，必须给（否则会被当成要执行的文件）。 */
function reopenWithConsole() {
  try {
    const child = spawn('cmd', ['/c', 'start', '生死转盘·客户端（调试）', process.execPath],
      { detached: true, stdio: 'ignore',
        env: Object.assign({}, process.env, { RR_DEBUG_WINDOW: '1' }) });
    child.unref();
    return true;
  } catch (e) { return false; }
}

/* ============================ ① 发现 ============================ */

const found = Object.create(null);   // key -> card
const state = { passive: false };    // 第二条路（被动收听）是否绑上了

/* 卡片进门的唯一入口 —— 主动询问的单播回复、服务端的心跳广播，两条路都走这里。
   ⚠ 要先滤掉「询问包」：自己的广播会被自己（以及同机的其它监听者）听到。 */
function onCard(buf, rinfo) {
  let o = null;
  try { o = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
  if (!o || o.RRSP !== 1 || o.q) return;       // 不是服务器卡片
  o.host = rinfo.address;                      // 地址来自「谁回的包」，卡片里没有地址字段
  o.ts = Date.now();
  found[o.id + '|' + o.host] = o;
}

/* 除了 255.255.255.255，再按每块网卡算出 /24 广播地址 —— 有些网卡会丢掉「有限广播」 */
function subnetBroadcasts() {
  const out = [];
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const a of (ifs[name] || [])) {
        if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
        const p = String(a.address).split('.');
        if (p.length === 4) out.push(p[0] + '.' + p[1] + '.' + p[2] + '.255');
      }
    }
  } catch (e) { /* 拿不到网卡就算了 */ }
  return out;
}

function startDiscovery() {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', e => {
    console.log('  ! 扫描端口用不了（' + (e && e.code ? e.code : e) + '）——');
    console.log('    不影响手动填地址连接。');
  });

  sock.on('message', onCard);

  sock.bind(0, '0.0.0.0', () => {
    try { sock.setBroadcast(true); } catch (e) {}
    /* ⚠ 这里必须显式传 sock。用外层的 discoverySock 会踩到一个坑：
       它是 `discoverySock = startDiscovery()` 赋值的，此刻赋值还没完成，
       值是 undefined —— 第一次询问会被静默吞掉，要等 2.5 秒后的定时器才生效。 */
    ask(sock);
  });

  const timer = setInterval(() => { ask(discoverySock); }, 2500);
  if (timer.unref) timer.unref();
  return sock;
}

function ask(sock) {
  if (NO_ASK) return;
  const s = sock || discoverySock;
  if (!s) return;
  const q = Buffer.from(JSON.stringify({ RRSP: 1, q: 'who' }), 'utf8');
  const targets = ['255.255.255.255'].concat(subnetBroadcasts());
  for (const t of targets) {
    try { s.send(q, 0, q.length, DISCOVERY_PORT, t, () => {}); } catch (e) {}
  }
}

let discoverySock = null;

/* ---------------- 第二条路：被动收听服务端心跳 ----------------
   为什么要有两条路 —— 防火墙。
     · 主动询问（上面）：要求**服务端那台机器**放行入站 UDP 广播，
       否则它收不到我们的询问，一声不吭。
     · 被动收听（这里）：服务端每 3 秒自己往 255.255.255.255:DISCOVERY_PORT
       广播一次心跳，要求的是**本机**放行入站广播。
   Windows 防火墙默认「允许出站、拦入站」，而两台机器上的放行状态可以完全不同
   （房主的 exe 弹窗点了「取消」、你这台点了「允许」）。两条路的防火墙要求正好互补，
   所以两条都留着 —— 任何一条通，列表里就能看见服务器。
   绑不上就算了（端口被占 / 权限不够）：静默降级成只有主动询问，不影响使用。 */
let passiveSock = null;
function startPassive() {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('message', onCard);
  s.on('error', () => { try { s.close(); } catch (e) {} });
  try {
    s.bind(DISCOVERY_PORT, '0.0.0.0', () => {
      try { s.setBroadcast(true); } catch (e) {}
      state.passive = true;
    });
  } catch (e) {
    return null;
  }
  passiveSock = s;
  return s;
}

function listServers() {
  const now = Date.now();
  const out = [];
  for (const k of Object.keys(found)) {
    const c = found[k];
    if (now - c.ts > CARD_TTL_MS) { delete found[k]; continue; }
    out.push({
      id: c.id, name: c.name, host: c.host, port: c.port,
      players: c.players, watchers: c.watchers,
      phase: c.phase, mode: c.mode, modeLabel: c.modeLabel,
      needCode: !!c.needCode,
    });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

/* ============================ ② 开窗口 ============================ */

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  if (process.env.RR_BROWSER && fs.existsSync(process.env.RR_BROWSER)) return process.env.RR_BROWSER;
  for (const p of BROWSERS) { if (fs.existsSync(p)) return p; }
  return null;
}

/* --app=URL 是「无地址栏、无标签页」的独立窗口 —— 观感就是原生软件，
   而不是浏览器里开的一个网页。 */
function openGameWindow(url) {
  if (process.env.RR_DRY_OPEN) return { ok: true, url: url, dry: true, via: 'dry-run' };
  const b = findBrowser();
  if (b) {
    try {
      spawn(b, ['--app=' + url, '--window-size=1180,860'], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, url: url, via: b };
    } catch (e) { /* 掉到下面兜底 */ }
  }
  /* 兜底：交给系统默认浏览器（会有地址栏，但至少能玩） */
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, url: url, via: 'system-default' };
  } catch (e) {
    return { ok: false, url: url, error: String(e.message || e) };
  }
}

/* 打开**磁盘上的本机页面**（V17 单人模式用）。
   file:// 的路径必须写成斜杠形式、并把盘符前的斜杠补齐成三斜杠
   （file:///D:/... —— 少一条斜杠浏览器会当成主机名，直接打不开）。
   🔴 file:// 页面里访问中文路径在部分浏览器会加载不全，所以本机页面本身
      必须是纯 ASCII 相对路径引用它的依赖（roulette-wheel.html 引 engine.js，同目录）。
   本项目目录含中文（D:\WB开发\...），所以这里**必须真开一次窗口**验证，别靠推测。 */
function fileUrl(p) {
  let s = String(p).replace(/\\/g, '/');
  if (!/^\//.test(s)) s = '/' + s;
  return 'file://' + s;
}
function openLocalFile(p) {
  if (!fs.existsSync(p)) return { ok: false, error: '找不到文件：' + p };
  const url = fileUrl(p);
  if (process.env.RR_DRY_OPEN) return { ok: true, url: url, dry: true, via: 'dry-run' };
  const b = findBrowser();
  if (b) {
    try {
      spawn(b, ['--app=' + url, '--window-size=1180,860'], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, url: url, via: b };
    } catch (e) { /* 掉到下面兜底 */ }
  }
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, url: url, via: 'system-default' };
  } catch (e) {
    return { ok: false, url: url, error: String(e.message || e) };
  }
}

/* ============================ ②·五 单人模式的页面从哪来 ============================
 * 单人模式不需要任何服务器 —— 它直接在本地开 roulette-wheel.html 就能跑。
 * 但「页面上哪摸这个文件」分两种情况：
 *   ① 源码直跑（开发者 / 测试）  → 就在 pc-client.js 同目录，读磁盘；
 *   ② 打包成 exe 之后            → 磁盘上**没有**这个文件（exe 里只有一个 allocator blob），
 *      🔴 这一步是 V17 最容易翻车的地方：客户端 exe 历来「不内嵌任何网页」
 *      （游戏页一律从那台服务器加载，保证版本一致）——但单人模式没有服务器可加载，
 *      所以它是唯一一个必须打进客户端 exe 的页面。
 *      build/build-pc-client.js 会注入 `EMBEDDED_SOLO = {html, engine}`（base64）。
 * 页面里 <script src="engine.js"> 是相对引用，所以两个文件都得发 ——
 * 这就是本机小服务要额外提供 /solo 与 /engine.js 两个路由的原因。 */
function soloSource() {
  if (typeof EMBEDDED_SOLO !== 'undefined' && EMBEDDED_SOLO) {
    try {
      return {
        html: Buffer.from(EMBEDDED_SOLO.html, 'base64').toString('utf8'),
        engine: Buffer.from(EMBEDDED_SOLO.engine, 'base64').toString('utf8'),
        via: 'embedded',
      };
    } catch (e) { /* 掉去读磁盘 */ }
  }
  try {
    return {
      html: fs.readFileSync(path.join(__dirname, 'roulette-wheel.html'), 'utf8'),
      engine: fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8'),
      via: 'disk',
    };
  } catch (e) { return null; }
}

/* 把用户填的东西统一成 { addr, secure }（**和游戏页里同一个规则**，别各写一份）。
     带协议头 → 尊重协议，默认端口 http/ws→80、https/wss→443（绝不补 8080）；
     裸 IP    → 补 8080（局域网服务端默认端口），明文；
     裸域名   → 跟随你给的形式：写了 https 就 https + 443，没写就 http + 80。
   返回 null = 看不懂。 */
const RE_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
function parseAddr(s) {
  let a = String(s == null ? '' : s).trim();
  if (!a) return null;

  let secure = null;
  const m = a.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme === 'https' || scheme === 'wss') secure = true;
    else if (scheme === 'http' || scheme === 'ws') secure = false;
    else return null;
    a = a.slice(m[0].length);
  }

  a = a.replace(/[/?#].*$/, '').replace(/\s+/g, '');
  if (!a || !/^[^\s/?#]+$/.test(a)) return null;

  const pm = a.match(/:(\d+)$/);
  const port = pm ? pm[1] : null;
  const host = pm ? a.slice(0, -(pm[0].length)) : a;
  if (!host || /^\d+$/.test(host)) return null;

  const isIp = RE_IPV4.test(host) || host === 'localhost';
  let defaulted = false;
  if (secure === null) secure = false;      /* PC 客户端没有「页面协议」可跟随 */
  if (!port) {
    defaulted = true;
    a = host + ':' + (isIp ? '8080' : (secure ? '443' : '80'));
  } else {
    a = host + ':' + port;
  }
  return { addr: a, secure: secure, host: host, port: port || a.split(':').pop(), defaulted: defaulted };
}

/* 老接口：只回 host:port（旧调用点 / 旧断言在用）。 */
function normalizeAddr(s) {
  const r = parseAddr(s);
  return r ? r.addr : null;
}

/* ============================ ③ 选择页 ============================
 * V17：双击客户端 exe 的第一屏改成「选玩法」——和手机端 / 服务端首页同一套视觉
 * （转盘 + 单人卡片 + 联机卡片）。点「单人」直接开本机的 roulette-wheel.html，
 * 点「联机」才切到「找服务器」视图。
 *
 * 🔴 为什么必须改：原来一打开就是「找服务器」，PC 玩家**没有任何入口进单人模式**，
 *    而单人模式压根不需要服务器。等于白瞎一个模式。
 *
 * 两种视图都在同一个页面里（display 切换），不开新页面 —— 因为本机小服务
 * 只发这一个 HTML；单机页是磁盘上的 roulette-wheel.html，得让主进程去开窗口。 */

const PICKER = [
  '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>生死转盘</title><style>',
  /* ---- 与 start.html 同一套色板，双击 exe 与手机首页观感一致 ---- */
  ':root{--bg:#100e0b;--bg2:#1a1611;--line:#3a3128;--gold:#e8c26a;--gold-dim:#8d7437;',
  '--txt:#efe6d4;--txt-dim:#9c9186;--red:#c9452f;--green:#52b788}',
  '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
  'html,body{margin:0;height:100%}',
  'body{background:radial-gradient(120% 80% at 50% -10%,#241d15 0%,var(--bg) 60%),var(--bg);',
  'color:var(--txt);font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
  'display:flex;flex-direction:column;align-items:center;padding:24px 18px 26px;overflow-x:hidden}',

  /* 顶部转盘（纯装饰） */
  '.wheel-wrap{width:158px;height:158px;margin:4px 0 2px;position:relative;flex:0 0 auto}',
  '.wheel-wrap svg{width:100%;height:100%;display:block}',
  '.pointer{position:absolute;left:50%;top:-4px;transform:translateX(-50%);width:0;height:0;',
  'border-left:9px solid transparent;border-right:9px solid transparent;border-top:16px solid var(--gold);',
  'filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))}',
  'h1{margin:2px 0 2px;font-size:26px;letter-spacing:.32em;text-indent:.32em;color:var(--gold);',
  'font-weight:700;text-shadow:0 2px 10px rgba(232,194,106,.18)}',
  '.sub{margin:0 0 18px;color:var(--txt-dim);font-size:13px;letter-spacing:.05em}',

  /* 卡片 */
  '.card{width:100%;max-width:430px;display:flex;align-items:center;gap:14px;text-decoration:none;',
  'color:inherit;background:linear-gradient(160deg,#221c15,#181410);border:1px solid var(--line);',
  'border-radius:16px;padding:16px;margin-bottom:13px;cursor:pointer;',
  'transition:transform .12s ease,border-color .12s ease,box-shadow .12s ease}',
  '.card:active{transform:scale(.985)}',
  '.card:hover{border-color:var(--gold-dim);box-shadow:0 6px 22px rgba(0,0,0,.45)}',
  '.card .ico{flex:0 0 52px;height:52px;border-radius:13px;display:flex;align-items:center;',
  'justify-content:center;font-size:26px;background:#0f0c09;border:1px solid var(--line)}',
  '.card .t{flex:1;min-width:0}',
  '.card .nm{font-size:17px;font-weight:700;letter-spacing:.04em}',
  '.card .nm small{font-weight:400;font-size:11px;color:var(--txt-dim);margin-left:7px;letter-spacing:0}',
  '.card .ds{font-size:12px;line-height:1.6;color:var(--txt-dim);margin-top:4px}',
  '.card .go{flex:0 0 auto;color:var(--gold);font-size:13px;letter-spacing:.1em}',
  '#btnSolo .ico{color:var(--green)}',
  '#btnOnline .ico{color:var(--red)}',

  '.hint{width:100%;max-width:430px;margin-top:10px;padding:12px 14px;border:1px dashed var(--line);',
  'border-radius:12px;font-size:12px;line-height:1.75;color:var(--txt-dim);background:rgba(255,255,255,.015)}',
  '.hint b{color:var(--gold);font-weight:600}',
  '.foot{margin-top:auto;padding-top:16px;font-size:11px;color:#6b635a;letter-spacing:.08em}',

  /* ---- 「找服务器」视图（点联机后才显示）---- */
  '.srv-wrap{width:100%;max-width:620px;display:none;flex-direction:column;align-items:center}',
  '.srv-wrap.on{display:flex}',
  '.myview{width:100%;max-width:430px;display:flex;flex-direction:column;align-items:center}',
  '.myview.off{display:none}',
  '.backbtn{align-self:flex-start;background:none;border:1px solid var(--line);color:var(--txt-dim);',
  'border-radius:8px;padding:6px 13px;font-size:12.5px;cursor:pointer;font-family:inherit;',
  'letter-spacing:.08em;margin-bottom:14px}',
  '.backbtn:hover{color:var(--gold);border-color:var(--gold-dim)}',
  '.list{width:100%;display:flex;flex-direction:column;gap:11px}',
  '.srvcard{border:1px solid var(--line);border-radius:11px;background:#181410;padding:15px 18px;',
  'cursor:pointer;transition:.15s;display:flex;justify-content:space-between;align-items:center;gap:14px}',
  '.srvcard:hover{border-color:var(--gold-dim);background:#1e1a14;transform:translateY(-2px)}',
  '.srvcard .nm{font-size:16.5px;letter-spacing:.5px}',
  '.srvcard .mt{font-size:12px;color:var(--txt-dim);margin-top:5px;letter-spacing:.4px}',
  '.badge{font-size:11.5px;border:1px solid var(--gold-dim);color:var(--gold);border-radius:20px;',
  'padding:4px 12px;white-space:nowrap;flex:none}',
  '.badge.dim{border-color:var(--line);color:var(--txt-dim)}',
  '.empty{border:1px dashed var(--line);border-radius:11px;padding:20px;color:var(--txt-dim);',
  'font-size:13px;line-height:1.9;width:100%}',
  '.manual{margin-top:20px;border-top:1px solid var(--line);padding-top:16px;width:100%}',
  '.manual .t{font-size:12px;color:var(--txt-dim);letter-spacing:1px;margin-bottom:9px}',
  '.row{display:flex;gap:9px}',
  'input{flex:1;background:#0f0c09;border:1px solid var(--line);border-radius:8px;color:var(--txt);',
  'padding:11px 13px;font-size:13px;outline:none;font-family:inherit}',
  'input:focus{border-color:var(--gold-dim)}',
  'button.go{background:linear-gradient(180deg,#c9452f,#8e1c1c);color:#ffe8d6;border:1px solid #e86a52;',
  'border-radius:8px;padding:11px 22px;font-size:13px;letter-spacing:2px;cursor:pointer;font-family:inherit}',
  'button.go:hover{transform:translateY(-1px)}',
  '.tip{margin-top:20px;font-size:12px;color:#6f6a62;line-height:1.9;width:100%}',
  'code{background:#1b1814;padding:1px 6px;border-radius:4px;color:var(--gold);font-size:12px}',
  '.sub2{color:var(--txt-dim);font-size:12.5px;letter-spacing:1px;margin:14px 0 18px;text-align:center}',
  '</style></head><body>',

  /* ========== 视图一：选玩法（默认） ========== */
  '<div class="myview" id="viewPick">',
  '<div class="wheel-wrap"><div class="pointer"></div>',
  '<svg viewBox="0 0 120 120" aria-hidden="true"><g fill="none" stroke="#100e0b" stroke-width="1.5">',
  '<path d="M60 60 L60 6 A54 54 0 0 1 111.4 89.4 Z" fill="#c9452f"/>',
  '<path d="M60 60 L111.4 89.4 A54 54 0 0 1 8.6 89.4 Z" fill="#52b788"/>',
  '<path d="M60 60 L8.6 89.4 A54 54 0 0 1 60 6 Z" fill="#e8c26a"/>',
  '<path d="M60 60 L60 6 A54 54 0 0 1 111.4 89.4 Z" fill="#e5383b" opacity=".55" transform="rotate(72 60 60)"/>',
  '<path d="M60 60 L60 6 A54 54 0 0 1 111.4 89.4 Z" fill="#4d8fd6" opacity=".55" transform="rotate(144 60 60)"/>',
  '</g><circle cx="60" cy="60" r="54" fill="none" stroke="#e8c26a" stroke-width="2" opacity=".65"/>',
  '<circle cx="60" cy="60" r="15" fill="#100e0b" stroke="#e8c26a" stroke-width="1.5" opacity=".8"/>',
  '<text x="60" y="64" text-anchor="middle" font-size="12" fill="#e8c26a" font-family="sans-serif">命运</text>',
  '</svg></div>',
  '<h1>生 死 转 盘</h1><p class="sub">选一种玩法</p>',

  '<div class="card" id="btnSolo"><div class="ico">🎯</div><div class="t">',
  '<div class="nm">单人游戏 <small>不用连服务器</small></div>',
  '<div class="ds">死亡轮盘 · 本地开跑，7 滴血，走到第 100 转绝境即通关。</div>',
  '</div><div class="go">进 去</div></div>',

  '<div class="card" id="btnOnline"><div class="ico">👥</div><div class="t">',
  '<div class="nm">联机游戏 <small>要房主开服务端</small></div>',
  '<div class="ds">对赌轮盘 / 死神追猎 · 同一个 WiFi 直接搜到，异地的朋友填网址进。</div>',
  '</div><div class="go">进 去</div></div>',

  '<div class="hint"><b>要联机：</b>房主先在电脑上打开「生死转盘-服务端」，',
  '它会弹出一个<b>房主管理台</b>（只有开服务的那台电脑能打开）—— 穿透网址、房间码都在那里面设。<br>',
  '点上面「联机游戏」就会去搜局域网里的服务器。</div>',
  '<div class="foot">V17 · 规则由 engine.js 提供</div>',
  '</div>',

  /* ========== 视图二：找服务器（点联机后） ========== */
  '<div class="srv-wrap" id="viewSrv">',
  '<button class="backbtn" id="btnBackPick">← 返回 · 选玩法</button>',
  '<h1 style="font-size:22px">找 服 务 器</h1>',
  '<div class="sub2" id="srvSub">正在搜索局域网里的服务器…</div>',
  '<div class="list" id="list"></div>',
  '<div class="manual"><div class="t">异地加入 · 手动填地址</div>',
  '<div class="row"><input id="addr" placeholder="192.168.1.5:8080 / Tailscale 地址 / 穿透网址">',
  '<button class="go" id="go">连 接</button></div></div>',
  '<div class="tip">搜索靠局域网广播，所以<b>必须和房主在同一个 WiFi / 路由器下</b>。<br>',
  '不在一个网络时：<b>房主给什么就整条粘进来</b>（带 <code>https://</code> 也行，端口不用管）；<br>',
  '用 Tailscale 就填它的 <code>100.64.x.x:8080</code>。<br>',
  '房主那台电脑要双击 <code>生死转盘-服务端.exe</code>，并且防火墙弹窗点「允许」。</div>',
  '</div>',

  '<script>',
  'var viewPick=document.getElementById("viewPick"),viewSrv=document.getElementById("viewSrv");',
  'var el=document.getElementById("list"),sub=document.getElementById("srvSub");',
  'function esc(s){var d=document.createElement("div");d.textContent=String(s==null?"":s);return d.innerHTML}',

  /* 单人：让主进程去开 roulette-wheel.html —— 浏览器窗口打不开磁盘上另一个文件，
     必须走本机小服务的 /play-solo，由 Node 侧 spawn。 */
  'document.getElementById("btnSolo").onclick=function(){',
  '  fetch("/play-solo",{method:"POST"}).then(function(r){return r.json()}).then(function(j){',
  '    if(!j.ok&&j.error){alert("打不开单机页："+j.error)}}).catch(function(){alert("打不开单机页")})};',

  'document.getElementById("btnOnline").onclick=function(){',
  '  viewPick.classList.add("off");viewSrv.classList.add("on")};',
  'document.getElementById("btnBackPick").onclick=function(){',
  '  viewSrv.classList.remove("on");viewPick.classList.remove("off")};',

  'function render(ss){',
  '  el.innerHTML="";',
  '  if(!ss.length){sub.textContent="还没搜到服务器";',
  '    var d=document.createElement("div");d.className="empty";',
  '    d.innerHTML="这里会列出同一个 WiFi 下的服务器。<br>"+',
  '      "如果什么都没有：① 房主的电脑上还没双击「生死转盘-服务端.exe」；"+"② 你们不在同一个 WiFi；"+"③ 房主的防火墙弹窗被点了「取消」。";',
  '    el.appendChild(d);return}',
  '  sub.textContent="搜到 "+ss.length+" 台服务器 —— 点一台就能进";',
  '  ss.forEach(function(s){',
  '    var c=document.createElement("div");c.className="srvcard";',
  '    var l=document.createElement("div");',
  '    var n=document.createElement("div");n.className="nm";n.textContent=s.name||"未命名服务器";',
  '    var m=document.createElement("div");m.className="mt";',
  '    m.textContent=(s.id||"")+" · "+(s.players||0)+" 人 · "+(s.phase==="playing"?"对局中":"大厅中")+(s.needCode?" · 需房间码":"")+(s.modeLabel?" · "+s.modeLabel:"");',
  '    l.appendChild(n);l.appendChild(m);',
  '    var b=document.createElement("div");b.className="badge"+(s.phase==="playing"?"":" dim");',
  '    b.textContent=s.phase==="playing"?"进 去 观 战":"进 入";',
  '    c.appendChild(l);c.appendChild(b);',
  '    c.onclick=function(){open(s.host,s.port)};',
  '    el.appendChild(c)})}',
  'function open(host,port){',
  '  fetch("/open",{method:"POST",headers:{"Content-Type":"application/json"},',
  '    body:JSON.stringify({host:host,port:port})}).then(function(r){return r.json()}).then(function(j){',
  '    if(!j.ok){alert("打不开窗口："+(j.error||"未知原因"))}else{sub.textContent="已打开 "+(j.url||"")}})}',
  'document.getElementById("go").onclick=function(){',
  '  var v=document.getElementById("addr").value;',
  '  fetch("/open",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({raw:v})})',
  '    .then(function(r){return r.json()}).then(function(j){',
  '      if(!j.ok){alert("地址看不懂："+(j.error||""))}else{sub.textContent="已打开 "+(j.url||"")}})}',
  'function tick(){fetch("/servers").then(function(r){return r.json()}).then(function(j){render(j.servers||[])})',
  '  .catch(function(){sub.textContent="本地启动器已断开"})}',
  'tick();setInterval(tick,1500);',
  '</script></body></html>',
].join('\n');

/* ============================ ④ 本地服务 ============================ */

function startPicker(cb) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PICKER);
      return;
    }
    if (req.method === 'GET' && req.url === '/servers') {
      const body = JSON.stringify({ servers: listServers(), passive: state.passive });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }
    /* 单人模式（V17）：页面从哪来见上面的 soloSource() 注释。
       这里只负责「把窗口开出去」。 */
    /* V17：单人模式首选「本机小服务自己发页面」——
       打包成 exe 之后磁盘上没有 roulette-wheel.html，只能走这条路；
       而且 http 比 file:// 稳（不用赌中文路径在浏览器里的表现）。
       拿不到页面时才退回直接开磁盘上的 file://。 */
    if (req.method === 'POST' && req.url === '/play-solo') {
      let out = null;
      const src = soloSource();
      if (src) {
        const base = 'http://' + String(req.headers.host || '127.0.0.1');
        out = openGameWindow(base + '/solo');
        if (out.via) out.via += '（' + src.via + '）';
      } else {
        const soloPath = path.join(__dirname, 'roulette-wheel.html');
        out = openLocalFile(soloPath);
      }
      if (out.ok) console.log('  → 打开单机模式 ' + out.url + (out.via ? '（' + out.via + '）' : ''));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
      return;
    }
    if (req.method === 'GET' && req.url === '/solo') {
      const src = soloSource();
      if (!src) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(src.html);
      return;
    }
    /* 单人页用 <script src="engine.js"> 引引擎 —— 相对路径在这里落到 /engine.js */
    if (req.method === 'GET' && req.url === '/engine.js') {
      const src = soloSource();
      if (!src) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(src.engine);
      return;
    }
    if (req.method === 'POST' && req.url === '/open') {
      let raw = '';
      req.on('data', d => { raw += d; if (raw.length > 4096) req.destroy(); });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        let addr = null, secure = false;
        if (body.raw != null) {
          const p = parseAddr(body.raw);
          if (!p) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String(body.raw) }));
            return;
          }
          addr = p.addr;
          secure = p.secure;
        } else if (body.host) {
          addr = String(body.host) + ':' + (Number(body.port) || 8080);
          secure = !!body.secure;
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '没有地址' }));
          return;
        }
        /* 页面用什么协议打开，游戏页里的 WebSocket 就跟着走什么协议
           （https → wss，否则浏览器会以「混合内容」拦掉），所以这里绝不能硬拼 http:// */
        const url = (secure ? 'https' : 'http') + '://' + addr + '/client.html';
        const r = openGameWindow(url);
        console.log((r.ok ? '  → 打开 ' : '  ✗ 打不开 ') + url + (r.via ? '（' + r.via + '）' : ''));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  });

  /* 只绑回环：这是本机的启动器，绝不对局域网暴露 */
  server.listen(0, '127.0.0.1', () => {
    cb(server.address().port);
  });
  return server;
}

/* ============================ 启动 ============================ */

const startedAt = Date.now();

function banner(pickerPort) {
  console.log('');
  console.log('  生死转盘 · PC 客户端 v1');
  console.log('  ────────────────────────────────────────');
  console.log('  正在搜局域网里的服务器（走 UDP 广播）…');
  console.log('');
  console.log('  · 选择页：  http://127.0.0.1:' + pickerPort);
  console.log('  · 两条路同时找：' +
    (NO_ASK ? '只被动收心跳（RR_NO_ASK）' : '主动询问 + 被动收心跳') +
    '，被动收听' + (state.passive ? '已就绪' : '没绑上（不影响主动询问）'));
  console.log('  · 选中的服务器会用一个「没有地址栏的独立窗口」打开 ——');
  console.log('    游戏页直接从那台服务器加载，所以地址一个都不用输。');
  console.log('  · 搜不到？确认房主电脑上双击了「生死转盘-服务端.exe」，');
  console.log('    且你们在同一个 WiFi / 路由器下（公共 WiFi 常开 AP 隔离）。');
  console.log('  · 不在一个网络：用手动地址（Tailscale 等）。');
  console.log('  · 按 Ctrl+C 退出');
  console.log('');
  /* 打包 exe 后没有控制台，这段话只有 RR_DEBUG_WINDOW 才看得见；
     所以顺手把日志路径印出来，让玩家知道去哪找。 */
  console.log('  · 本次运行日志：  ' + LOG_FILE);
  if (DEBUG_WINDOW) {
    console.log('  · 这是 RR_DEBUG_WINDOW=1 开的**调试窗口** —— 关掉它客户端就没了。');
  }
  console.log('');
}

function main() {
  /* 双击 exe 时没有控制台，黑窗口也一并没了 —— 想看一眼输出就设
     RR_DEBUG_WINDOW=1，这里会开一个真控制台窗口重跑自己。 */
  if (DEBUG_WINDOW && !hasConsole() && reopenWithConsole()) {
    console.log('  （已开调试窗口，本进程退出）');
    process.exit(0);
  }

  passiveSock = startPassive();          // 第二条路先挂上，别漏掉头几波心跳
  discoverySock = startDiscovery();
  const server = startPicker(port => {
    banner(port);
    /* 把选择页也开成一个独立窗口 —— 双击 exe 之后就该直接看到界面 */
    if (!process.env.RR_DRY_OPEN && !process.env.RR_NO_OPEN) {
      /* 🔴 这里打开的是**我们自己的选择页**（就一个「找服务器」列表），
         不是游戏页。所以路径必须是 `/` —— 本机小服务只认 `/` 和 `/index.html`，
         写 `/client.html` 会命中它末尾的 404 分支，双击 exe 直接看到一片 404。
         （V16 事故：曾误改成 /client.html，把「服务端 / 改了」和「本机 / 改了」搞混。
           真正连上服务器之后，是 /open 里翻出的 http://<服务器>:<端口>/client.html，
           那个 /client.html 属于**对端服务端**，跟这里无关。） */
      openGameWindow('http://127.0.0.1:' + port + '/');
    }
  });

  /* 发现列表变化时在控制台也打一份，方便排障 */
  const beat = setInterval(() => {
    const ss = listServers();
    if (!ss.length) return;
    const line = ss.map(s => s.name + '(' + s.id + ' ' + s.host + ':' + s.port + ')').join('  |  ');
    if (line !== main.lastLine) { main.lastLine = line; console.log('  搜到：' + line); }
  }, 3000);
  if (beat.unref) beat.unref();

  process.on('SIGINT', () => {
    if (discoverySock) try { discoverySock.close(); } catch (e) {}
    if (passiveSock) try { passiveSock.close(); } catch (e) {}
    try { server.close(); } catch (e) {}
    console.log('\n已退出。');
    process.exit(0);
  });
}

/* 启动守卫。
   被测试 require 进来时不自动启动，方便单独测 normalizeAddr 等纯函数。
   打包成 exe 后由 build/build-pc-client.js 在文件最前面插入
   `const EMBEDDED_PC_CLIENT = true;` —— SEA 里 require.main 的归属
   不是明文保证的，所以这里用显式常量兜底，不赌运行时行为。 */
if (typeof EMBEDDED_PC_CLIENT !== 'undefined' || require.main === module) main();

module.exports = { normalizeAddr, parseAddr, listServers, startDiscovery, openGameWindow, openLocalFile, fileUrl, findBrowser };
