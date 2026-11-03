/* ============================================================
 * 生死转盘 · 联机客户端（client.html）端到端测试
 * ------------------------------------------------------------
 * 做法：起**真的服务器**（server.js 子进程），把 client.html 的内联脚本
 *       抠出来塞进「假 DOM」里跑，用 Node 内置的真 WebSocket 连上去，
 *       然后像真人一样点按钮，断言页面上显示的东西。
 *
 * 这证明的是三件事：
 *   ① 客户端能真的连上服务端，走完 大厅 → 对赌轮盘 → 死神追猎 → 结算 全流程；
 *   ② 客户端显示的一切都等于服务端推来的视图（没有一个数字是它自己算的）；
 *   ③ 客户端源码里**根本没有调用引擎的规则函数**（无 applyAction / createMatch）。
 *
 * 用法：node client-mp-test.js
 * ============================================================ */

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const ENGINE = require('./engine.js');
/* Node 22 起自带全局 WebSocket —— 测试里就用真的。
   换成假 WS 会掩盖一整类 bug：连错目标地址也照样"成功"（V18.3 就是这么漏的）。 */
const RealWS = globalThis.WebSocket;

/* 直接打服务端端口（V18.2：验「玩家上报日志」这条 HTTP 通路） */
function httpReq(port, urlPath, method, bodyObj) {
  return new Promise((res, rej) => {
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request({
      host: '127.0.0.1', port: port, path: urlPath, method: method || 'GET',
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
    }, r => {
      let b = '';
      r.on('data', d => { b += d.toString(); });
      r.on('end', () => {
        let j = null; try { j = JSON.parse(b); } catch (e) {}
        res({ status: r.statusCode, body: j, raw: b });
      });
    });
    req.on('error', rej);
    if (data) req.write(data);
    req.end();
  });
}

const DIR = __dirname;
const PORT_A = 8124;   // 双人局
const PORT_B = 8125;   // 单人局（确定性验证结算界面）
const PORT_C = 8126;   // 「大厅里离开房间」专用，独立起一台，免得动了 A/B 的编号
const PORT_D = 8127;   // 「房间码门禁」专用：这台带码，验「码错了改对再连一次」
const PORT_E = 8128;   // 「已连着再点一次」专用：A/B/C 前面都开过局，进了就是观战，不能复用
const PORT_F = 8129;   // ⑪ 专用：前面几台都被开过局（再进就是观战 / game-in-progress），这台是全新大厅

let PASS = 0, FAIL = 0;
function ok(name, cond, extra) {
  if (cond) { PASS++; console.log('  \u2713 ' + name); }
  else { FAIL++; console.log('  \u2717 ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms) {
  ms = ms || 8000;
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + label);
    await sleep(15);
  }
}

/* ---------------- 假 DOM ---------------- */
function makeEl(tag) {
  const el = {
    tag: tag || 'div', nodeType: 1, children: [], parent: null, style: {}, dataset: {},
    _cls: {}, _html: '', _txt: '', offsetWidth: 0, disabled: false, onclick: null, value: '',
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {},
    /* ⚠️ 这里必须像真浏览器一样较真。
       2026-09-24 的教训：client.html 的 buildWheel 里写成 `wheel.appendChild(t)`，
       而 t 是个坐标数组 —— 假 DOM 不校验、照收不误，452 条断言全绿，
       真浏览器却直接抛 TypeError，init() 第一行就崩，整个页面（PC + 手机）全废。
       所以：不是元素节点就直接抛，跟真 DOM 一个态度。 */
    appendChild(c) {
      if (!c || typeof c !== 'object' || c.nodeType !== 1) {
        throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
      }
      el.children.push(c); c.parent = el; return c;
    },
    insertBefore(c) {
      if (!c || typeof c !== 'object' || c.nodeType !== 1) {
        throw new TypeError("Failed to execute 'insertBefore' on 'Node': parameter 1 is not of type 'Node'.");
      }
      el.children.unshift(c); c.parent = el; return c;
    },
    /* 用 createElement + appendChild 建的结构（玩家卡片 / 名次 / 目标按钮）都是真儿子，查得到；
       用 innerHTML 写的那些查不到，返回一个占位元素即可（本客户端只往它身上挂 onclick）。 */
    querySelector(sel) {
      for (const c of el.children) {
        if (sel[0] === '.' ? c._cls[sel.slice(1)] : c.tag === sel) return c;
      }
      return makeEl(sel.replace(/^\./, ''));
    },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'className', {
    get() { return Object.keys(el._cls).join(' '); },
    set(v) { el._cls = {}; String(v).split(/\s+/).filter(Boolean).forEach(c => { el._cls[c] = true; }); },
  });
  el.classList = {
    add(c) { el._cls[c] = true; }, remove(c) { delete el._cls[c]; },
    contains(c) { return !!el._cls[c]; },
    /* V17：双视图切换（连接页 / 游戏页）用的是 toggle(name, force)。
       🔴 真 DOM 给了第二个参数时语义是「强制设成某个布尔」，**不是**取反 ——
          假 DOM 必须照这个语义写。若一律按取反实现，showView('game') 会把游戏页
          关掉、把连接页打开 —— 界面正好反过来，而且假 DOM 里根本不会报错。 */
    toggle(c, force) {
      const on = (force === undefined) ? !el._cls[c] : !!force;
      if (on) el._cls[c] = true; else delete el._cls[c];
      return on;
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = v; if (v === '') el.children = []; },
  });
  Object.defineProperty(el, 'textContent', {
    get() { return el._txt; },
    /* 真浏览器的 textContent 是 DOMString：赋数字会被强制转字符串 */
    set(v) { el._txt = String(v); },
  });
  Object.defineProperty(el, 'firstChild', { get() { return el.children[0] || null; } });
  return el;
}

/* ---------------- 一个「浏览器」 ---------------- */
function makeBrowser(port, inlineScript, opts) {
  opts = opts || {};
  const els = {};
  const byId = id => els[id] || (els[id] = makeEl(id === 'wheel' ? 'svg' : 'div'));
  /* 选择器缓存：同一串选择器返回**同一个**元素。
     不缓存的话每次调用都 new 一个空元素，页面往它身上写的 style / class 全丢进黑洞，
     断言读到的永远是初始值 —— 假 DOM 又一次"跑得通但什么也没验到"。 */
  const qsEls = {};
  const q = sel => qsEls[sel] || (qsEls[sel] = makeEl(sel.replace(/^\./, '')));
  /* opts.store = 预置「上次留下的东西」（目前用来模拟记住过的服务器地址 / 座位凭证） */
  const store = Object.assign({}, opts.store || {});
  /* 原生桥调用计数：用来断言「页面有没有主动让原生层开始扫描」 */
  const bridge = { discover: 0, stop: 0 };
  /* 每次 new WebSocket 的目标地址（含 ws:// wss:// 前缀） */
  const wsUrls = [];

  const sandbox = {
    console, Math, JSON, Object, Array, String, Number, Boolean, Date, Error, RegExp, Promise,
    /* Node 内置的真 WebSocket，外面包一层只为了两件事：
       ① 记下每次连的目标（V18.3 的 bug 是「点了卡片却连去别的地址」，
          不看真实 url 根本测不出来）；
       ② 🔴 补上真浏览器才有的行为：连不上时浏览器是 **error 之后必跟一个 close**，
          Node 内置的实现只给 error。不补这一刀，「连不上 → 自动重连」那段代码
          在测试里永远不会被触发 —— 等于它从来没被测过（赐红日志里撞了十几轮，
          测试却是全绿的，就是这么来的）。 */
    WebSocket: function (url, proto) {
      wsUrls.push(String(url));
      const s = new RealWS(url, proto);
      let closed = false;
      try {
        s.addEventListener('close', () => { closed = true; });
        /* 真浏览器里「域名解析不出来」也是 error + close 一起来；Node 内置实现
           对 DNS 失败常常只给 close。这一条只针对测试专用的假域名补 behavior，
           为的是让「猜错协议 → 换一种再试」那段真的跑到（它平时根本不被触发）。 */
        if (String(url).indexOf('nope.invalid') >= 0) {
          setTimeout(() => {
            if (typeof s.onerror === 'function') s.onerror({ type: 'error' });
            setTimeout(() => { if (!closed && typeof s.onclose === 'function') s.onclose({ code: 1006 }); }, 5);
          }, 5);
        }
        s.addEventListener('error', () => {
          /* 延后一点再补：真浏览器里 close 是紧跟 error 的下一个 tick，
             但晚于 error 本身。补太早会撞在 socket 还没 CLOSED 的时候。 */
          setTimeout(() => { if (!closed && typeof s.onclose === 'function') s.onclose({ code: 1006 }); }, 20);
        });
      } catch (e) {}
      return s;
    },
    /* opts.https = 模拟「朋友用 https 网址打开页面」（内网穿透那条路）。
       location.protocol 决定裸域名该走 wss 还是 ws —— V14 的核心判据之一。 */
    location: { host: '127.0.0.1:' + port, protocol: opts.https ? 'https:' : 'http:' },
    document: {
      body: makeEl('body'),
      getElementById: byId,
      createElement: makeEl,
      createElementNS: (ns, tag) => makeEl(tag),
      addEventListener() {},
      activeElement: null,
      /* V17：showView() 要用 document.querySelector('.hdr-tools') 收放顶部工具条。
         真浏览器当然有这个方法 —— 假 DOM 不提供的话，页面第一次切视图就 TypeError
         整页死掉，而这在发布前是最难发现的一类（只有真浏览器才崩）。 */
      querySelector: q,
    },
    getComputedStyle: () => ({ getPropertyValue: () => '#8d7538' }),
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    /* 定时器压缩：>=300ms 的等待压到 40ms。
       动画时长本来就不参与任何计算，压它不影响被测行为，只让测试跑得快。 */
    setTimeout: (fn, ms) => setTimeout(fn, (ms || 0) >= 300 ? 40 : (ms || 0)),
    clearTimeout: id => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: id => clearInterval(id),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.RREngine = ENGINE;

  /* opts.discover = 模拟「跑在原生壳里」（手机 App / PC 客户端）。
     真实契约：JS 调 window.RRNative.startDiscover()，原生扫完调 window.RR.onServers(json)。
     注意这里**不提供 get/set** —— 那是座位凭证桥，提供了会顶掉假 localStorage，
     跟本节要测的东西无关。 */
  if (opts.discover) {
    sandbox.RRNative = {
      startDiscover: function () { bridge.discover += 1; },
      stopDiscover: function () { bridge.stop += 1; },
    };
  }

  const sent = [];
  /* 注意：脚本里的 `let` 绑定不在全局对象上，外面改 sandbox.manualClose 是改不到的。
     所以把「改内部变量」的能力也一起塞进脚本作用域。 */
  const code = inlineScript + '\n;globalThis.__probe = function(){ return {'
    + ' view: view, myId: myId, joined: joined, playing: playing, queue: queue, rot: rot }; };\n'
    + 'globalThis.__ctl = {\n'
    + '  setManualClose: function(v){ manualClose = v; },\n'
    + '  connect: connect,\n'
    + '  normalizeAddr: normalizeAddr,\n'
    + '  parseAddr: parseAddr,\n'
    + '  altOf: altOf,\n'
    + '  canonicalOf: canonicalOf,\n'
    + '  closeWs: function(){ if (ws) { try { ws.close(); } catch (e) {} } },\n'
    + '  pendingAddr: function(){ return pendingAddr; },\n'
    + '  knownCards: function(){ return knownCards; },\n'
    + '  oplog: function(){ return oplog.slice(); },\n'
    + '  opExport: function(){ return opExport(); },\n'
    + '  remember: function(v){ try { SS.setItem(ADDR_KEY, v); } catch (e) {} },\n'
    + '};\n';
  vm.createContext(sandbox);
  /* 🔴 V18：页面脚本自己崩了，必须当场炸出来。
     之前没兜底的时候，脚本在中间崩掉表现为"后面某个 waitFor 超时"——
     看起来像网络问题，其实是页面从头到尾就没活过，排查要绕一大圈。 */
  try {
    vm.runInContext(code, sandbox, { filename: 'client-inline.js' });
  } catch (e) {
    throw new Error('❌ 页面内联脚本执行失败：' + e.message + '\n' + String(e.stack || '').split('\n').slice(0, 6).join('\n'));
  }

  /* 记录客户端发出的每一条消息（把全局 send 包一层） */
  const origSend = sandbox.send;
  sandbox.send = function (obj) { sent.push(obj); return origSend.apply(null, arguments); };

  /* 关掉灯泡动画（自递归 setTimeout，测试里没必要跑） */
  sandbox.bulbsRun = function () {};
  sandbox.bulbsStop = function () {};

  return {
    sandbox, byId, sent, store,
    probe: () => sandbox.__probe(),
    view: () => sandbox.__probe().view,
    me: () => { const v = sandbox.__probe().view; return v.match.players.find(p => p.id === sandbox.__probe().myId); },
    click(id) { const e = byId(id); if (e && e.onclick) e.onclick(); },
    text(id) { return byId(id).textContent; },
    logText() { return byId('log').children.map(c => c._html).join('\n'); },
    close() { sandbox.__ctl.closeWs(); },
    /* 关掉/恢复自动重连，并手动触发一次连接（模拟「他刷新页面回来了」） */
    holdOffline(v) { sandbox.__ctl.setManualClose(v); },
    reconnect() { sandbox.__ctl.connect(); },
    /* 原生桥：模拟「原生层扫完了」→ 走页面自己暴露的 window.RR.onServers */
    bridge,
    servers(list) { sandbox.RR.onServers(JSON.stringify(list)); },
    /* V18.2 操作日志（找 bug 用） */
    oplog() { return sandbox.__ctl.oplog(); },
    opExport() { return sandbox.__ctl.opExport(); },
    wsUrls: () => wsUrls.slice(),
    cards() { return byId('srvList').children; },
    clickCard(i) { const c = byId('srvList').children[i]; if (c && c.onclick) c.onclick(); return !!c; },
  };
}

/* 假 DOM 的元素带父引用，直接 JSON.stringify 会抛「循环结构」—— 只取卡片上的文字 */
function cardsText(cards) {
  return (cards || []).map(c => {
    const cols = (c && c.children && c.children[0] && c.children[0].children) || [];
    if (cols.length) return cols.map(x => String((x && x._txt) || '')).join(' · ');
    return String((c && c._txt) || '');        /* 提示行（srvempty）没有子结构 */
  }).join(' ;; ');
}

function fmtGold(n) {
  n = Number(n) || 0;
  if (n < 10000) return String(n);
  if (n < 100000000) return (n / 10000).toFixed(n < 100000 ? 1 : 0) + '万';
  return (n / 100000000).toFixed(1) + '亿';
}

/* ---------------- 服务器进程 ---------------- */
/* 存档指到临时文件：跑测试绝不能覆盖真实的对局存档 */
/* 🔴 同一次运行内要稳定（服务端重启靠它验"恢复"），跨运行必须唯一 ——
   只用 process.pid 会被 PID 复用坑到：捡回上一轮的脏存档，房间可能还停在"局中"。 */
const TMP_STATE = path.join(os.tmpdir(), 'rr-mp-test-' + process.pid + '-' + Date.now().toString(36));
/* code = 房间码（默认关掉）。
   V18.2 起 argv[3] 已经**只**管房间码了（管理端口挪到 argv[4] / RR_ADMIN_PORT），
   所以这里也可以用 `node server.js <port> <code>`；仍走环境变量只是因为它更直白，
   而且测试里同时要指定独立存档，env 一并传最省事。test-online.js 里专门有一节
   钉死「命令行带码启动得起、管理端口回默认」—— 别再把它改回去。 */
function startServer(port, code) {
  const child = spawn(process.execPath, [path.join(DIR, 'server.js'), String(port)], {
    cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'],
    /* V16.1：关掉默认房间码 584520 —— 这套端到端测试全程假设「无码直接进房」 */
    env: Object.assign({}, process.env,
      { RR_STATE: TMP_STATE + '-' + port + '.json', RR_ROOM_CODE: code || '' }),
  });
  let out = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { out += d.toString(); });
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (/本机打开/.test(out)) { clearInterval(iv); res({ child, log: () => out }); }
      else if (Date.now() - t0 > 8000) { clearInterval(iv); rej(new Error('服务器没起来：' + out)); }
    }, 60);
  });
}

/* 转一次并等它播完（转不了就返回 false）。
   注意必须等**服务端受理**（turnCount 增加）之后才算一轮结束 ——
   只看 !playing 会在服务端还没回应时就立刻返回，变成一口气狂发指令。 */
async function spinOnce(cli) {
  if (cli.byId('spinBtn').disabled) return false;
  const before = cli.probe().view.match.turnCount;
  cli.click('spinBtn');
  try {
    await waitFor(() => cli.probe().view.match.turnCount > before, '服务端受理这次转动', 6000);
    await waitFor(() => !cli.probe().playing, '动画播完', 8000);
  } catch (e) { return false; }
  return true;
}

/* 等客户端彻底空闲（动画播完 + 事件队列清空）。
   客户端的 tryBuy 在播放期间会自己 return —— 不等它空闲就点，等于没点。 */
async function ensureIdle(cli, label) {
  try {
    await waitFor(() => !cli.probe().playing && cli.probe().queue.length === 0, label || '客户端空闲', 8000);
  } catch (e) { /* 超时就往下走，让后续断言如实报错 */ }
}

/* ============================================================
 * 开跑
 * ============================================================ */
(async function main() {
  const html = fs.readFileSync(path.join(DIR, 'client.html'), 'utf8');
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const inlineScript = inline[inline.length - 1];

  /* ---------- 0. 静态产物 ---------- */
  console.log('\n\u2460 静态产物（客户端里没有规则）\n');
  ok('client.html 里找到唯一一段内联脚本', inline.length === 1, '找到 ' + inline.length + ' 段');
  ok('页面通过 <script src="engine.js">（相对路径）引入引擎',
    /<script\s+src=["']engine\.js["']/.test(html));
  /* 相对路径是硬要求：安卓壳用 file:///android_asset/www/ 加载本页，
     绝对路径 /engine.js 在 file:// 下会 404。这里钉死，防止被改回去。 */
  ok('引擎与图标都不得用绝对路径（安卓壳 file:// 加载不了）',
    !/<script\s+src=["']\//.test(html) && !/<link[^>]+href=["']\/(manifest|icon)/.test(html));
  ok('客户端没有调用 applyAction（不自己结算）', inlineScript.indexOf('applyAction') < 0);
  ok('客户端没有调用 createMatch（不自己开局）', inlineScript.indexOf('createMatch') < 0);
  ok('客户端没有内联血量常量', !/hpMax\s*[:=]\s*\d/.test(inlineScript));
  ok('客户端没有内联概率表', !/(30\s*,\s*30\s*,\s*10|probs\s*\()/.test(inlineScript));
  ok('客户端没有内联价格常量', !/price\s*[:=]\s*\d/.test(inlineScript));

  /* ---------- 0b. 首屏渲染 ----------
     这一节是 2026-09-24 那次事故补的：buildWheel 里 appendChild 拿错了变量，
     init() 第一行就抛异常，render() 从没执行过，大厅遮罩永久盖住连接栏 ——
     PC 和手机两端一起废掉。而当时 452 条断言全绿，因为假 DOM 不校验 appendChild 的类型。
     现在假 DOM 会像真浏览器一样抛错，这里再钉死「盘面真的画出来了」。 */
  console.log('\n\u2460b 首屏渲染（真渲染路径）\n');
  {
    const P = makeBrowser(PORT_A, inlineScript);
    const kids = P.byId('wheel').children;
    const paths = kids.filter(c => c.tag === 'path');
    const texts = kids.filter(c => c.tag === 'text');
    const labels = texts.map(t => t._txt);
    ok('init() 没抛异常、转盘画出 5 个扇形', paths.length === 5, '实际 ' + paths.length);
    ok('5 条事件文字都写进去了', labels.filter(s => s !== '命运').length === 5, JSON.stringify(labels));
    ok('中心毂（circle）与「命运」都在', kids.some(c => c.tag === 'circle') && labels.indexOf('命运') >= 0);

    /* 地址容错（2026-09-24 补）：服务端横幅印的是 http://ip:8080，
       用户整行复制进来会被拼成 ws://http://ip:8080 —— 必错。
       所以连接前必须把地址清洗成 host:port。 */
    const norm = P.sandbox.__ctl.normalizeAddr;
    ok('地址清洗：剥掉 http:// 前缀', norm('http://10.0.0.5:8080') === '10.0.0.5:8080', String(norm('http://10.0.0.5:8080')));
    ok('地址清洗：剥掉 ws:// 前缀', norm('ws://10.0.0.5:8080') === '10.0.0.5:8080', String(norm('ws://10.0.0.5:8080')));
    ok('地址清洗：裸 IP 自动补默认端口', norm('10.0.0.5') === '10.0.0.5:8080', String(norm('10.0.0.5')));
    ok('地址清洗：去掉尾斜杠与路径', norm('http://10.0.0.5:9000/') === '10.0.0.5:9000', String(norm('http://10.0.0.5:9000/')));
    ok('地址清洗：保留自定义端口', norm('10.0.0.5:3000') === '10.0.0.5:3000', String(norm('10.0.0.5:3000')));
    ok('地址清洗：空串 / 纯数字判为看不懂', norm('') === null && norm('12345') === null);

    /* ---------- 0b-2. 域名 / https（V14：异地接入那条路）----------
       局域网那套「见到没端口就补 8080」的规则，遇到公网域名会当场拼出死地址：
         https://xxx.cpolar.cn  →  xxx.cpolar.cn:8080   ← 穿透给的是 443，必连不上
       所以必须分三组：带协议头尊重协议、裸 IP 补 8080、裸域名跟随页面协议。 */
    const pa = P.sandbox.__ctl.parseAddr;
    const alt = P.sandbox.__ctl.altOf;
    const eq = (got, addr, secure) => !!got && got.addr === addr && got.secure === secure;

    ok('★ https 网址不再被补成 :8080（V14 判据一）',
      eq(pa('https://xxx.cpolar.cn'), 'xxx.cpolar.cn:443', true), JSON.stringify(pa('https://xxx.cpolar.cn')));
    ok('http 网址默认 80（不是 8080）',
      eq(pa('http://xxx.cpolar.cn'), 'xxx.cpolar.cn:80', false), JSON.stringify(pa('http://xxx.cpolar.cn')));
    ok('wss:// 认作加密，端口照抄',
      eq(pa('wss://xxx.cpolar.cn:9000'), 'xxx.cpolar.cn:9000', true), JSON.stringify(pa('wss://xxx.cpolar.cn:9000')));
    ok('ws:// 认作明文，端口照抄',
      eq(pa('ws://10.0.0.5:3000'), '10.0.0.5:3000', false), JSON.stringify(pa('ws://10.0.0.5:3000')));
    ok('裸 IP 仍然补 8080（局域网老行为不许退化）',
      eq(pa('192.168.1.5'), '192.168.1.5:8080', false), JSON.stringify(pa('192.168.1.5')));
    ok('Tailscale 地址（100.64.x.x）也补 8080',
      eq(pa('100.64.3.7'), '100.64.3.7:8080', false), JSON.stringify(pa('100.64.3.7')));
    ok('http 页面 + 裸域名 → 明文 80，且标记为「猜的」',
      eq(pa('xxx.cpolar.cn'), 'xxx.cpolar.cn:80', false) && pa('xxx.cpolar.cn').guessed === true,
      JSON.stringify(pa('xxx.cpolar.cn')));
    ok('裸 IP 不算「猜的」（局域网不存在协议歧义）', pa('192.168.1.5').guessed === false);
    ok('穿透网址带路径也要剥掉（整条粘进来是常态）',
      eq(pa('https://xxx.cpolar.cn/client.html'), 'xxx.cpolar.cn:443', true),
      JSON.stringify(pa('https://xxx.cpolar.cn/client.html')));
    ok('看不懂的仍然拒绝：空 / 纯数字 / 只有协议头 / 陌生协议',
      pa('') === null && pa('12345') === null && pa('http://') === null && pa('ftp://a.b.c') === null,
      JSON.stringify([pa(''), pa('12345'), pa('http://'), pa('ftp://a.b.c')]));

    /* 猜错了要能换另一种再试 —— 手机 App 里页面是 file://，推不出协议 */
    const guess = pa('xxx.cpolar.cn');
    ok('★ 猜错时的备选：换协议，自动补的端口一起换（80↔443）',
      alt(guess).secure === true && alt(guess).addr === 'xxx.cpolar.cn:443',
      JSON.stringify(alt(guess)));
    ok('端口是用户明写的 → 只换协议，不动端口',
      alt(pa('wss://a.b.cn:9000')).addr === 'a.b.cn:9000' && alt(pa('wss://a.b.cn:9000')).secure === false,
      JSON.stringify(alt(pa('wss://a.b.cn:9000'))));
    ok('存进 ADDR_KEY 的形式能还原「加密」这个事实',
      P.sandbox.__ctl.canonicalOf(pa('https://xxx.cpolar.cn')) === 'wss://xxx.cpolar.cn:443',
      String(P.sandbox.__ctl.canonicalOf(pa('https://xxx.cpolar.cn'))));

    /* 朋友用浏览器打开穿透给的 https 网址时，location.host 自动填进来的是**裸域名**；
       这时必须跟着页面走 wss，否则浏览器会以「混合内容」把连接直接拦掉。 */
    const PH = makeBrowser(PORT_A, inlineScript, { https: true });
    const pah = PH.sandbox.__ctl.parseAddr;
    ok('★ https 页面 + 裸域名 → 自动走 wss:443（V14 判据二）',
      !!pah('xxx.cpolar.cn') && pah('xxx.cpolar.cn').secure === true
      && pah('xxx.cpolar.cn').addr === 'xxx.cpolar.cn:443',
      JSON.stringify(pah('xxx.cpolar.cn')));

    ok('未连接时大厅遮罩不弹（弹了就会把连接栏永久盖住）',
      !P.byId('lobbyOverlay').classList.contains('show'));
    /* V15：地址框永远是空的 —— 界面上不出现任何 IP / 协议字符串。
       地址只活在内存里（pendingAddr），显示出来的永远是「名字」。 */
    ok('★ 地址框为空（不在界面上摊开 IP）', P.byId('addr').value === '',
      JSON.stringify(P.byId('addr').value));
    ok('本页服务器做成了卡片、地址进了内存', P.sandbox.__ctl.pendingAddr() === '127.0.0.1:' + PORT_A,
      String(P.sandbox.__ctl.pendingAddr()));
    ok('那张卡片显示的是名字，不是地址',
      /本页/.test(P.cards()[0].children[0].children[0]._txt || ''),
      JSON.stringify(P.cards()[0] && P.cards()[0].children[0].children[0]._txt));
    ok('大厅里有「离开房间」出口（否则进了大厅就够不到连接栏）',
      typeof P.byId('lobbyQuitBtn').onclick === 'function');
  }

  /* ---------- 0c. 入口页 · 服务器发现 ----------
     浏览器里的 JS 发不了 UDP 广播，所以「扫描」由原生层做、扫完通过桥把结果送回来。
     本节把这条契约钉死：有桥 → 主动扫描 + 收起手动框 + 卡片可点；
     无桥 → 只给说明 + 手动地址照旧可用。
     卡片 host/port 故意指向 127.0.0.1:1（必然连不上），免得真去连别的服务器。 */
  console.log('\n\u2460c 入口页 · 服务器发现（原生桥）\n');
  {
    const P = makeBrowser(PORT_A, inlineScript, { discover: true });
    ok('跑在原生壳里时 init() 会主动让原生层开始扫描', P.bridge.discover >= 1, 'discover=' + P.bridge.discover);
    ok('有扫描能力时「手动填地址」自动收起', P.byId('manualBox').open === false,
      'open=' + P.byId('manualBox').open);

    P.servers([
      { id: 'K7Q2-M4', name: '阿红的房间', host: '127.0.0.1', port: 1, players: 3, phase: 'playing', modeLabel: '对赌轮盘', needCode: false },
      { id: 'P3X9-Q1', name: '老王的局', host: '127.0.0.1', port: 1, players: 1, phase: 'lobby', modeLabel: '死神追猎', needCode: true },
    ]);
    /* 第 0 张是「本页就是这个服务器」（V15 起不用扫就知道的也会列出来），
       后面才是扫到的两台。 */
    const cards = P.cards();
    ok('原生回报后渲染出 3 张卡片（本页 1 + 扫到 2）', cards.length === 3, '实际 ' + cards.length);
    ok('★ 卡片上没有任何 IP / 协议字符串（V15 硬规矩）',
      !/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(cardsText(cards))
      && !/wss?:\/\//.test(cardsText(cards)), cardsText(cards));
    ok('卡片上写了服务器名', !!cards[1] && cards[1].children[0].children[0]._txt === '阿红的房间',
      cards[1] ? JSON.stringify(cards[1].children[0].children[0]._txt) : '(无卡片)');
    ok('卡片副标题含编号 / 人数 / 状态',
      !!cards[1] && /K7Q2-M4 · 3 人 · 对局中/.test(cards[1].children[0].children[1]._txt),
      cards[1] ? JSON.stringify(cards[1].children[0].children[1]._txt) : '(无卡片)');
    ok('要房间码的服务器在卡片上标出来了',
      !!cards[2] && /需房间码/.test(cards[2].children[0].children[1]._txt));

    P.clickCard(1);
    ok('点「不要码」的服务器 → 地址进了内存', P.sandbox.__ctl.pendingAddr() === '127.0.0.1:1',
      String(P.sandbox.__ctl.pendingAddr()));
    ok('★ 点完卡片地址框依然是空的（IP 不上界面）', P.byId('addr').value === '',
      JSON.stringify(P.byId('addr').value));
    ok('点「不要码」的服务器 → 不弹房间码浮层', !P.byId('codeOverlay').classList.contains('show'));
    /* 立刻掐掉重连：connect() 内部会把 manualClose 复位，所以必须在它之后再设 */
    P.holdOffline(true);

    const P2 = makeBrowser(PORT_A, inlineScript, { discover: true });
    P2.servers([{ id: 'P3X9-Q1', name: '老王的局', host: '127.0.0.1', port: 1, players: 1, phase: 'lobby', modeLabel: '死神追猎', needCode: true }]);
    P2.clickCard(1);
    ok('点「要码」的服务器 → 弹出房间码浮层', P2.byId('codeOverlay').classList.contains('show'));
    ok('浮层标题就是那台服务器的名字', P2.byId('codeTitle').textContent === '老王的局', P2.byId('codeTitle').textContent);
    ok('地址已预先放进内存（填完码就能连）', P2.sandbox.__ctl.pendingAddr() === '127.0.0.1:1',
      String(P2.sandbox.__ctl.pendingAddr()));
    P2.byId('codeInput').value = ' 7788 ';
    P2.click('codeYes');
    ok('填码确认后房间码进了连接参数（且去掉首尾空格）', P2.byId('pass').value === '7788', JSON.stringify(P2.byId('pass').value));
    P2.holdOffline(true);

    const P3 = makeBrowser(PORT_A, inlineScript);
    ok('纯浏览器：不会去调不存在的原生桥', P3.bridge.discover === 0);
    ok('纯浏览器：手动地址框保持展开（那是唯一入口）', P3.byId('manualBox').open !== false);
    const p3text = P3.byId('srvList')._html + cardsText(P3.cards());
    ok('纯浏览器：列表区给出「搜不了局域网」的说明',
      /发不了 UDP/.test(p3text), JSON.stringify(p3text.slice(0, 60)));
    ok('页面把回调暴露给了原生层（window.RR.onServers）',
      typeof P3.sandbox.RR === 'object' && typeof P3.sandbox.RR.onServers === 'function');
  }

  /* ---------- 0d. 记住上次那台 → 打开就直接进（V15） ----------
     赐红的原话：「地址记住后自动重连 —— 现在存了还要手点连接，改成上次连上过就直接进房间」。
     两条必须同时成立：① 打开就自己连；② 连不上要**停下来**把入口还给玩家，
     绝不能变成后台每 3 秒重试一次（那会让人以为卡死）。
     卡片 host 指向 127.0.0.1:1（必然连不上）就是为了让 ② 发生。 */
  console.log('\n\u2460d 记住上次那台 → 打开就自动进（V15）\n');
  {
    const P = makeBrowser(PORT_A, inlineScript, { store: { 'rr-addr': '127.0.0.1:1' } });
    ok('★ 记住的地址做成卡片、显示名字不显示地址',
      P.sandbox.__ctl.knownCards()[0] && P.sandbox.__ctl.knownCards()[0].name === '上次进过的房间'
      && !/\d+\.\d+\.\d+\.\d+/.test(cardsText(P.cards())),
      JSON.stringify(P.sandbox.__ctl.knownCards()) + ' / ' + cardsText(P.cards()));
    ok('地址进了内存、地址框依旧是空的',
      P.sandbox.__ctl.pendingAddr() === '127.0.0.1:1' && P.byId('addr').value === '',
      String(P.sandbox.__ctl.pendingAddr()) + ' / ' + JSON.stringify(P.byId('addr').value));

    /* 等自动连接跑完（init 里 150ms 后发起，连不上会走 giveUpAutoJoin） */
    await new Promise(r => setTimeout(r, 1200));
    const t1 = P.logText();
    ok('★ 打开就自己发起连接（不用点）', /正在连接|连接出错|没开着/.test(t1), t1.slice(0, 120));
    ok('★ 连不上时停下来把入口还给玩家，而不是后台死循环',
      /没开着/.test(t1), t1.slice(-160));
    /* 再等一轮：如果没停住，重连定时器（测试里被压到 40ms）会再打一串错误出来 */
    const n1 = (t1.match(/连接出错/g) || []).length;
    await new Promise(r => setTimeout(r, 800));
    const n2 = (P.logText().match(/连接出错/g) || []).length;
    ok('★ 放弃后不再反复重试', n2 <= n1 + 1 && n2 <= 2, '前 ' + n1 + ' 次 → 现在 ' + n2 + ' 次');
  }

  const srvA = await startServer(PORT_A);
  const srvB = await startServer(PORT_B);
  const srvC = await startServer(PORT_C);
  const srvD = await startServer(PORT_D, '7788');   // §⑨ 要用：带房间码的那台
  const srvE = await startServer(PORT_E);           // §⑨ ① 要用：全新大厅，没开过局
  const srvF = await startServer(PORT_F);           // ⑪ 要用：全新大厅（前面几台都开过局了）

  try {
    /* ---------- 1. 静态服务 ---------- */
    console.log('\n\u2461 静态服务\n');
    const r404 = await fetch('http://127.0.0.1:' + PORT_A + '/no-such-file');
    ok('未知路径返回 404', r404.status === 404);
    /* V16：/ 已经改成启动页（选单人 / 联机）了，联机页要显式点名。
       顺手把「/ 必须是启动页」也钉住 —— 以后谁再改回去，这条会红。 */
    const startRes = await fetch('http://127.0.0.1:' + PORT_A + '/');
    const startHtml = await startRes.text();
    ok('★ 访问 / 返回的是启动页（先选单人 / 联机）',
      startRes.status === 200 && /选一种玩法/.test(startHtml) && /btnSolo/.test(startHtml) && /btnOnline/.test(startHtml),
      'code=' + startRes.status);
    const rootRes = await fetch('http://127.0.0.1:' + PORT_A + '/client.html');
    const rootHtml = await rootRes.text();
    ok('访问 /client.html 返回联机客户端页面', rootRes.status === 200 && /生 死 转 盘/.test(rootHtml) && /engine\.js/.test(rootHtml));
    /* 入口页结构（2026-09-24 改版）：自动扫描列表 + 异地手输折叠区 */
    ok('入口页有「局域网里的服务器」列表区', /局域网里的服务器/.test(rootHtml) && /id="srvList"/.test(rootHtml));
    ok('入口页有「异地加入 · 手动填地址」折叠区', /异地加入/.test(rootHtml) && /id="manualBox"/.test(rootHtml));
    ok('入口页有房间码浮层与房主设置面板',
      /id="codeOverlay"/.test(rootHtml) && /id="cfgName"/.test(rootHtml) && /id="cfgCode"/.test(rootHtml));
    const engRes = await fetch('http://127.0.0.1:' + PORT_A + '/engine.js');
    ok('浏览器能取到 engine.js', engRes.status === 200 && /RREngine/.test(await engRes.text()));
    const soloRes = await fetch('http://127.0.0.1:' + PORT_A + '/roulette-wheel.html');
    ok('单机死亡轮盘页面也能一起服务', soloRes.status === 200);

    /* ---------- 2. 连接与大厅 ---------- */
    console.log('\n\u2462 连接与大厅\n');
    const A = makeBrowser(PORT_A, inlineScript);
    A.byId('name').value = '赐红';
    A.click('joinBtn');
    try {
      await waitFor(() => A.probe().joined, 'A 收到 welcome');
    } catch (e) {
      console.log('DIAG conn=' + JSON.stringify(A.text('conn'))
        + '\nDIAG sent=' + JSON.stringify(A.sent)
        + '\nDIAG log=' + A.logText().slice(0, 400)
        + '\nDIAG probe=' + JSON.stringify({ myId: A.probe().myId, joined: A.probe().joined }));
      throw e;
    }
    ok('A 显示「已连接」', A.text('conn') === '已连接', A.text('conn'));
    ok('A 拿到编号 1', A.probe().myId === '1', A.probe().myId);

    /* ---------- 2b. V17：连接独占一屏 ---------- */
    console.log('\n\u2461b V17 界面：连上之后搜索 / 地址栏整屏收走\n');
    ok('连上之后自动切到游戏视图（搜索栏不再占游戏页布局）',
      A.byId('gameView').classList.contains('on') && !A.byId('connectView').classList.contains('on'));
    ok('此时顶部那个入口写成「换服务器」', A.text('btnConnect') === '换服务器', A.text('btnConnect'));
    A.click('btnConnect');
    ok('点「换服务器」才回到连接视图',
      !A.byId('gameView').classList.contains('on') && A.byId('connectView').classList.contains('on'));
    ok('已经连着时给一条「返回游戏」的退路（别把人锁在连接页）',
      A.byId('cvBackBtn').style.display !== 'none', String(A.byId('cvBackBtn').style.display));
    A.click('cvBackBtn');
    ok('点返回就回游戏视图，而且连接没断',
      A.byId('gameView').classList.contains('on') && A.text('conn') === '已连接', A.text('conn'));

    ok('大厅浮层自动弹出', A.byId('lobbyOverlay').classList.contains('show'));
    ok('大厅阶段对局的 phase 就是 lobby（客户端一眼可分，不靠房间字段兜底）',
      A.view().match.phase === 'lobby', A.view().match.phase);
    ok('大厅里血量已经按当前模式摆好（默认死神追猎 10 血）',
      A.view().match.rules.hpMax === 10, A.view().match.rules.hpMax);
    ok('大厅显示 1 人', A.byId('lobbyList').children.length === 1, A.byId('lobbyList').children.length);
    ok('模式按钮来自服务端（2 个联机模式）', A.byId('lobbyModes').children.length === 2,
      A.byId('lobbyModes').children.length);
    const modeIds = A.byId('lobbyModes').children.map(b => b.dataset.mode).sort();
    ok('模式列表 = 对赌轮盘 + 死神追猎', JSON.stringify(modeIds) === JSON.stringify(['race', 'turn']),
      JSON.stringify(modeIds));
    ok('服务端不提供死亡轮盘（单人模式本地跑）', modeIds.indexOf('solo') < 0);
    ok('房主能点开始', A.byId('startBtn').disabled === false);

    const B = makeBrowser(PORT_A, inlineScript);
    B.byId('name').value = '阿黄';
    B.click('joinBtn');
    await waitFor(() => B.probe().joined, 'B 收到 welcome');
    ok('B 拿到编号 2', B.probe().myId === '2', B.probe().myId);
    ok('B 不是房主，开始按钮禁用', B.byId('startBtn').disabled === true);
    await waitFor(() => A.byId('lobbyList').children.length === 2, 'A 看到 B 进来');
    ok('A 看到房间里 2 人', A.byId('lobbyList').children.length === 2);
    ok('房主标记只挂在 A 身上',
      /房主/.test(A.byId('lobbyList').children[0]._html) && !/房主/.test(A.byId('lobbyList').children[1]._html));

    /* ---------- 3. 对赌轮盘 ---------- */
    console.log('\n\u2463 对赌轮盘（共享轮盘 · 15 血 · 镰刀看全局转数）\n');
    A.byId('lobbyModes').children.find(b => b.dataset.mode === 'turn').onclick();
    await waitFor(() => A.view().room.mode === 'turn', '切到对赌轮盘');
    ok('模式标识显示「对赌轮盘」', /对赌轮盘/.test(A.text('modePill')), A.text('modePill'));

    A.click('startBtn');
    await waitFor(() => A.view().match.phase === 'playing', '开局');
    ok('开局后大厅浮层收起', !A.byId('lobbyOverlay').classList.contains('show'));
    ok('轮到 A（A 是第 1 位）', /轮 到 你 了/.test(A.text('turnbar')), A.text('turnbar'));
    ok('玩家卡片 2 张', A.byId('players').children.length === 2, A.byId('players').children.length);
    ok('血量显示服务端给的 15', A.text('myHp') === '15 / 15', A.text('myHp'));
    ok('血量上限来自服务端规则', A.view().match.rules.hpMax === 15, A.view().match.rules.hpMax);

    /* ---------- 3a. V17：全员血量并排钉在顶部 ---------- */
    console.log('\n\u2463a V17 界面：血量对比搬到轮盘上方\n');
    const stripA = A.byId('hpStrip');
    ok('顶部血条条一人一格（2 人局就是 2 格）', stripA.children.length === 2, stripA.children.length);
    ok('格子写明是谁', /赐红/.test(stripA.children[0]._html) && /阿黄/.test(stripA.children[1]._html),
      stripA.children[0]._html);
    ok('格子给出「当前 / 上限」而不是一句文案', /15\/15/.test(stripA.children[0]._html));
    ok('我那一格带 .me 标记', stripA.children[0]._cls.me === true);
    ok('满血时用 .ok（绿）而不是 .warn（告警）',
      stripA.children[0]._cls.ok === true && !stripA.children[0]._cls.warn);
    ok('房间里的卡片不再重复一条血条（血量只留顶部一处）',
      !/hpbar/.test(A.byId('players').children[0]._html), A.byId('players').children[0]._html.slice(0, 80));
    ok('镰刀档位条列出 71 / 81 / 91',
      /71 转起/.test(A.byId('tiers').innerHTML) && /91 转起/.test(A.byId('tiers').innerHTML));
    ok('商场只有两件：护符 / 药水（对赌轮盘已移除「减少转数」）',
      JSON.stringify(A.sandbox.meShop().map(s => s.id)) === JSON.stringify(['charm', 'potion']),
      JSON.stringify(A.sandbox.meShop().map(s => s.id)));
    ok('护符价格 100（来自服务端）', A.sandbox.meShop()[0].price === 100, A.sandbox.meShop()[0].price);
    ok('商城 DOM 里也不再出现「减少转数」',
      !/减少转数/.test(A.byId('shop').innerHTML), A.byId('shop').innerHTML.slice(0, 120));

    const rotBefore = A.probe().rot;
    A.click('spinBtn');
    await waitFor(() => A.view().match.k === 1, 'A 的第 1 转落地');
    await waitFor(() => A.probe().rot !== rotBefore, '转盘真的转了');
    ok('A 转动后转盘角度确实变了', A.probe().rot !== rotBefore, rotBefore + ' → ' + A.probe().rot);
    await waitFor(() => !A.probe().playing, '动画队列播完');
    ok('记录里出现「掷出」', /掷出/.test(A.logText()));
    ok('共享轮盘读数推到 1', A.view().match.k === 1, A.view().match.k);
    ok('轮到 B 了', /等待 阿黄/.test(A.text('turnbar')), A.text('turnbar'));
    ok('A 的按钮被禁用（UI 层就拦住了）', A.byId('spinBtn').disabled === true);
    ok('A 的按钮文案变成「等待对手」', A.text('spinBtn') === '等 待 对 手', A.text('spinBtn'));

    /* 越权转动：绕过按钮直接把 spin 发给服务端（模拟改过客户端的玩家） */
    const aSpinsBefore = A.me().spins, aKBefore = A.view().match.k;
    A.sandbox.send({ type: 'spin' });
    await waitFor(() => /还没轮到你/.test(A.logText()), 'A 抢转被拒');
    ok('绕过按钮硬发指令，服务端照样拒绝', /服务器拒绝：还没轮到你/.test(A.logText()));
    ok('被拒后共享轮盘读数没有变化', A.view().match.k === aKBefore, A.view().match.k);
    ok('被拒后 A 的转数没有变化', A.me().spins === aSpinsBefore, A.me().spins);

    await waitFor(() => /轮 到 你 了/.test(B.text('turnbar')), 'B 的回合');
    B.click('spinBtn');
    await waitFor(() => B.view().match.k === 2, 'B 的第 1 转落地');
    await waitFor(() => !B.probe().playing, 'B 的动画播完');
    ok('B 转动成功，轮盘读数累加到 2', B.view().match.k === 2, B.view().match.k);

    const pa = A.me();
    ok('DOM 生命 === 服务端生命', A.text('myHp') === pa.hp + ' / 15', A.text('myHp') + ' vs ' + pa.hp);
    ok('DOM 金币 === 服务端金币', A.text('myGold') === fmtGold(pa.gold), A.text('myGold') + ' vs ' + pa.gold);
    ok('DOM 读数 === 服务端读数', A.text('myReadout') === String(pa.readout), A.text('myReadout'));

    /* 没钱 → 买被拒 */
    if (pa.gold < 100) {
      A.sandbox.tryBuy(A.sandbox.meShop()[0]);
      await waitFor(() => /金币不够/.test(A.logText()), '没钱的购买被拒');
      ok('金币不够时购买被拒，记录里说人话', /服务器拒绝：金币不够/.test(A.logText()));
      ok('被拒后护符数量没变', A.me().charms === 0, A.me().charms);
    } else {
      ok('金币不够时购买被拒，记录里说人话', false, '本轮恰好有钱，无法构造该场景');
      ok('被拒后护符数量没变', false, '同上');
    }

    /* ---------- 掉线封存 / 重连恢复 ---------- */
    console.log('\n\u2463b 掉线封存 · 正在恢复你的角色\n');
    const kBeforeFrozen = A.view().match.k;
    const hpBeforeFrozen = A.me().hp;

    /* 让 B 真的掉线：先关掉它的自动重连，再断 socket */
    B.holdOffline(true);
    B.close();
    await waitFor(() => A.view().match.frozen === true, 'A 看到封存');

    ok('A 的界面上出现封存提示条', A.byId('freezeBar').classList.contains('show'));
    ok('提示条点名是谁掉线', /阿黄/.test(A.byId('freezeWho').innerHTML), A.byId('freezeWho').innerHTML);
    ok('提示条说明「暂停计时与结算」', /暂停/.test(A.byId('freezeWho').innerHTML));
    ok('回合条也改成封存语气', /封存/.test(A.text('turnbar')), A.text('turnbar'));
    ok('转动按钮禁用', A.byId('spinBtn').disabled === true);
    ok('转动按钮文案变成「已封存」', A.text('spinBtn') === '已 封 存', A.text('spinBtn'));
    ok('掉线的人卡片上打了「掉线」标记',
      /掉线/.test(A.byId('players').children.map(c => c._html).join('')));
    ok('房主能看到「放弃本局」出口', A.byId('giveUpBtn').style.display !== 'none');

    /* 绕过禁用的按钮硬发指令：服务端也必须拒 */
    A.sandbox.send({ type: 'spin' });
    await waitFor(() => /服务器拒绝：赌局已封存/.test(A.logText()), '封存期间硬发指令被拒');
    ok('封存期间绕过按钮硬发指令，服务端照样拒绝',
      /服务器拒绝：赌局已封存/.test(A.logText()));
    ok('客户端确实把这条指令发出去了（不是被自己拦下的）',
      A.sent.filter(m => m.type === 'spin').length >= 2, JSON.stringify(A.sent.map(m => m.type)));
    ok('封存期间读数不变', A.view().match.k === kBeforeFrozen, A.view().match.k);
    ok('封存期间血量不变', A.me().hp === hpBeforeFrozen, A.me().hp);

    /* 商场按钮也要停 */
    ok('封存期间商场按钮全部禁用',
      A.byId('shop').children.every(c => !c.children[2] || c.children[2].disabled !== false));

    /* B 回来 —— 走真实的恢复流程：本地凭证换回原座位 */
    B.holdOffline(false);
    B.reconnect();
    await waitFor(() => B.probe().joined && B.probe().myId === '2', 'B 重新入座', 6000);
    ok('B 用本地凭证回到原来的编号（没有变成新人）', B.probe().myId === '2', B.probe().myId);
    ok('B 的记录里出现「正在恢复你的角色」', /正在恢复你的角色/.test(B.logText()), B.logText().slice(-200));
    ok('B 的记录里确认「已恢复你的角色」', /已恢复你的角色/.test(B.logText()));
    ok('B 的连接状态显示「已恢复」', B.text('conn') === '已恢复', B.text('conn'));

    await waitFor(() => A.view().match.frozen === false, 'A 看到解封');
    ok('封存提示条自动收起', !A.byId('freezeBar').classList.contains('show'));
    ok('解封后掉线标记消失',
      !/掉线/.test(A.byId('players').children.map(c => c._html).join('')));
    ok('解封后读数没有因掉线被推进', A.view().match.k === kBeforeFrozen, A.view().match.k);
    await waitFor(() => /解封：全员到齐/.test(A.logText()), 'A 的记录里播出解封');
    ok('记录里播报了解封', /解封：全员到齐/.test(A.logText()), A.logText().slice(0, 200));

    /* 谁的回合没变，照旧能继续 */
    await waitFor(() => !A.byId('spinBtn').disabled || !B.byId('spinBtn').disabled, '解封后有人能行动');
    ok('解封后按钮恢复可点（回合没被掉线搞乱）',
      !A.byId('spinBtn').disabled || !B.byId('spinBtn').disabled);

    /* 把这一轮收尾，保持后面的流程不变（当前应轮到 A） */
    if (!A.byId('spinBtn').disabled) {
      const kk = A.view().match.k;
      A.click('spinBtn');
      await waitFor(() => A.view().match.k > kk, '解封后的第一转');
      await waitFor(() => !A.probe().playing, '动画播完');
    }

    /* 回大厅 */
    A.sandbox.send({ type: 'reset' });
    await waitFor(() => A.view().room.phase === 'lobby', '回到大厅');
    ok('回大厅后浮层复现', A.byId('lobbyOverlay').classList.contains('show'));
    ok('回大厅后血量恢复成新对局的 15', A.text('myHp') === '15 / 15', A.text('myHp'));

    /* ---------- 4. 死神追猎 ---------- */
    console.log('\n\u2464 死神追猎（各自轮盘 · 10 血 · 100 转比用时）\n');
    A.byId('lobbyModes').children.find(b => b.dataset.mode === 'race').onclick();
    await waitFor(() => A.view().room.mode === 'race', '切到死神追猎');
    ok('模式标识显示「死神追猎」', /死神追猎/.test(A.text('modePill')), A.text('modePill'));
    A.click('startBtn');
    await waitFor(() => A.view().match.phase === 'playing', '死神追猎开局');
    ok('死神追猎血量 10', A.text('myHp') === '10 / 10', A.text('myHp'));
    ok('我的面板出现「目标进度 0 / 100」', A.text('myProgress') === '0 / 100', A.text('myProgress'));
    ok('我的面板出现「用时」', /秒/.test(A.text('myTime')), A.text('myTime'));
    ok('读数标成「我的转数」（各自轮盘）', A.byId('myReadoutK').textContent === '我的转数',
      A.byId('myReadoutK').textContent);
    ok('商城换成 护符 / 药水 / 香蕉皮',
      JSON.stringify(A.sandbox.meShop().map(s => s.id)) === JSON.stringify(['charm', 'potion', 'banana']),
      JSON.stringify(A.sandbox.meShop().map(s => s.id)));
    ok('死神追猎买不到「减少转数」', A.sandbox.meShop().every(s => s.id !== 'rewind'));
    ok('香蕉皮标了 needTarget', A.sandbox.meShop().find(s => s.id === 'banana').needTarget === true);
    ok('香蕉皮价格 150', A.sandbox.meShop().find(s => s.id === 'banana').price === 150);
    await waitFor(() => !A.probe().playing, '开局演出播完');
    ok('不需要等轮次，A 直接就能转', A.text('spinBtn') === '转 动', A.text('spinBtn'));

    A.click('spinBtn');
    await waitFor(() => A.me().spins === 1, 'A 自己转了一次');
    await waitFor(() => !A.probe().playing, 'A 动画播完');
    ok('A 的转数涨到 1（各自轮盘）', A.me().spins === 1, A.me().spins);
    ok('B 的转数仍是 0（没有被 A 带着走）', B.me().spins === 0, B.me().spins);
    ok('进度显示跟着涨', A.text('myProgress') === '1 / 100', A.text('myProgress'));

    /* 攒钱：一路转到买得起护符 + 香蕉皮（各自轮盘，可以连续转）。
       两个必须防的点：
         · 退出条件看「钱到位」而不是「转了多少轮」—— 每次转动前后会有若干次空转
           （按钮被动画/队列占住），按轮数计预算会随运气提前退出；
         · 死神追猎里 A 可能真的被打死 —— 那就重开一局再攒，最多试 3 次。 */
    let boughtCharm = false, iter = 0, attempt = 0;
    while (attempt < 3) {
      attempt++;
      boughtCharm = false; iter = 0;
      while (iter++ < 400 && A.view().match.phase === 'playing' && A.me().spins < 66
        && !(boughtCharm && A.me().gold >= 150)) {
        const m = A.me();
        if (m.hp <= 3 && m.potions > 0) { A.sandbox.send({ type: 'usePotion' }); await sleep(30); continue; }
        if (m.gold >= 300 && m.potions < 2 && m.hp <= 6) {
          A.sandbox.tryBuy(A.sandbox.meShop().find(s => s.id === 'potion')); await sleep(30); continue;
        }
        /* 护符留出买香蕉皮的钱（250 买完还剩 150） */
        if (!boughtCharm && m.gold >= 250) {
          const before = m.charms;
          await ensureIdle(A, '买护符前等空闲');
          A.sandbox.tryBuy(A.sandbox.meShop().find(s => s.id === 'charm'));
          try { await waitFor(() => A.me().charms === before + 1, '买到护符', 3000); boughtCharm = true; } catch (e) {}
          continue;
        }
        if (!(await spinOnce(A))) await sleep(60);
      }
      if (A.view().match.phase === 'playing' && boughtCharm && A.me().gold >= 150) break;

      /* 还没攒够就结束了（被打死）→ 回大厅重开一局再来 */
      A.sandbox.send({ type: 'reset' });
      await waitFor(() => A.view().room.phase === 'lobby', '重开：回大厅');
      A.byId('lobbyModes').children.find(b => b.dataset.mode === 'race').onclick();
      await waitFor(() => A.view().room.mode === 'race', '重开：选死神追猎');
      A.click('startBtn');
      await waitFor(() => A.view().match.phase === 'playing', '重开：开局');
      await ensureIdle(A, '重开：等开局演出');
      console.log('    [dbg] A 被打死了，第 ' + attempt + ' 次重开');
    }

    ok('钱够了以后，买护符成功（护符 +1）', boughtCharm, 'gold=' + A.me().gold + ' spins=' + A.me().spins);
    ok('买护符真的扣了钱（服务端结算）', /买了 免死护符/.test(A.logText()));
    ok('记录里出现了「死神利息」（经济系统在跑）', /死神利息/.test(A.logText()));
    ok('转了多少次，服务端就记了多少次（无本地伪计数）',
      A.me().spins >= 1 && A.text('myProgress') === A.me().spins + ' / 100',
      A.me().spins + ' / ' + A.text('myProgress'));

    /* 香蕉皮：走客户端的目标选择流程 */
    await ensureIdle(A, '买香蕉皮前等空闲');
    const goldBefore = A.me().gold;
    if (goldBefore >= 150) {
      A.sandbox.tryBuy(A.sandbox.meShop().find(s => s.id === 'banana'));
      ok('点香蕉皮会弹出目标选择浮层', A.byId('targetOverlay').classList.contains('show'));
      const tgts = A.byId('targetGrid').children;
      ok('目标列表里只有对手（不含自己）', tgts.length === 1 && /阿黄/.test(tgts[0]._html), tgts.length);
      ok('目标列表里带上对手战况，方便决策', /进度/.test(tgts[0]._html));

      tgts[0].onclick();
      await waitFor(() => B.me().bananas === 5, '香蕉皮生效');
      ok('选中对手后，对手身上挂上香蕉皮', B.me().bananas === 5, B.me().bananas);
      ok('香蕉皮扣了 150 金', goldBefore - A.me().gold === 150, goldBefore + ' → ' + A.me().gold);
      ok('记录里播报了扔香蕉皮', /香蕉皮/.test(A.logText()));
      ok('被扔的人自己的卡片上出现 🍌 标记',
        /🍌/.test(B.byId('players').children.map(c => c._html).join('')));
      ok('客户端把 targetId 转发给了服务端',
        A.sent.some(m => m.type === 'buy' && m.itemId === 'banana' && m.targetId === '2'));

      /* 被扔的人转一次：转数不涨，但转盘照旧转、照旧结算 */
      const b0 = B.me();
      const bSpins = b0.spins, bGold = b0.gold, bHp = b0.hp;
      const rotBefore = B.probe().rot;
      B.click('spinBtn');
      await waitFor(() => B.me().bananas === 4, '香蕉皮消耗一次');
      await waitFor(() => !B.probe().playing, 'B 的动画播完');
      const b1 = B.me();
      ok('踩到香蕉皮：转数不涨', b1.spins === bSpins, bSpins + ' → ' + b1.spins);
      /* 注意：满血时掷出「加血」数值本来就不该变 —— 那是机制正确，不是没结算。
         所以这里只断言「转盘真的转过了」（角度确实变了），不押注在血/金必变。
         数值层面的效果由 engine-modes-test.js 用固定随机流精确验证。 */
      ok('但转盘照常转动结算（不是点了没反应）', B.probe().rot !== rotBefore,
        JSON.stringify({ rot: [rotBefore, B.probe().rot], gold: [bGold, b1.gold], hp: [bHp, b1.hp] }));
      ok('被扔的人自己也能看到「踩到香蕉皮」', /踩到香蕉皮/.test(B.logText()));
      ok('被扔的人进度条也没有涨',
        B.text('myProgress') === bSpins + ' / 100', B.text('myProgress'));

      /* 「叠加」在引擎测试里用纯规则验（engine-modes-test.js），这里不再为了凑钱
         多转十几轮 —— 每多转一轮，A 被打死的概率就多一分，测试就会变脆。 */
    } else {
      ['点香蕉皮会弹出目标选择浮层', '目标列表里只有对手（不含自己）', '目标列表里带上对手战况，方便决策',
        '选中对手后，对手身上挂上香蕉皮', '香蕉皮扣了 150 金', '记录里播报了扔香蕉皮',
        '被扔的人自己的卡片上出现 🍌 标记', '客户端把 targetId 转发给了服务端', '踩到香蕉皮：转数不涨',
        '但转盘照常转动结算（不是点了没反应）', '被扔的人自己也能看到「踩到香蕉皮」',
        '被扔的人进度条也没有涨']
        .forEach(n => ok(n, false, '没攒够 150 金（gold=' + goldBefore + ' spins=' + A.me().spins + '）'));
    }

    /* ---------- 5. 客户端只发指令 ---------- */
    console.log('\n\u2465 客户端只发指令，不发状态\n');
    const allowed = ['join', 'setMode', 'start', 'reset', 'spin', 'buy', 'usePotion'];
    const allSent = A.sent.concat(B.sent);
    const bad = allSent.map(m => m.type).filter(t => allowed.indexOf(t) < 0);
    ok('客户端发出的消息类型全部在白名单内', bad.length === 0, JSON.stringify(bad));
    ok('确实发过 spin / buy / setMode 等指令',
      allSent.some(m => m.type === 'spin') && allSent.some(m => m.type === 'buy')
      && allSent.some(m => m.type === 'setMode'));
    ok('客户端从不发送 hp / gold / spins 这类状态字段',
      !allSent.some(m => 'hp' in m || 'gold' in m || 'spins' in m));

    /* ---------- 6. 退出本局 · 观战 ---------- */
    console.log('\n\u2465b 退出本局 · 观战（客户端）\n');
    /* 🔴 先把事件队列压起来 —— 这是能不能测出「回到大厅吃掉后面演出」的关键。
       队列是从头往后播的，一次转动要吐好几条事件（roll / gold / interest…），
       连点几下不等动画播完就一定会有积压。机器快的时候积压会自动消失，
       只留这几行等"看起来都对"是抓不到那个 bug 的。 */
    let backlog = 0;
    for (let i = 0; i < 8 && backlog < 2; i++) {
      if (!A.byId('spinBtn').disabled) A.click('spinBtn');
      await sleep(25);
      backlog = A.probe().queue.length;
    }
    ok('连点几次之后，事件确实排在队列里等播（演出有积压）',
      backlog >= 2, '队列长度 ' + backlog);

    A.sandbox.send({ type: 'reset' });
    await waitFor(() => A.view().room.phase === 'lobby', '先回大厅');
    A.click('startBtn');
    await waitFor(() => A.view().match.phase === 'playing', '重开一局');
    /* 积压状态下回到大厅：那一步若再清队列，"赌局开始"就会被吃掉，
       玩家看到的是：回到大厅之后界面一直是空的、像卡住了一样。
       🔴 先等「回到大厅」真的播出来（它会清空记录），再看新的记录补不补得上 ——
       不等这一步就直接找「赌局开始」，命中的是上一局留在记录里的那条，断言等于没写。 */
    await waitFor(() => /回到大厅/.test(A.logText()), '回到大厅这一步真的播出来（记录被清空）', 15000);
    /* 🔴 等的是「队列播完」这个确定性条件，不是墙钟：
       积压有多深取决于机器快慢，拿固定秒数去赌，快机器过得去、慢机器偶发假红。
       队列一旦排空，所有该播的都已经播完 —— 这时候记录里缺了什么就是真丢了。 */
    await waitFor(() => A.probe().queue.length === 0 && !A.probe().playing,
      '重开一局后演出播完', 40000);
    ok('★ 队列积压时回到大厅，不会吃掉紧随其后的「赌局开始」',
      /赌\s*局\s*开\s*始/.test(A.logText()), A.logText().slice(0, 160));

    ok('对局中「我」面板下出现「退出本局」按钮',
      A.byId('myRoleBox').children.length >= 1 &&
      /退 出 本 局/.test(A.byId('myRoleBox').children[0].textContent),
      JSON.stringify(A.byId('myRoleBox').children.map(c => c.textContent)));

    /* 新人中途进房：先给「要不要观战」的选择，而不是硬拒 */
    const D = makeBrowser(PORT_A, inlineScript);
    D.byId('name').value = '路人';
    D.click('joinBtn');
    await waitFor(() => D.byId('spectateOverlay').classList.contains('show'), 'D 收到观战邀请');
    ok('对局中进房弹出「对局进行中 · 进入观战」浮层',
      D.byId('spectateOverlay').classList.contains('show'));
    ok('浮层里写清了是哪个模式、场上都有谁',
      /对赌轮盘|死神追猎/.test(D.byId('spectateSub').innerHTML)
      && /场上/.test(D.byId('spectateSub').innerHTML),
      D.byId('spectateSub').innerHTML.slice(0, 90));
    ok('记录里也说明了为什么进不去', /对局已开始/.test(D.logText()), D.logText().slice(0, 160));

    D.click('spectateYes');
    await waitFor(() => D.probe().joined && D.probe().view.watchers.length === 1, 'D 以观战身份进入');
    ok('选择观战后真的进了房间（拿到观战席）', D.probe().view.watchers.some(w => w.name === '路人'),
      JSON.stringify(D.probe().view.watchers.map(w => w.name)));
    ok('观战不算选手（场上人数没变）', D.probe().view.match.players.length === 2,
      String(D.probe().view.match.players.length));
    ok('观战者的「我」面板收起来了', D.byId('myStats').style.display === 'none');
    ok('观战者的标题打上「观战」标记', /观战/.test(D.text('myRoleTag')), D.text('myRoleTag'));
    ok('观战者浮出观战提示条', D.byId('watchBar').classList.contains('show'));
    ok('观战提示条写明「看得到、动不了」', /转不了盘/.test(D.byId('watchWho').innerHTML),
      D.byId('watchWho').innerHTML.slice(0, 90));
    ok('观战者的转动按钮变成「观 战 中」', D.text('spinBtn') === '观 战 中', D.text('spinBtn'));
    ok('观战者的商场写明不能购物', /观战/.test(D.byId('shop')._html),
      String(D.byId('shop')._html).slice(0, 60));
    ok('观战者「我」面板里就有退出观战的出口',
      /退 出 观 战/.test(D.byId('myRoleBox').children.map(c => c.textContent).join('')),
      JSON.stringify(D.byId('myRoleBox').children.map(c => c.textContent)));

    /* A 退出本局 → 转观战（场上只剩 B，所以本局当场定局） */
    A.byId('myRoleBox').children[0].onclick();
    ok('点「退出本局」先弹确认浮层', A.byId('leaveOverlay').classList.contains('show'));
    ok('确认浮层把后果说清楚（只剩一人时对方直接获胜）',
      /他直接获胜/.test(A.byId('leaveWarn').innerHTML), A.byId('leaveWarn').innerHTML);
    A.click('leaveYes');
    await waitFor(() => !A.view().match.players.some(p => p.id === '1'), 'A 不再是对局选手');
    ok('退出后自己不在对局名单里了', !A.view().match.players.some(p => p.id === '1'));
    ok('退出后自己出现在观战名单里', A.view().watchers.some(w => w.id === '1'),
      JSON.stringify(A.view().watchers.map(w => w.id)));
    ok('只剩一个人 → 本局立刻定局', A.view().match.phase === 'over', A.view().match.phase);
    /* 事件是排队播放的，视图先变、日志后到 —— 等日志真的落下来再断言 */
    await waitFor(() => /退出了本局/.test(A.logText()), 'A 的记录里播出「退出本局」');
    ok('记录里播报了「退出了本局 · 转观战」', /退出了本局/.test(A.logText()),
      A.logText().slice(0, 180));
    ok('退出本局后浮出观战提示条', A.byId('watchBar').classList.contains('show'));
    ok('退出本局后转动按钮变「观 战 中」', A.text('spinBtn') === '观 战 中', A.text('spinBtn'));
    ok('「我」面板下半部分变成观战卡',
      /你正在观战/.test(A.byId('myRoleBox').children[0]._html),
      A.byId('myRoleBox').children[0]._html.slice(0, 80));
    ok('观战卡说明「席位没丢、下一局会回名单」',
      /席位没丢/.test(A.byId('myRoleBox').children[0]._html));

    /* 观战者硬发指令，服务端照样拒 */
    A.click('spinBtn');
    await waitFor(() => /服务器拒绝：你不在本局对局里/.test(A.logText()), '观战者被拒');
    ok('观战者绕过按钮硬发指令，服务端拒绝', /服务器拒绝：你不在本局对局里/.test(A.logText()));

    ok('B 那边看到观战名单（2 人观战）',
      /观战（2）/.test(B.byId('players').children.map(c => c._html).join('')),
      B.byId('players').children.map(c => c._html).filter(h => /观战/.test(h)).join(''));

    /* A 退出观战 = 真的离开房间 */
    A.byId('myRoleBox').children[1].onclick();
    await waitFor(() => A.probe().joined === false, 'A 离开房间');
    ok('退出观战后连接状态是「已离开」', A.text('conn') === '已离开', A.text('conn'));
    ok('退出观战后观战提示条收起', !A.byId('watchBar').classList.contains('show'));
    await waitFor(() => /观战（1）/.test(B.byId('players').children.map(c => c._html).join('')),
      'B 看到观战名单缩到 1 人');
    ok('退出观战后房间里的观战名单少了一个',
      /观战（1）/.test(B.byId('players').children.map(c => c._html).join('')));

    /* D 也退出观战 */
    D.byId('myRoleBox').children[1].onclick();
    await waitFor(() => D.probe().joined === false, 'D 离开房间');
    ok('中途进来的观战者也能自己退出去', D.text('conn') === '已离开', D.text('conn'));
    await waitFor(() => !/观战（/.test(B.byId('players').children.map(c => c._html).join('')),
      'B 看到观战名单消失');
    ok('全员退出观战后，观战一栏从房间里消失',
      !/观战（/.test(B.byId('players').children.map(c => c._html).join('')));
    D.close();

    /* ---------- 7. 结算界面 ---------- */
    console.log('\n\u2466 结算界面\n');
    const C = makeBrowser(PORT_B, inlineScript);
    C.byId('name').value = '独狼';
    C.click('joinBtn');
    await waitFor(() => C.probe().joined, 'C 加入');
    C.byId('lobbyModes').children.find(b => b.dataset.mode === 'race').onclick();
    await waitFor(() => C.view().room.mode === 'race', 'C 切到死神追猎');
    C.click('startBtn');
    await waitFor(() => C.view().match.phase === 'playing', 'C 开局');
    C.click('spinBtn');
    await waitFor(() => C.view().match.phase === 'over', '对局结束', 9000);
    await waitFor(() => C.byId('endOverlay').classList.contains('show'), '结算浮层弹出');
    ok('对局结束后自动弹出结算浮层', C.byId('endOverlay').classList.contains('show'));
    ok('单人局一转即「最后一个站着的人」获胜', C.view().match.reason === 'last-standing', C.view().match.reason);
    ok('结算标题告诉你赢了', /你 赢 了/.test(C.text('endTitle')), C.text('endTitle'));
    ok('结算副标题写明获胜原因', /最后一个站着的人/.test(C.text('endSub')), C.text('endSub'));
    ok('结算里有我的存活时间', /我的存活时间/.test(C.byId('endBody')._html));
    ok('房主能点「再来一局」', C.byId('endBtn').disabled === false);
    ok('「再来一局」按钮文案是回大厅', /回大厅/.test(C.text('endBtn')), C.text('endBtn'));

    /* 「用时最短者获胜」的名次表：用一份人造视图直接驱动渲染（免得真跑满 100 转）。
       单人服务器上只有 1 号玩家，所以再捏一个对手出来。 */
    const fake = JSON.parse(JSON.stringify(C.view()));
    const p1f = fake.match.players.find(p => p.id === '1');
    const p2f = JSON.parse(JSON.stringify(p1f));
    p2f.id = '2';
    fake.match.players.push(p2f);
    fake.match.order.push('2');
    fake.match.reason = 'fastest-finish';
    fake.match.winner = '2';
    fake.match.ranking = ['2', '1'];
    fake.match.endedAt = 90000;
    p1f.name = '慢一步'; p1f.finished = true; p1f.survivalMs = 61000;
    p1f.spins = 100; p1f.hp = 4; p1f.gold = 3200; p1f.interest = 900; p1f.spent = 1200; p1f.charmUsed = 2;
    p2f.name = '快一步'; p2f.finished = true; p2f.survivalMs = 48000; p2f.spins = 100;
    C.sandbox.applyView(fake);
    C.sandbox.showEnd();
    ok('「用时最短者获胜」的结算表按用时升序排',
      /1\. 快一步/.test(C.byId('endBody')._html) && /48秒/.test(C.byId('endBody')._html),
      C.byId('endBody')._html.slice(0, 120));
    ok('名次表把第二名的用时也列了出来',
      /2\. 慢一步/.test(C.byId('endBody')._html) && /1分01秒/.test(C.byId('endBody')._html));
    ok('结算标题显示获胜者名字', /快一步 获 胜/.test(C.text('endTitle')), C.text('endTitle'));
    ok('结算里列出我的逐项统计（利息/消费/护符）',
      /死神利息/.test(C.byId('endBody')._html) && /累计消费/.test(C.byId('endBody')._html));

    C.close();

    /* ---------- 8. 大厅里离开房间 ----------
       大厅是全屏遮罩，没有这个出口的话，一旦进来就再也够不到连接栏
       （换服务器地址 / 换名字都做不到），只能关页面。
       单起一台服务器，免得动了 A/B 的玩家编号。 */
    console.log('\n\u2467 大厅里离开房间\n');
    const Q = makeBrowser(PORT_C, inlineScript);
    Q.byId('name').value = '来去自如';
    Q.click('joinBtn');
    await waitFor(() => Q.probe().joined, 'Q 加入大厅');
    ok('进大厅后遮罩弹出（此时连接栏被盖住）', Q.byId('lobbyOverlay').classList.contains('show'));
    ok('大厅里有「离开房间」按钮', typeof Q.byId('lobbyQuitBtn').onclick === 'function');
    Q.click('lobbyQuitBtn');
    await waitFor(() => Q.probe().joined === false, 'Q 离开房间');
    ok('大厅里点「离开房间」真的走掉了', Q.text('conn') === '已离开', Q.text('conn'));
    ok('离开后视图清空 + 遮罩收起（连接栏重新可用）',
      Q.probe().view === null && !Q.byId('lobbyOverlay').classList.contains('show'));
    Q.close();

    /* ---------- 9. 房间码门禁 + 「改完码再连一次」（V18.1） ----------
       🔴 这条是异地那条路的命门：异地只能手填地址、只能点「连接这个地址」。
       曾经在这里全军覆没 —— 服务端房间码不对时**只回 rejected、不关连接**
       （server.js 的 join 分支 return 了），那条 WebSocket 一直是 OPEN；
       旧版 joinBtn 的守卫 `if (ws && ws.readyState === 1)` 于是把玩家
       「改完码再点一次」当成「想断开」—— 点的其实是断开，日志里连一句
       「正在连接」都没有，看着就是"点了没反应"。
       局域网点卡片走的是 codeYes（没那句守卫），所以从来没暴露过。 */
    console.log('\n\u2468 房间码门禁 · 异地手动地址\n');
    {
      /* ① 已经连着的时候点「连接这个地址」= 换过去，不是断开 */
      const R0 = makeBrowser(PORT_E, inlineScript);
      R0.byId('name').value = '换台机器';
      R0.click('joinBtn');
      await waitFor(() => R0.probe().joined, 'R0 进房');
      const joins0 = R0.sent.filter(m => m.type === 'join').length;
      R0.byId('addr').value = '127.0.0.1:' + PORT_E;
      R0.click('joinBtn');
      let rejoined = false;
      try {
        await waitFor(() => R0.sent.filter(m => m.type === 'join').length > joins0, '又发起了一次连接', 5000);
        rejoined = true;
      } catch (e) { /* 没发起就是没发起，如实报错 */ }
      ok('★ 已经连着时点「连接这个地址」= 换过去（不是当成断开）', rejoined,
        'join 次数 ' + joins0 + ' → ' + R0.sent.filter(m => m.type === 'join').length
        + ' · conn=' + R0.text('conn'));
      ok('★ 换地址那一下不会把状态写成「已离开」', R0.text('conn') !== '已离开', R0.text('conn'));
      R0.holdOffline(true);
      R0.close();

      /* ② 房间码不对 → 连接要自己收掉，别停在「已连接」骗人 */
      const R = makeBrowser(PORT_D, inlineScript);
      R.byId('name').value = '异地来的';
      R.byId('addr').value = '127.0.0.1:' + PORT_D;
      R.byId('pass').value = '0000';
      R.click('joinBtn');
      let rejected = false;
      try { await waitFor(() => /房间码不对/.test(R.logText()), 'R 收到房间码拒绝', 6000); rejected = true; }
      catch (e) {}
      ok('房间码不对时服务端会挡回来', rejected, JSON.stringify(R.logText().slice(-80)));
      ok('★ 房间码不对 → 连接不再吊着（状态不是「已连接」）',
        R.text('conn') !== '已连接', R.text('conn'));
      ok('★ 房间码不对 → 状态明说是「房间码不对」', /房间码不对/.test(R.text('conn')), R.text('conn'));
      ok('★ 房间码不对 → 退回连接页（还能再填一次）',
        R.byId('connectView').classList.contains('on'), R.byId('connectView').className);

      /* ③ 改对码再点一次 —— 这才是玩家真正会做的事 */
      R.byId('pass').value = '7788';
      R.click('joinBtn');
      let inRoom = false;
      try { await waitFor(() => R.probe().joined, 'R 改对码后进了房间', 8000); inRoom = true; }
      catch (e) {}
      ok('★ 改对房间码再点一次 → 真的进得去（异地这条路必须通）', inRoom,
        'conn=' + R.text('conn') + ' · ' + JSON.stringify(R.logText().slice(-80)));
      R.holdOffline(true);
      R.close();
    }

    /* ---------- 10. 操作日志（V18.2 · 找 bug 用） ----------
       朋友那边出问题时最缺的就是「他到底按了什么、服务器回了什么」。
       这一节钉死四件事：
         ① 收发与状态真的进了日志（不是只写了个空壳）；
         ② 导出的整份里**不出现地址、不出现房间码**（整份贴群里也不能漏房主 IP）；
         ③ 没有 fetch 的环境点「发给房主」不能把页面点崩（手机 WebView 老版本）；
         ④ 真的能发到服务端并存盘，而且**只有管理台那个端口看得到**。 */
    console.log('\n\u2469 操作日志（找 bug 用）\n');
    {
      const L = makeBrowser(PORT_D, inlineScript);
      L.byId('name').value = '日志君';
      L.byId('addr').value = '127.0.0.1:' + PORT_D;
      L.byId('pass').value = '7788';
      L.click('joinBtn');
      let joined = false;
      try { await waitFor(() => L.probe().joined, 'L 进房', 8000); joined = true; } catch (e) {}
      ok('（前置）日志君进房了', joined, 'conn=' + L.text('conn'));

      const lines = L.oplog();
      ok('★ 出方向消息进了日志（→ join）',
        lines.some(l => l.indexOf('[→]') >= 0 && l.indexOf('join') >= 0),
        JSON.stringify(lines.slice(-3)));
      ok('★ 入方向消息进了日志（← welcome）',
        lines.some(l => l.indexOf('[←]') >= 0 && l.indexOf('welcome') >= 0),
        JSON.stringify(lines.slice(-3)));
      ok('连接状态变化进了日志', lines.some(l => l.indexOf('[状态]') >= 0));
      ok('页面打开时记了一笔「启动」', lines.some(l => l.indexOf('[启动]') >= 0));

      L.click('btnLog');
      const txt = L.byId('logText').value || '';
      ok('点「日志」导出整份文本（带抬头）', /操作日志/.test(txt));
      ok('导出文本里带着本次会话的收发记录',
        txt.indexOf('[→]') >= 0 && txt.indexOf('[←]') >= 0);
      /* 🔴 V15 的硬规矩：界面和日志里都不许出现地址 —— 这条一破，
           玩家把日志贴群里就等于把房主 IP 散出去。 */
      ok('★ 导出文本里没有任何 IP / 端口',
        !/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(txt) && !/:\d{4,5}/.test(txt),
        (txt.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|:\d{4,5}/) || [''])[0]);
      ok('★ 导出文本里没有房间码', txt.indexOf('7788') < 0);

      /* 假 DOM 里根本没有 fetch —— 点「发给房主」绝不能把页面点崩 */
      let alive = true;
      try { L.click('logSend'); } catch (e) { alive = false; }
      ok('★ 没有 fetch 的环境里点「发给房主」不崩（页面还活着）',
        alive && typeof L.probe().joined === 'boolean');
      L.holdOffline(true);
      L.close();

      /* 服务端那条路：玩家 POST 上去 → 落盘 → 只有管理台端口看得到 */
      const posted = await httpReq(PORT_D, '/clientlog', 'POST', { name: '日志君', text: txt });
      ok('★ 玩家能把日志 POST 到服务端（HTTP 200）', posted.status === 200, 'status=' + posted.status);
      ok('★ 服务端收下并存盘了', !!(posted.body && posted.body.ok), JSON.stringify(posted.body));
      const bad1 = await httpReq(PORT_D, '/clientlog', 'POST', { name: '空日志', text: '   ' });
      ok('空日志会被拒（不会存下一堆空文件）', !!(bad1.body && bad1.body.ok === false), JSON.stringify(bad1.body));

      const list = await httpReq(PORT_D + 1000, '/api/clientlogs');
      const logs = (list.body && list.body.logs) || [];
      ok('★ 管理台能列出这份日志', logs.length >= 1, '列出 ' + logs.length + ' 份');
      ok('列表里带着玩家名字', logs.some(x => x.name === '日志君'), JSON.stringify(logs.slice(0, 2)));
      if (logs.length) {
        const one = await httpReq(PORT_D + 1000, '/api/clientlog?f=' + encodeURIComponent(logs[0].file));
        ok('★ 管理台能读回全文（跟发上去的一致）',
          !!(one.body && one.body.ok && String(one.body.text).indexOf('[→]') >= 0));
      }
      const bad2 = await httpReq(PORT_D + 1000, '/api/clientlog?f=' + encodeURIComponent('../../state.json'));
      ok('★ 管理台拒绝路径穿越（只认时间戳文件名）',
        !!(bad2.body && bad2.body.ok === false), JSON.stringify(bad2.body));
      const peek = await httpReq(PORT_D, '/api/clientlogs');
      ok('★ 游戏端口上看不到日志列表（只有管理台能看）', peek.status === 404, 'status=' + peek.status);

      /* 临时日志目录别留在系统临时目录里（它跟着 RR_STATE 走，测试完就清） */
      try { fs.rmSync(path.join(path.dirname(TMP_STATE), 'clientlogs'), { recursive: true, force: true }); } catch (e) {}
    }

    /* ---------------- ⑪ 连不上 / 连错目标的三个坑（V18.3） ----------------
       从赐红发来的真实日志里挖出来的：他在本机、页面就是从服务器加载的，
       却怎么点都连不上 —— 三个坑叠在一起，界面上表现为「点了没反应」。 */
    console.log('\n\u246A 连错目标 / 重连失控\n');
    {
      /* ① 卡片被地址框里残留的旧地址劫持 —— 点什么卡片都在连那个旧地址 */
      const K = makeBrowser(PORT_F, inlineScript);
      K.byId('name').value = '卡片君';
      K.byId('addr').value = '127.0.0.1:1';          // 一个连不上的旧地址，故意留在框里
      ok('（前置）连接页上有一张「本页就是这个服务器」的卡片',
        /本页/.test(cardsText(K.cards())), cardsText(K.cards()));
      K.clickCard(0);
      let kIn = false;
      try { await waitFor(() => K.probe().joined, 'K 通过卡片进房', 8000); kIn = true; } catch (e) {}
      const kLast = K.wsUrls()[K.wsUrls().length - 1] || '';
      ok('★ 点卡片连的是卡片那台，不是地址框里残留的旧地址',
        kLast === 'ws://127.0.0.1:' + PORT_F, '实际连的是 ' + kLast);
      ok('★ 点卡片后地址框被清掉（旧的不再作数）',
        K.byId('addr').value === '', '框里还留着 ' + JSON.stringify(K.byId('addr').value));
      ok('★ 日志里写明连的是「选中的服务器」（不是手填的）',
        K.oplog().some(l => l.indexOf('准备连接：选中的服务器') >= 0),
        JSON.stringify(K.oplog().filter(l => l.indexOf('准备连接') >= 0).slice(-2)));
      ok('（顺带）卡片这条路真进得去', kIn,
        'conn=' + K.text('conn') + ' / ' + JSON.stringify(K.oplog().slice(-4)));
      K.holdOffline(true); K.close();

      /* ② 连不上就永远 3 秒撞一次 —— 界面一直在跳，玩家以为卡死 */
      const M = makeBrowser(PORT_B, inlineScript);
      M.byId('name').value = '重连君';
      M.byId('addr').value = '127.0.0.1:1';          // 没人监听 ⇒ 必失败
      M.click('joinBtn');
      let stopped = false;
      try { await waitFor(() => M.text('conn').indexOf('没连上') >= 0, 'M 停手', 8000); stopped = true; } catch (e) {}
      const n1 = M.wsUrls().length;
      await new Promise(r => setTimeout(r, 1200));   // 定时器已压缩到 40ms，这够撞十几轮了
      ok('★ 连续失败到次数就停手，不再无限重连',
        stopped && M.wsUrls().length === n1, '停手后仍新建了 ' + (M.wsUrls().length - n1) + ' 条连接');
      ok('★ 撞的次数有上限（不是几十上百条）', n1 > 0 && n1 <= 5, '共 ' + n1 + ' 条');
      ok('★ 停手时状态写的是「没连上」（而不是骗人的「已连接」）',
        M.text('conn').indexOf('没连上') >= 0, 'conn=' + M.text('conn'));
      ok('★ 日志里写了「停手」这一笔',
        M.oplog().some(l => l.indexOf('停手') >= 0),
        JSON.stringify(M.oplog().slice(-3)));
      M.holdOffline(true); M.close();

      /* ③ 换协议重试是我们自己关的旧连接 —— 不该显示成「已离开」 */
      const N = makeBrowser(PORT_B, inlineScript);
      /* 模拟手机 App 里 file:// 打开页面：这种时候推不出该用哪种协议，
         裸域名才会被标成「猜的」⇒ 连不上会换另一种再试一次。 */
      N.sandbox.location.protocol = 'file:';
      N.byId('name').value = '换协议君';
      N.byId('addr').value = 'nope.invalid';         // 裸域名 ⇒ 协议是猜的，会换一种再试
      N.click('joinBtn');
      try { await waitFor(() => N.oplog().some(l => l.indexOf('停手') >= 0), 'N 换协议后停手', 8000); } catch (e) {}
      const nExp = N.opExport ? N.opExport() : '';
      ok('★ 换协议重试不会把状态写成「已离开」（那是玩家主动离开才有的话）',
        nExp.indexOf('[状态] 已离开') < 0,
        (nExp.split('\n').filter(l => l.indexOf('已离开') >= 0)[0] || '（无）'));
      ok('★ 确实换过协议再试了一次（日志里有两次「开始连接」且一次是加密）',
        nExp.indexOf('加密 wss') >= 0,
        JSON.stringify(N.oplog()));
      N.holdOffline(true); N.close();
    }
  } finally {
    srvA.child.kill();
    srvB.child.kill();
    srvC.child.kill();
    srvD.child.kill();
    srvE.child.kill();
    srvF.child.kill();
  }

  console.log('\n=== 结果：' + PASS + ' 通过 / ' + FAIL + ' 失败 ===\n');
  process.exit(FAIL > 0 ? 1 : 0);
})().catch(e => {
  console.log('\n\u2717 测试中断：' + e.message);
  console.log(e.stack);
  console.log('\n=== 结果：' + PASS + ' 通过 / ' + (FAIL + 1) + ' 失败 ===\n');
  process.exit(1);
});
