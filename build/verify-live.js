/* ============================================================
 * 生死转盘 · 真·端到端验收（真服务端 + 真浏览器 + 真 WebSocket）
 * ------------------------------------------------------------
 *   node build/verify-live.js [端口]
 *
 * 和 `verify-page.js` 的分工：
 *   verify-page.js —— 只验渲染：页面在真浏览器里画不画得出来。
 *   verify-live.js —— 连通信一起验：真浏览器点「进入房间」能不能真连上、
 *                     真进大厅、真拿到房主身份。
 *
 * 为什么要有这一层（三层各挡一类错）：
 *   ① 假 DOM 的 Node 测试 ≠ 真浏览器  →  V10 事故（appendChild 传错变量，
 *      452 条断言全绿，整页却是死的）；
 *   ② 真浏览器渲染 ≠ 真网络通          → 页面画得出来但连不上，照样白干；
 *   ③ 直接读源码做断言 ≠ 用户真点得动  → 只会查字符串，不查交互。
 *
 * 做法：不走 puppeteer（本机没这套依赖），用 CDP 直接驱动无头 Edge，
 *       Node 22 自带 WebSocket，够用。
 *
 * 退出码：0 全过 / 1 有失败 / 2 没浏览器（跳过，不算失败）
 * ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || 8130);
const CDP_PORT = 9223;

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

let PASS = 0, FAIL = 0;
function ok(name, cond, extra) {
  if (cond) { PASS++; console.log('  \u2713 ' + name); }
  else { FAIL++; console.log('  \u2717 ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browserPath = BROWSERS.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
if (!browserPath) {
  console.log('\n找不到 Edge / Chrome —— 跳过真·端到端验收（不视为失败）。\n');
  process.exit(2);
}

let srv = null, browser = null, ws = null;
let tmpState = null, profile = null;

function cleanup() {
  try { if (ws) ws.close(); } catch (e) {}
  try { if (browser) browser.kill(); } catch (e) {}
  try { if (srv) srv.kill(); } catch (e) {}
  try { if (tmpState) fs.unlinkSync(tmpState); } catch (e) {}
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}

(async () => {
  console.log('\n生死转盘 · 真·端到端验收（' + path.basename(browserPath) + '，端口 ' + PORT + '）\n');

  /* 存档指到临时文件 —— 绝不能让测试覆盖赐红的真实对局存档 */
  tmpState = path.join(os.tmpdir(), 'rr-live-' + process.pid + '-' + Date.now().toString(36) + '.json');
  srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    /* V16.1：默认房间码会挡住「点一下就进房」，这套验收走的是无码流程 */
    env: Object.assign({}, process.env, { RR_STATE: tmpState, RR_ROOM_CODE: '' }),
  });
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d.toString(); });
  srv.stderr.on('data', d => { srvOut += d.toString(); });

  const t0 = Date.now();
  while (!/本机打开/.test(srvOut)) {
    if (Date.now() - t0 > 12000) throw new Error('服务端没起来：' + srvOut);
    await sleep(100);
  }
  ok('服务端起来了', true);

  /* 🔴 跨运行必须唯一（同 ADMIN 版那条注释）：只写 process.pid 会被 PID 复用坑到 ——
     捡回上一轮残留的 Edge profile ⇒ 缓存 / 本地存储串到这一轮，症状看着像随机假红。 */
  profile = path.join(os.tmpdir(), 'rr-live-prof-' + process.pid + '-' + Date.now().toString(36));
  browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=390,844',                       // 手机竖屏，跟真机一致
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    /* V16：/ 已经是启动页了，这里要验的是联机页本身 —— 必须显式写 client.html */
    'http://127.0.0.1:' + PORT + '/client.html',
  ], { stdio: 'ignore' });

  /* 等 CDP 端点就绪，找到我们那个页面 */
  let target = null;
  const t1 = Date.now();
  while (!target) {
    if (Date.now() - t1 > 20000) throw new Error('CDP 端点没就绪');
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
      target = list.find(x => x.type === 'page' && x.url.indexOf('127.0.0.1:' + PORT) >= 0);
    } catch (e) { /* 还没起来 */ }
    if (!target) await sleep(200);
  }
  ok('无头浏览器打开页面', true);

  ws = new WebSocket(target.webSocketDebuggerUrl);
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

  await sleep(1200);   // 等页面 init() 跑完

  /* 像真人一样：填名字 → 点「进入房间」→ 等结果 */
  const script = `(async () => {
    const out = {};
    out.hasEngine = (typeof RREngine !== 'undefined');
    out.addr = document.getElementById('addr').value;
    document.getElementById('name').value = '真机探针';
    document.getElementById('joinBtn').click();
    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (document.getElementById('conn').textContent === '已连接') break;
    }
    out.conn = document.getElementById('conn').textContent;
    out.lobbyShow = document.getElementById('lobbyOverlay').className.indexOf('show') >= 0;
    out.lobbyList = document.getElementById('lobbyList').children.length;
    out.modeButtons = document.getElementById('lobbyModes').children.length;
    out.startDisabled = document.getElementById('startBtn').disabled;
    out.wheelPaths = document.querySelectorAll('#wheel path').length;
    out.wheelTexts = document.querySelectorAll('#wheel text').length;
    /* 接着点「开始赌局」，验完大厅再验一局真的能开起来 */
    if (!document.getElementById('startBtn').disabled) {
      document.getElementById('startBtn').click();
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (document.getElementById('turnbar').textContent.indexOf('大厅') < 0) break;
      }
    }
    out.turnbar = document.getElementById('turnbar').textContent;
    out.spinText = document.getElementById('spinBtn').textContent;
    out.spinDisabled = document.getElementById('spinBtn').disabled;
    out.logText = document.getElementById('log').textContent.slice(0, 240);
    /* V17：连上之后连接那一屏要真的收走，血量对比条要真的渲染出来 */
    out.gameViewOn = document.getElementById('gameView').className.indexOf('on') >= 0;
    out.connectViewOn = document.getElementById('connectView').className.indexOf('on') >= 0;
    out.connectBtnText = document.getElementById('btnConnect').textContent;
    out.hpCells = document.getElementById('hpStrip').children.length;
    out.hpText = (document.getElementById('hpStrip').textContent || '').slice(0, 60);
    return JSON.stringify(out);
  })()`;

  const r = await call('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
  const val = r.result && r.result.result && r.result.result.value;
  if (!val) throw new Error('页面里拿不到结果：' + JSON.stringify(r).slice(0, 500));
  const o = JSON.parse(val);

  ok('真浏览器里 RREngine 加载成功', o.hasEngine === true);
  /* V15：地址不再自动填进输入框（那是房主的 IP，不该摊在界面上）。
     连接照旧要能成 —— 地址走内存里的 pendingAddr。 */
  ok('★ 地址框为空（不摊开 IP）', o.addr === '', JSON.stringify(o.addr));
  ok('★ 日志里没有出现任何 IP / 协议字符串',
    !/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(o.logText) && !/wss?:\/\//.test(o.logText),
    JSON.stringify(o.logText.slice(0, 120)));
  ok('点「进入房间」→ 连接状态变「已连接」', o.conn === '已连接', o.conn);
  ok('★ 大厅浮层弹出（真 WebSocket 通了）', o.lobbyShow === true);
  ok('大厅名单里出现了自己', o.lobbyList === 1, o.lobbyList);
  ok('模式按钮来自服务端', o.modeButtons === 2, o.modeButtons);
  ok('自己就是房主 → 开始按钮可点', o.startDisabled === false);
  ok('转盘 5 个扇形 / 6 段文字', o.wheelPaths === 5 && o.wheelTexts === 6,
    o.wheelPaths + ' / ' + o.wheelTexts);
  ok('★ 点「开始赌局」能真的开局（回合条不再是大厅）',
    typeof o.turnbar === 'string' && o.turnbar.indexOf('大厅') < 0, JSON.stringify(o.turnbar));
  ok('开局后转动按钮可用', o.spinDisabled === false, JSON.stringify(o.spinText));
  ok('V17 ★ 连上之后连接那一屏收走（搜索 / 地址栏不再占游戏页）',
    o.gameViewOn === true && o.connectViewOn === false,
    'game=' + o.gameViewOn + ' connect=' + o.connectViewOn);
  ok('V17 顶部入口文案变成「换服务器」', o.connectBtnText === '换服务器', String(o.connectBtnText));
  ok('V17 顶部血条条渲染出来了（一人一格，含血量数字）',
    o.hpCells === 1 && /\d+\s*\/\s*\d+/.test(o.hpText),
    o.hpCells + ' 格 · ' + JSON.stringify(o.hpText));
  ok('全程没有未捕获异常 / console.error', errors.length === 0, errors.join(' | '));

  console.log('\n  页面日志：' + JSON.stringify(o.logText));
  console.log('\n结果：通过 ' + PASS + ' 项，失败 ' + FAIL + ' 项。');
  console.log(FAIL === 0 ? '真·端到端全绿 —— 用户能真的进来玩。\n'
                         : '真·端到端没过 —— 别打包。\n');

  cleanup();
  process.exit(FAIL === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n验收异常：' + e.message + '\n');
  cleanup();
  process.exit(1);
});
