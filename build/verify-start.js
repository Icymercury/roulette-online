/* ============================================================
 * 生死转盘 · 启动页真机验收（V16）
 * ------------------------------------------------------------
 *   node build/verify-start.js                 → 验仓库里的 start.html
 *   node build/verify-start.js <某份start.html> → 验从 APK / exe 里抽出来的那份
 *
 * 为什么单独一个脚本：
 *   verify-page.js 的探针是绑死 client.html 的（转盘 5 扇形 / 地址框 /
 *   joinBtn / 大厅遮罩），拿去验启动页只会全红。启动页有自己的一套判据。
 *
 * 它验什么（任一条不过 exit 1）：
 *   ① 探针跑起来了（页面在真浏览器里是活的，不是白屏）
 *   ② 控制台没有未捕获异常
 *   ③ ★「单人游戏」按钮点得到（elementFromPoint 命中它自己 —— V10 白屏事故的判据）
 *   ④ ★「联机游戏」按钮点得到
 *   ⑤ ★ 两个按钮的 href 是**相对路径**（安卓壳里是 file:///android_asset/www/，
 *      写成 /client.html 会 404 —— 这是 APK 上最容易翻车的一条）
 *   ⑥ ★ 启动页是纯静态：不引 engine.js、不发任何连接
 *      （单人模式"永不连服务端"这条承诺就是靠它守的）
 * ============================================================ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
/* 和 verify-page.js 同一个约定：带参数就验那一份（打包后从 APK / exe 里抽出来的），
   不带参数就验仓库里的原件。 */
const PAGE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'start.html');

let PASS = 0, FAIL = 0;
function ok(name, cond, extra) {
  if (cond) { PASS++; console.log('  ✓ ' + name); }
  else { FAIL++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

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

const browser = findBrowser();
if (!browser) {
  console.log('\n没找到 Edge/Chrome —— 启动页没能真机验收。\n');
  process.exit(2);   /* 和 verify-page 一致：找不到浏览器不阻断打包，但要警告 */
}

/* 必须放纯 ASCII 路径：项目路径含中文，file:// 打开中文路径会加载不全 */
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-start-'));
const target = path.join(stage, 'start.html');

let html = fs.readFileSync(PAGE, 'utf8');
const probe = `<script>
(function(){
  window.__errs = [];
  window.onerror = function(m){ window.__errs.push(String(m)); };
  function reachable(el){
    if(!el) return false;
    var r = el.getBoundingClientRect();
    if(!r.width || !r.height) return false;
    var top = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
    return top === el || (el.contains ? el.contains(top) : false);
  }
  var solo = document.getElementById('btnSolo');
  var online = document.getElementById('btnOnline');
  function hrefOf(el){ return el ? (el.getAttribute('href')||'') : ''; }
  var out = {
    errs: window.__errs,
    soloOK: reachable(solo),
    onlineOK: reachable(online),
    soloHref: hrefOf(solo),
    onlineHref: hrefOf(online),
    scripts: Array.prototype.slice.call(document.querySelectorAll('script[src]')).map(function(s){ return s.getAttribute('src'); }),
    title: document.title
  };
  document.title = 'PROBE>>>' + JSON.stringify(out);
})();
<\/script>`;
html = html.replace(/<\/body>/i, probe + '</body>');
fs.writeFileSync(target, html, 'utf8');

const url = 'file:///' + target.replace(/\\/g, '/');
let dom = '';
try {
  dom = execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--virtual-time-budget=5000',
    '--user-data-dir=' + path.join(stage, 'prof'),
    '--window-size=390,844',          /* 手机竖屏，跟真机一致 */
    '--dump-dom', url,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
} catch (e) { dom = (e.stdout || '') + ''; }

function unesc(s) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
const m = dom.match(/<title>([\s\S]*?)<\/title>/i);
const title = m ? unesc(m[1]) : '';

console.log('\n生死转盘 · 启动页真机验收（' + path.basename(browser) + '，390×844）\n');

if (title.indexOf('PROBE>>>') !== 0) {
  ok('探针跑起来了', false, 'title = ' + JSON.stringify(title.slice(0, 120)));
  console.log('\n启动页验收未通过。\n');
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
  process.exit(1);
}
const R = JSON.parse(title.slice('PROBE>>>'.length));

ok('① 探针跑起来了（页面是活的）', true);
ok('② 控制台没有未捕获异常', R.errs.length === 0, R.errs.join(' | '));
ok('★ ③「单人游戏」按钮点得到（没被遮挡）', R.soloOK === true, 'soloOK=' + R.soloOK);
ok('★ ④「联机游戏」按钮点得到', R.onlineOK === true, 'onlineOK=' + R.onlineOK);
ok('★ ⑤ 单人按钮跳本地页且是相对路径', R.soloHref === 'roulette-wheel.html',
  JSON.stringify(R.soloHref));
ok('★ ⑤ 联机按钮跳联机页且是相对路径', R.onlineHref === 'client.html',
  JSON.stringify(R.onlineHref));
/* 判据只看「有没有 script 标签」，别去搜 engine.js 这几个字 ——
   页脚写着「规则由 engine.js 提供」，按文字搜会把自己误伤成失败。 */
const src = fs.readFileSync(PAGE, 'utf8');
const hasScriptTag = /<script[\s>]/.test(src);
ok('★ ⑥ 启动页纯静态（页面里一个 script 都没有 —— 单人入口连不上任何服务端）',
  Array.isArray(R.scripts) && R.scripts.length === 0 && !hasScriptTag,
  '外链 ' + JSON.stringify(R.scripts) + ' / 含 script 标签 ' + hasScriptTag);

console.log('\n结果：通过 ' + PASS + ' 项，失败 ' + FAIL + ' 项。');
console.log(FAIL === 0 ? '启动页全绿 —— 在真浏览器里是活的，且单人入口不连服务端。\n'
                       : '启动页没过 —— 别打包，先修。\n');

try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
process.exit(FAIL === 0 ? 0 : 1);
