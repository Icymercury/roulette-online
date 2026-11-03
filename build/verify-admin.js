/* ============================================================
 * 生死转盘 · 房主管理台真机验收（V16）
 * ------------------------------------------------------------
 *   node build/verify-admin.js
 *
 * 验的是「开服务端的那个人看到的那个页面」——它跑在只监听 127.0.0.1
 * 的独立管理端口上，跟游戏页是两套东西，所以 verify-live 覆盖不到。
 *
 * 它验什么（任一条不过 exit 1）：
 *   ① 服务端起来了，管理端口在 127.0.0.1 上打得开
 *   ② ★ 页面 JS 是活的：管理端口号被填进了标题栏（fetch /api/info 通了）
 *   ③ ★ 规则区脚本是活的：概率合计算出了 100%（说明 DEFAULTS 与字段齐全）
 *   ④ ★ 改一条规则保存 → 服务端收下，且游戏页那份 /rules.json 立刻跟着变
 *   ⑤ ★ 护栏（页面级）：概率之和 ≠ 100 → 保存按钮被禁用
 *   ⑥ ★ 护栏（服务端级）：绕过页面直接 POST 非法值 → 400，且**上一套规则还在**
 *      （非法提交绝不能把已经设好的规则清空 —— 2026-09-29 修过的坑）
 *   ⑦ 恢复默认 → /rules.json 变回 null
 *   ⑧ ★ 异地绝对进不来：游戏端口取 /admin.html → 404；局域网 IP 连管理端口 → 拒绝
 *   ⑨ 全程没有未捕获异常 / console.error
 * ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2] || 8170);
const ADMIN_PORT = PORT + 1000;      // 与 server.js 的默认算法一致
const CDP_PORT = 9224;               // 别跟 verify-live 的 9223 撞

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

let PASS = 0, FAIL = 0;
function ok(name, cond, extra) {
  if (cond) { PASS++; console.log('  ✓ ' + name); }
  else { FAIL++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function httpGet(port, p, host) {
  return new Promise(res => {
    const req = http.get({ host: host || '127.0.0.1', port: port, path: p, timeout: 3000 }, r => {
      let b = '';
      r.on('data', d => { b += d.toString(); });
      r.on('end', () => res({ status: r.statusCode, body: b }));
    });
    req.on('error', () => res({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); res({ status: 0, body: '' }); });
  });
}
function lanIP() {
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) {
    for (const a of ifs[k] || []) {
      if (a.family === 'IPv4' && !a.internal && a.address.indexOf('169.254.') !== 0) return a.address;
    }
  }
  return null;
}

const browserPath = BROWSERS.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
if (!browserPath) { console.log('\n没找到 Edge/Chrome —— 管理台没能真机验收。\n'); process.exit(2); }

let srv = null, browser = null, ws = null;
let tmpState = null, tmpRules = null, profile = null;
function cleanup() {
  try { if (ws) ws.close(); } catch (e) {}
  try { if (browser) browser.kill(); } catch (e) {}
  try { if (srv) srv.kill(); } catch (e) {}
  try { if (tmpState) fs.unlinkSync(tmpState); } catch (e) {}
  try { if (tmpRules) fs.unlinkSync(tmpRules); } catch (e) {}
  try { if (profile) fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}

(async () => {
  console.log('\n生死转盘 · 管理台真机验收（' + path.basename(browserPath) + '，游戏端口 '
    + PORT + ' / 管理端口 ' + ADMIN_PORT + '）\n');

  /* 存档和规则都指到临时文件 —— 绝不能让测试覆盖赐红真实的房间设置 */
  /* 🔴 跨运行必须唯一：只用 process.pid 会被 PID 复用坑到，捡回上一轮的脏存档
     （房间可能还停在"局中"）⇒ 新连接进不了大厅，症状看着像网络炸了。 */
  const RUN_TAG = process.pid + '-' + Date.now().toString(36);
  tmpState = path.join(os.tmpdir(), 'rr-admin-state-' + RUN_TAG + '.json');
  tmpRules = path.join(os.tmpdir(), 'rr-admin-rules-' + RUN_TAG + '.json');
  srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { RR_STATE: tmpState, RR_RULES: tmpRules }),
  });
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d.toString(); });
  srv.stderr.on('data', d => { srvOut += d.toString(); });

  const t0 = Date.now();
  while (!/本机打开/.test(srvOut)) {
    if (Date.now() - t0 > 12000) throw new Error('服务端没起来：' + srvOut);
    await sleep(100);
  }
  ok('① 服务端起来了', true);

  /* 同上：profile 目录也要带 RUN_TAG，否则 PID 复用会捡回上一轮的 Edge profile */
  profile = path.join(os.tmpdir(), 'rr-admin-prof-' + RUN_TAG);
  browser = spawn(browserPath, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=900,1000',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    'http://127.0.0.1:' + ADMIN_PORT + '/',
  ], { stdio: 'ignore' });

  let target = null;
  const t1 = Date.now();
  while (!target) {
    if (Date.now() - t1 > 20000) throw new Error('CDP 端点没就绪');
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
      target = list.find(x => x.type === 'page' && x.url.indexOf('127.0.0.1:' + ADMIN_PORT) >= 0);
    } catch (e) { /* 还没起来 */ }
    if (!target) await sleep(200);
  }

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
  await sleep(1200);   // 等 init 里的 fetch 跑完

  const script = `(async () => {
    const out = {};
    const $ = id => document.getElementById(id);
    out.title = document.title;
    out.h1 = (document.querySelector('h1') || {}).textContent || '';
    out.adminPort = $('adminPort').textContent;
    out.gamePort  = $('port').textContent;
    out.probSum   = $('probSum').textContent;
    out.badge     = $('rulesBadge').textContent;

    /* 展开规则区，改一条：p0 30→40、p4 20→10（和仍是 100） */
    $('btnRulesToggle').click();
    await new Promise(r => setTimeout(r, 150));
    out.opened = $('rulesBody').style.display !== 'none';
    out.p0before = $('p0').value;
    $('p0').value = 40; $('p0').dispatchEvent(new Event('input'));
    $('p4').value = 10; $('p4').dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 60));
    out.probSumAfter = $('probSum').textContent;
    $('btnRules').click();
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (/自定义/.test($('rulesBadge').textContent)) break;
    }
    out.badgeAfter = $('rulesBadge').textContent;
    out.errAfter   = $('rulesErr').textContent;

    /* 游戏页那份 /rules.json 要立刻反映出来（跨端口，该接口带了 CORS 头） */
    const gj = await (await fetch('http://127.0.0.1:' + out.gamePort + '/rules.json')).json();
    out.gameCustom = !!gj.custom;
    out.gameP0 = gj.rules && gj.rules.num && gj.rules.num.PROBS_FIXED
      ? gj.rules.num.PROBS_FIXED[0] : null;

    /* ⑤ 护栏（页面级）：把 p1 改成 0 → 和变 90 → 保存按钮该被禁用 */
    $('p1').value = 0; $('p1').dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 60));
    out.btnDisabled = $('btnRules').disabled;
    out.probSumBad  = $('probSum').textContent;

    /* ⑥ 护栏（服务端级）：绕过页面直接 POST 非法值（和 = 100 但塞个不存在的道具） */
    const bad = await fetch('/api/rules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: { shop: { 不存在的道具: { price: 1 } } } }),
    });
    out.badStatus = bad.status;
    const badB = await bad.json();
    out.badErr = (badB.errors || []).join('；') || badB.err || '';
    const cur = await (await fetch('/api/rules')).json();
    out.stillCustom = !!cur.custom;                       /* 上一套必须还在 */
    out.stillP0 = cur.rules && cur.rules.num && cur.rules.num.PROBS_FIXED
      ? cur.rules.num.PROBS_FIXED[0] : null;

    /* ⑫ 穿透卡片：状态、按钮、路径框、护栏提示都得在 */
    out.tunBadge = $('tunBadge').textContent;
    out.tunStartDisabled = $('btnTunStart').disabled;
    out.tunStopDisabled = $('btnTunStop').disabled;
    out.tunBinShown = $('tunBin') ? 'yes' : 'no';
    out.hasPick = !!$('btnPickBin') && !!$('btnAutoBin');

    /* ⑦ 恢复默认 */
    $('btnRulesReset').click();
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (/默认/.test($('rulesBadge').textContent)) break;
    }
    out.badgeReset = $('rulesBadge').textContent;
    const gj2 = await (await fetch('http://127.0.0.1:' + out.gamePort + '/rules.json')).json();
    out.gameCustomAfterReset = !!gj2.custom;
    return JSON.stringify(out);
  })()`;

  const r = await call('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
  const val = r.result && r.result.result && r.result.result.value;
  if (!val) throw new Error('页面里拿不到结果：' + JSON.stringify(r).slice(0, 600));
  const o = JSON.parse(val);

  ok('★ ② 管理台页面打开就是它自己', /房主管理台/.test(o.title + o.h1), o.title);
  ok('★ ③ 页面 JS 是活的（管理端口号被填进来了）', o.adminPort === String(ADMIN_PORT),
    JSON.stringify(o.adminPort));
  ok('★ ④ 规则区脚本是活的（概率合计算出 100%）', /100%/.test(o.probSum), JSON.stringify(o.probSum));
  ok('★ ⑤ 默认状态下徽章写着「默认规则」', /默认/.test(o.badge), JSON.stringify(o.badge));
  ok('规则区能展开，且默认概率是 30', o.opened === true && o.p0before === '30',
    o.opened + ' / ' + o.p0before);
  ok('★ ⑥ 保存规则 → 徽章变「自定义」且无报错', /自定义/.test(o.badgeAfter) && o.errAfter === '',
    o.badgeAfter + ' / ' + JSON.stringify(o.errAfter));
  ok('★ ⑦ 游戏页那份 /rules.json 立刻跟着变（客户端下一局就吃新规则）',
    o.gameCustom === true && o.gameP0 === 40, o.gameCustom + ' / p0=' + o.gameP0);
  ok('★ ⑧ 护栏（页面级）：概率之和 ≠ 100 → 保存按钮禁用', o.btnDisabled === true,
    'disabled=' + o.btnDisabled + ' / ' + JSON.stringify(o.probSumBad));
  ok('★ ⑨ 护栏（服务端级）：非法提交被 400 拒绝', o.badStatus === 400, String(o.badStatus));
  ok('★ ⑩ 非法提交没把上一套规则冲掉（仍是自定义 p0=40）',
    o.stillCustom === true && o.stillP0 === 40, o.stillCustom + ' / p0=' + o.stillP0);
  ok('★ ⑪ 恢复默认 → 游戏页 /rules.json 变回默认', /默认/.test(o.badgeReset)
    && o.gameCustomAfterReset === false, o.badgeReset + ' / custom=' + o.gameCustomAfterReset);

  /* 穿透卡片（V16.1）：没开时徽章是「未开启」、开按钮可点、关按钮禁用、有路径框 */
  ok('★ ⑫ 穿透卡片在，且默认状态正确（未开启 / 只有「开」可点）',
    /未开启/.test(o.tunBadge) && o.tunStartDisabled === false && o.tunStopDisabled === true,
    o.tunBadge + ' / start=' + o.tunStartDisabled + ' stop=' + o.tunStopDisabled);
  ok('★ ⑬ 有 cpolar 路径框与「浏览 / 自动查找」两个按钮',
    o.tunBinShown === 'yes' && o.hasPick === true, o.tunBinShown + ' / ' + o.hasPick);

  /* ⑧ 异地绝对进不来：游戏端口取不到管理台；局域网 IP 连不上管理端口 */
  const pub = await httpGet(PORT, '/admin.html');
  ok('★ ⑭ 游戏端口取 /admin.html → 404（穿透出去了也拿不到管理台）', pub.status === 404,
    String(pub.status));

  const ip = lanIP();
  if (ip) {
    const blocked = await new Promise(res => {
      const s = net.connect({ host: ip, port: ADMIN_PORT });
      s.setTimeout(1500);
      s.on('connect', () => { s.destroy(); res(false); });
      s.on('timeout', () => { s.destroy(); res(true); });
      s.on('error', () => res(true));
    });
    ok('★ ⑮ 局域网 IP 连不上管理端口（只监听 127.0.0.1）', blocked === true, 'ip=' + ip);
  } else {
    console.log('  · 这台机器没有局域网地址，跳过「局域网连不上管理端口」');
  }

  ok('★ ⑯ 全程没有未捕获异常 / console.error', errors.length === 0, errors.join(' | '));

  console.log('\n结果：通过 ' + PASS + ' 项，失败 ' + FAIL + ' 项。');
  console.log(FAIL === 0 ? '管理台全绿 —— 房主能改规则，且只有他自己进得来。\n'
                         : '管理台没过 —— 别打包。\n');

  cleanup();
  process.exit(FAIL === 0 ? 0 : 1);
})().catch(e => {
  console.error('\n验收异常：' + e.message + '\n');
  cleanup();
  process.exit(1);
});
