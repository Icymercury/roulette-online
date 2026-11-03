/* ============================================================
 * 生死转盘 · 内网穿透自检（V15）
 * ------------------------------------------------------------
 *   node build/verify-tunnel.js <地址>
 *   例：node build/verify-tunnel.js https://abc123.cpolar.cn
 *       node build/verify-tunnel.js abc123.cpolar.cn
 *       node build/verify-tunnel.js http://1.2.3.4:8080
 *
 * 为什么需要它：
 *   V14 把「域名 / 无端口 / https」三种地址形态的解析都改对了，但**真穿透隧道
 *   转发 WebSocket 升级**这件事从没验过 —— 穿透服务通常只保证 HTTP 能通，
 *   WebSocket 的 Upgrade 头经常被中间层吃掉。这条断了，朋友打开网址能看见
 *   页面、却永远进不了房间（最难排查的那种「半通」）。
 *
 * 它验什么（按顺序，任一条不过就 exit 1）：
 *   ① 地址解析    —— 你给的字符串能不能变成 host:port + 该不该加密
 *   ② HTTP 页面   —— /client.html 200，且是新版页面（含 parseAddr）
 *   ③ 静态资源    —— /engine.js 200（页面靠它跑规则）
 *   ④ 静态白名单  —— /server.js 必须 404（穿透把端口整个暴露出去了，
 *                    这条是「源码会不会被陌生人拖走」的唯一判据）
 *   ⑤ ★ WebSocket —— 真连一次：join → welcome（唯一没验过的那条）
 *   ⑥ 真浏览器     —— 找到 Edge/Chrome 就真渲染一遍，确认页面是活的
 *
 * 本机自测（不开穿透也能证明脚本本身是好的）：
 *   node build/verify-tunnel.js http://127.0.0.1:8199
 * ============================================================ */

const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const { parseAddr } = require(path.join(ROOT, 'pc-client.js'));

const raw = process.argv[2];
if (!raw) {
  console.log('用法：node build/verify-tunnel.js <地址>');
  console.log('例：  node build/verify-tunnel.js https://abc123.cpolar.cn');
  process.exit(1);
}

let PASS = 0, FAIL = 0;
function ok(name, cond, extra) {
  console.log('  ' + (cond ? '✓' : '✗') + ' ' + name + (cond ? '' : (extra ? '  →  ' + extra : '')));
  if (cond) PASS++; else FAIL++;
}

const TIMEOUT = 12000;
function get(url) {
  return new Promise(res => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: TIMEOUT }, r => {
      let s = '';
      r.setEncoding('utf8');
      r.on('data', d => s += d);
      r.on('end', () => res({ code: r.statusCode, body: s, len: s.length }));
    });
    req.on('timeout', () => { req.destroy(); res({ code: 0, body: '', len: 0, err: '超时' }); });
    req.on('error', e => res({ code: 0, body: '', len: 0, err: e.message }));
  });
}

/* 找真浏览器（和 verify-page.js 同一套候选） */
function findBrowser() {
  if (process.env.RR_BROWSER && fs.existsSync(process.env.RR_BROWSER)) return process.env.RR_BROWSER;
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  for (const p of cands) if (fs.existsSync(p)) return p;
  return null;
}

/* 真渲染一遍：把隧道发出来的那一份页面**下载下来**再在真浏览器里跑。
   （不能直接用浏览器打开网址 —— 那样没法注入探针；也不能 location.replace，
   跳转之后探针就没了。所以是「下载 → 注入 → file:// 打开」，
   验的是隧道发出来的**内容**在真浏览器里活不活得起来。） */
async function renderCheck(base) {
  const browser = findBrowser();
  if (!browser) { console.log('  · 没找到 Edge/Chrome，跳过真浏览器渲染（其余 5 条照验）'); return null; }

  /* 必须放纯 ASCII 路径：项目路径里含中文，无头浏览器用 file:// 打开中文路径会
     加载不全（dump 出来的 DOM 是半截的，探针根本没跑）。 */
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-tunnel-'));

  void stage;
  /* 直接用真浏览器打开网址，dump 渲染后的 DOM。
     不用「下载下来再注入探针」那套 —— 无头模式下注入的探针不保证被执行（踩过：
     脚本明明在 DOM 里，title 却没被改）。直接看渲染结果反而更真：
     转盘画出来 = JS 真跑起来了；列表里出现「本页就是这个服务器」= init() 真跑完了。 */
  const r = spawnSync(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--virtual-time-budget=9000',
    '--user-data-dir=' + path.join(stage, 'prof'),
    '--window-size=390,844', '--dump-dom', base + '/client.html',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
  const dom = (r.stdout || '') + '';
  if (dom.indexOf('生 死 转 盘') < 0) return { err: '浏览器没拿到页面', raw: dom.slice(0, 160) };

  const paths = (dom.match(/<path\b/g) || []).length;
  const at = dom.indexOf('id="srvList"');
  let seg = at >= 0 ? dom.slice(at, at + 1200) : '';
  /* 列表区后面紧跟着「异地加入」手输框，它的 placeholder 里有一串示例 IP ——
     那不是真实地址，别让它污染这条断言。切到手输框之前为止。 */
  const cut = seg.indexOf('manualBox');
  if (cut > 0) seg = seg.slice(0, cut);
  return {
    paths: paths,
    hasPageCard: /本页就是这个服务器/.test(seg),
    segHasIp: /\d{1,3}(\.\d{1,3}){3}/.test(seg),
    segIp: (seg.match(/\d{1,3}(\.\d{1,3}){3}/) || ['(无)'])[0],
    errs: (dom.match(/<script>window\.__errs/g) || []).length ? [] : [],
    raw: seg.slice(0, 160),
  };
}

/* ⑦ 像朋友一样点一下就进房（真浏览器 + CDP + 真点击）。
   ⑥ 只证明「页面是活的」，⑦ 才证明「点一下真能进房间」——
   朋友拿到网址后唯一会做的动作就是这一个，不验等于没验。 */
async function clickCheck(base, host) {
  const browser = findBrowser();
  if (!browser) { console.log('  · 没找到 Edge/Chrome，跳过「点一下进房」（其余照验）'); return null; }

  const CDP_PORT = 9444;
  /* 🔴 同上：带时间戳才不会被 PID 复用捡回上一轮的 profile */
  const profile = path.join(os.tmpdir(), 'rr-tunnel-prof-' + process.pid + '-' + Date.now().toString(36));
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=390,844',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    base + '/client.html',
  ], { stdio: 'ignore' });
  const stop = () => { try { proc.kill(); } catch (e) {} };

  try {
    /* CDP 端点就绪 + 找到我们那个页面 */
    let target = null;
    const t1 = Date.now();
    while (!target) {
      if (Date.now() - t1 > 25000) throw new Error('CDP 端点没就绪');
      try {
        const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
        target = list.find(x => x.type === 'page' && x.url.indexOf(host) >= 0);
      } catch (e) { /* 还没起来 */ }
      if (!target) await new Promise(r => setTimeout(r, 200));
    }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const pending = new Map();
    const errors = [];
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push((m.params && m.params.exceptionDetails && m.params.exceptionDetails.text) || 'exception');
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errors.push('console.error: ' + (m.params.args || []).map(a => a.value).join(' '));
      }
    };
    const call = (method, params) => new Promise(res => {
      const myId = ++seq;
      pending.set(myId, res);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
    await call('Runtime.enable', {});
    await new Promise(r => setTimeout(r, 1500));   // 等 init() 跑完

    const script = `(async () => {
      const out = {};
      const cards = Array.prototype.slice.call(document.querySelectorAll('#srvList .srvcard'));
      out.cardCount = cards.length;
      const hit = cards.filter(c => {
        const n = c.querySelector('.nm');
        return n && n.textContent === '本页就是这个服务器';
      })[0];
      out.found = !!hit;
      const nm = document.getElementById('name'); if (nm && !nm.value) nm.value = '穿透玩家';
      if (hit) hit.click();
      /* 🔴 别等「已连接」—— 那是 socket 一打开就置位的，welcome 还在公网上飞呢。
         必须等大厅浮层真的弹出来（或房间码 / 观战浮层），否则脚本会提前收工、
         把浏览器杀掉，看上去就像「连上了却进不去」。 */
      for (let i = 0; i < 150; i++) {
        await new Promise(r => setTimeout(r, 100));
        const lo = document.getElementById('lobbyOverlay');
        const co = document.getElementById('codeOverlay');
        if (lo.className.indexOf('show') >= 0 || co.className.indexOf('show') >= 0) break;
      }
      out.conn = document.getElementById('conn').textContent;
      out.lobbyShow = document.getElementById('lobbyOverlay').className.indexOf('show') >= 0;
      out.lobbyList = document.getElementById('lobbyList').children.length;
      out.logText = (document.getElementById('log').textContent || '').slice(0, 200);
      out.overlays = ['lobbyOverlay', 'codeOverlay', 'spectateOverlay', 'leaveOverlay'].map(id => {
        const el = document.getElementById(id);
        return id + '=' + (el ? (el.className || '(空)') : '(不存在)');
      }).join(' | ');
      out.bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400);
      return JSON.stringify(out);
    })()`;
    const r = await call('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
    const val = r.result && r.result.result && r.result.result.value;
    if (!val) throw new Error('页面里拿不到结果：' + JSON.stringify(r).slice(0, 400));
    const o = JSON.parse(val);
    o.errors = errors;
    return o;
  } finally {
    stop();
    try { require('fs').rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
}

(async () => {
  console.log('\n生死转盘 · 内网穿透自检');
  console.log('地址：' + raw + '\n');

  /* ---------- ① 地址解析 ---------- */
  const p = parseAddr(raw);
  ok('① 地址能解析成 host:port', !!p, JSON.stringify(raw));
  if (!p) { console.log('\n自检未通过：地址就看不懂。\n'); process.exit(1); }
  console.log('      → ' + p.addr + '   ' + (p.secure ? '加密（wss）' : '明文（ws）')
    + (p.guessed ? '   ⚠ 协议是猜的，连不上会自动换另一种再试一次' : ''));
  const base = (p.secure ? 'https' : 'http') + '://' + p.addr;
  const wsBase = (p.secure ? 'wss' : 'ws') + '://' + p.addr;

  /* ---------- ② HTTP 页面 ---------- */
  const page = await get(base + '/client.html');
  ok('② 页面取得到（' + base + '/client.html）', page.code === 200,
    'code=' + page.code + (page.err ? ' ' + page.err : ''));
  if (page.code !== 200) {
    console.log('\n自检未通过：穿透没把 8080 映射出来，或者隧道没开。\n');
    process.exit(1);
  }
  ok('② 页面是新版（含 V14 的 parseAddr）', /parseAddr/.test(page.body), '页面 ' + page.len + ' 字节');
  ok('② 页面引的是相对路径 engine.js（安卓壳里才不会 404）',
    /src="\.?\/?engine\.js"/.test(page.body) && !/src="\/engine\.js"/.test(page.body));

  /* ---------- ③ 静态资源 ---------- */
  const eng = await get(base + '/engine.js');
  ok('③ 规则引擎 engine.js 取得到', eng.code === 200, 'code=' + eng.code);

  /* ---------- ④ 静态白名单（穿透把端口暴露给公网后，这条是命根子） ---------- */
  const leak = await get(base + '/server.js');
  const leak2 = await get(base + '/state.json');
  ok('★ ④ 源码 /server.js 是 404（陌生人拖不走）', leak.code === 404, 'code=' + leak.code);
  ok('★ ④ 存档 /state.json 是 404（陌生人看不到你们的房间）', leak2.code === 404, 'code=' + leak2.code);

  /* ---------- ⑤ 真 WebSocket（唯一没验过的那条） ---------- */
  let wsOk = false, wsInfo = '';
  try {
    const ws = new WebSocket(wsBase);
    const done = await new Promise(res => {
      const t = setTimeout(() => res({ t: 'timeout' }), TIMEOUT);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name: '穿透自检' }));
      ws.onmessage = e => {
        let m = null; try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.type === 'welcome') {
          clearTimeout(t);
          res({ t: 'welcome', you: m.you, players: (m.view && m.view.room && m.view.room.players || []).length });
        }
      };
      ws.onerror = () => { clearTimeout(t); res({ t: 'error' }); };
      ws.onclose = () => { clearTimeout(t); res({ t: 'closed' }); };
    });
    try { ws.close(); } catch (e) {}
    if (done.t === 'welcome') { wsOk = true; wsInfo = '座位号 ' + done.you + '，房间里 ' + done.players + ' 人'; }
    else wsInfo = '结果是 ' + done.t;
  } catch (e) { wsInfo = e.message; }
  ok('★ ⑤ WebSocket 升级被隧道转发了（join → welcome）', wsOk, wsInfo);
  if (wsOk) console.log('      → ' + wsInfo);

  /* ---------- ⑥ 真浏览器渲染 ---------- */
  const R = await renderCheck(base);
  if (R) {
    ok('⑥ 真浏览器打开网址后页面是活的（转盘画出来了）',
      !R.err && Number(R.paths) >= 5, JSON.stringify(R).slice(0, 220));
    ok('⑥ init() 跑完了（列表里出现「本页就是这个服务器」）',
      !!R && R.hasPageCard === true, JSON.stringify(R && R.raw));
    ok('★ ⑥ 服务器列表里没有任何 IP', !!R && R.segHasIp === false,
      '命中的是 ' + JSON.stringify(R && R.segIp));
  }

  /* ---------- ⑦ 点一下就进房（朋友拿到网址后唯一会做的动作） ---------- */
  const C = await clickCheck(base, p.host).catch(e => ({ err: e.message }));
  if (C && !C.err) {
    ok('★ ⑦ 点「本页就是这个服务器」→ 连接状态变「已连接」',
      C.conn === '已连接', JSON.stringify(C.conn));
    ok('★ ⑦ 大厅浮层弹出（穿透后面真进房了）', C.lobbyShow === true,
      '卡片 ' + JSON.stringify(C.cardCount) + ' 命中 ' + JSON.stringify(C.found)
      + ' 日志 ' + JSON.stringify(C.logText)
      + '\n        浮层：' + JSON.stringify(C.overlays)
      + '\n        页面：' + JSON.stringify(C.bodyText));
    ok('⑦ 大厅名单里出现了自己', Number(C.lobbyList) >= 1, JSON.stringify(C.lobbyList));
    ok('★ ⑦ 日志里没有出现任何 IP / 协议字符串',
      !/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(C.logText || '') && !/wss?:\/\//.test(C.logText || ''),
      JSON.stringify((C.logText || '').slice(0, 120)));
    ok('⑦ 全程没有未捕获异常 / console.error', (C.errors || []).length === 0, (C.errors || []).join(' | '));
  } else if (C && C.err) {
    ok('★ ⑦ 点一下就进房', false, C.err);
  }

  console.log('\n结果：通过 ' + PASS + ' 项，失败 ' + FAIL + ' 项。');
  if (FAIL) {
    console.log('\n自检没过 —— 别把网址发给朋友，先把红叉那几条解决。\n');
    process.exit(1);
  }
  console.log('\n全绿 —— 把这个地址发给朋友就能玩：');
  console.log('    ' + p.addr + (p.secure ? '   （加密）' : '   （明文）'));
  console.log('朋友的用法：手机装 APK →「异地加入 · 手动填地址」→ 粘上面这串；');
  console.log('            PC 直接用浏览器打开 ' + base + '/client.html，');
  console.log('            页面里会出现「本页就是这个服务器」这张卡片，点一下就进。');
  console.log('（地址不会摊在界面上，也不进日志 —— 只有你发出去的网址里有它。）\n');
  process.exit(0);
})().catch(e => {
  console.error('\n自检崩了：' + (e && e.message ? e.message : e) + '\n');
  process.exit(1);
});
