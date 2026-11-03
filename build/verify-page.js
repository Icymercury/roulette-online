/* ============================================================
 * 生死转盘 · 网页真机验收（headless 浏览器）
 * ------------------------------------------------------------
 * 为什么必须有这个脚本：
 *   五套 Node 测试都在「假 DOM」里跑，而假 DOM 不校验类型 ——
 *   `appendChild(一个数组)` 假 DOM 照收不误，真浏览器直接抛 TypeError。
 *   2026-09-24 就是这么翻的车：client.html 的 buildWheel 里
 *   `wheel.appendChild(t)`（t 是坐标数组，应为文字节点 tx），
 *   导致 init() 第一行就崩、render() 从没执行过、大厅遮罩永久盖住连接栏，
 *   两个端（PC exe / 手机 APK）一起报废，452 条断言全绿却没人发现。
 *   所以凡是「改了 client.html」，都必须过这一关。
 *
 * 它做的检查（全部在真 Chromium 内核里）：
 *   ① 控制台没有未捕获异常；
 *   ② init() 跑完了（#log 里有启动日志）；
 *   ③ #addr 输入框真的能被点到（elementFromPoint 命中的就是它自己）
 *      —— 这是「用户能不能填服务器地址」的唯一可靠判据；
 *   ④ 转盘真的画出来了：5 个扇形 + 5 个事件文字 + 中心「命运」；
 *   ⑤ 大厅遮罩没有在未连接时挡着。
 *
 * 用法： node build/verify-page.js [页面路径] [宽高]
 *       默认 client.html，390x844（手机竖屏）
 * 退出码：0 = 全过 / 1 = 有失败 / 2 = 找不到浏览器（跳过，不算失败）
 * ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PAGE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'client.html');
const SIZE = process.argv[3] || '390,844';

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

const browser = BROWSERS.find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
if (!browser) {
  console.log('\n找不到 Edge / Chrome —— 跳过真机验收（不视为失败）。\n');
  process.exit(2);
}

/* ---------------- 造一个带探针的副本 ----------------
   放进系统临时目录，避免在项目里留垃圾；engine.js 一起拷过去，
   否则页面里的 <script src="engine.js"> 加载不到。 */
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-verify-'));
const target = path.join(stage, path.basename(PAGE));
let html = fs.readFileSync(PAGE, 'utf8');

/* 页面里用相对路径引用的同目录资源要一起搬过去，否则 <script src="engine.js">
   加载不到 —— 那样验的就是个残页，白测。 */
for (const dep of ['engine.js', 'manifest.json', 'sw.js', 'icon-192.png']) {
  const src = path.join(path.dirname(PAGE), dep);
  try { if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(stage, dep)); } catch (e) {}
}

/* ① 错误捕获器，插在 <head> 之后，早于页面底部的主脚本 */
const catcher = `<script>
window.__errs = [];
window.onerror = function (m, s, l, c, e) {
  window.__errs.push(String(m) + ' @行' + l + ':' + c);
  return false;
};
window.addEventListener('unhandledrejection', function (ev) {
  window.__errs.push('promise: ' + ev.reason);
});
/* 页面里有 try/catch 兜底的地方不会触发 onerror，但会 console.error ——
   必须一并抓住，否则「兜底把错误藏起来」会让这个验收形同虚设。 */
(function () {
  var raw = console.error.bind(console);
  console.error = function () {
    var parts = Array.prototype.map.call(arguments, function (a) {
      if (a instanceof Error) return (a.message || '') + ' | ' + String(a.stack || '').replace(/\\s+/g, ' ').slice(0, 260);
      try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
    });
    window.__errs.push('console.error: ' + parts.join(' '));
    raw.apply(console, arguments);
  };
})();
<\/script>`;
html = html.replace(/<head>/i, '<head>' + catcher);

/* ② 探针，插在 </body> 之前 —— 此时主脚本已经同步跑完 */
const probe = `<script>
(function () {
  function reachable(id) {
    var el = document.getElementById(id);
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top === el;
  }
  function txt(el) { return el ? (el.textContent || '') : ''; }
  var w = document.getElementById('wheel');
  var ov = document.getElementById('lobbyOverlay');
  var texts = w ? Array.prototype.slice.call(w.querySelectorAll('text')) : [];
  var out = {
    errs: window.__errs || [],
    paths: w ? w.querySelectorAll('path').length : -1,
    labels: texts.map(function (t) { return t.textContent; }),
    overlayClass: ov ? ov.className : null,
    addrReachable: reachable('addr'),
    joinBtnReachable: reachable('joinBtn'),
    addrValue: (document.getElementById('addr') || {}).value || '',
    backOK: reachable('btnBack'),
    backHref: (document.getElementById('btnBack') || {}).getAttribute
      ? (document.getElementById('btnBack').getAttribute('href') || '') : '',
    initLogged: /填好名字/.test(txt(document.getElementById('log'))),
    logText: txt(document.getElementById('log')).slice(0, 300),
    bodyTail: txt(document.body).slice(0, 60),
    /* V17：顶部血量条。单人页开局就应该画出来；联机页没连上时它是空的（正常）。 */
    hpOK: (function () {
      var box = document.getElementById('hpCell') || document.getElementById('hpStrip');
      if (!box) return false;
      var r = box.getBoundingClientRect();
      return !!(r.width && r.height);
    })(),
    hpFillWidth: (document.getElementById('hpFill') || { style: {} }).style.width || '',
    hpText: txt(document.getElementById('hpTxt')).slice(0, 30)
  };
  document.title = 'PROBE>>>' + JSON.stringify(out);
})();
<\/script>`;
html = html.replace(/<\/body>/i, probe + '</body>');
fs.writeFileSync(target, html, 'utf8');

/* ---------------- 跑浏览器 ---------------- */
const url = 'file:///' + target.replace(/\\/g, '/');
const args = [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--virtual-time-budget=5000',
  '--user-data-dir=' + path.join(stage, 'prof'),
  '--window-size=' + SIZE,
  '--dump-dom', url,
];

let dom = '';
try {
  dom = execFileSync(browser, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) {
  dom = (e.stdout || '') + '';
}

function unesc(s) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
const m = dom.match(/<title>([\s\S]*?)<\/title>/i);
const title = m ? unesc(m[1]) : '';

console.log('\n生死转盘 · 真机验收（' + path.basename(browser) + '，窗口 ' + SIZE + '）');
console.log('页面：' + PAGE + '\n');

if (title.indexOf('PROBE>>>') !== 0) {
  ok('探针跑起来了', false, 'title = ' + JSON.stringify(title.slice(0, 120)));
  console.log('\n真机验收未通过：' + FAIL + ' 项失败。\n');
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
  process.exit(1);
}
const R = JSON.parse(title.slice('PROBE>>>'.length));

/* V16：单人页（roulette-wheel.html）没有地址框 /「进入房间」按钮 / 大厅遮罩 ——
   它从头到尾连不上任何服务端。拿联机页那套判据去验它只会全红（不是页面坏了）。
   所以按页面自己有没有 #addr 来分流：有 = 联机页，没有 = 单人页。 */
const IS_SOLO = !/id="addr"/.test(fs.readFileSync(PAGE, 'utf8'));

ok('控制台没有未捕获异常', R.errs.length === 0, R.errs.join(' | '));

if (IS_SOLO) {
  console.log('  （单机页判据：这一页不该有地址框 —— 单人模式不连服务端）\n');
  ok('init() 跑到底了（日志里有「新的赌局开始」）',
    /新的赌局开始/.test(R.logText), JSON.stringify(R.logText.slice(0, 80)));
  ok('转盘画出了 5 个扇形', R.paths === 5, '实际 ' + R.paths);
  ok('转盘画出了 5 个事件文字', R.labels.length === 6, '实际 ' + JSON.stringify(R.labels));
  ok('中心「命运」在', R.labels.indexOf('命运') >= 0);
  ok('★ 单人页里没有地址框（证明它连不上服务端）', R.addrValue === '' && R.addrReachable === false,
    'addr=' + JSON.stringify(R.addrValue) + ' reachable=' + R.addrReachable);
  ok('★ 单人页有「回到启动页」的出口', R.backOK === true, 'backOK=' + R.backOK);
  ok('★ 单人页有「回到启动页」的出口 · 是相对路径（APK 里才不会 404）',
    R.backHref === 'start.html', JSON.stringify(R.backHref));
  ok('★ V17 血量搬到了顶部（这一格在真浏览器里真的占位置）', R.hpOK === true, 'hpOK=' + R.hpOK);
  ok('顶部血量条开局是满的（7 / 7 → 100%）',
    R.hpFillWidth === '100%' && /7\s*\/\s*7/.test(R.hpText),
    '宽=' + JSON.stringify(R.hpFillWidth) + ' 文本=' + JSON.stringify(R.hpText));

  console.log('\n结果：通过 ' + PASS + ' 项，失败 ' + FAIL + ' 项。');
  console.log(FAIL === 0 ? '真机验收全绿 —— 页面在真浏览器里是活的。\n'
                         : '真机验收没过 —— 别打包，先修。\n');
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
  process.exit(FAIL === 0 ? 0 : 1);
}

ok('init() 跑到底了（有启动日志）', R.initLogged, JSON.stringify(R.bodyTail));
ok('转盘画出了 5 个扇形', R.paths === 5, '实际 ' + R.paths);
ok('转盘画出了 5 个事件文字', R.labels.length === 6, '实际 ' + JSON.stringify(R.labels));
ok('中心「命运」在', R.labels.indexOf('命运') >= 0);
ok('★ 服务器地址输入框点得到（没被遮挡）', R.addrReachable === true, 'addrReachable=' + R.addrReachable);
ok('★「进入房间」按钮点得到', R.joinBtnReachable === true, 'joinBtnReachable=' + R.joinBtnReachable);
/* file:// 场景（= 安卓壳里的样子）拿不到 location.host，地址框就该是空的，
   并且必须给出「去哪找地址」的提示，否则用户根本不知道该填什么。 */
/* V15：地址框永远是空的（界面上不出现任何 IP / 协议字符串），
   file:// 下拿不到 location.host，那就必须给出「去哪找地址」的提示。 */
ok('★ 地址框留空且给出「去哪找地址」的提示（file:// 场景）',
  R.addrValue === '' && /服务端\.exe/.test(R.logText),
  'addr=' + JSON.stringify(R.addrValue) + ' log=' + JSON.stringify(R.logText.slice(0, 90)));
ok('未连接时大厅遮罩不挡路', String(R.overlayClass).indexOf('show') < 0, 'class=' + R.overlayClass);

console.log('\n结果：通过 ' + PASS + ' 项，失败 ' + FAIL + ' 项。');
console.log(FAIL === 0 ? '真机验收全绿 —— 页面在真浏览器里是活的。\n'
                       : '真机验收没过 —— 别打包，先修。\n');

try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
process.exit(FAIL === 0 ? 0 : 1);
