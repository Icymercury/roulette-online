/* ============================================================
 * 生死转盘 · 抓 cpolar 的公网网址（V16）
 * ------------------------------------------------------------
 *   node build/tunnel-url.js [选项]
 *
 *   常用：
 *     node build/tunnel-url.js                 打印网址
 *     node build/tunnel-url.js --copy          网址进剪贴板（直接粘给朋友）
 *     node build/tunnel-url.js --write         写进「当前房间网址.txt」
 *     node build/tunnel-url.js --check         抓到后立刻跑穿透自检（16 条）
 *     node build/tunnel-url.js --json          只输出 JSON（给别的程序用）
 *     node build/tunnel-url.js --wait          隧道还没起来就一直等（默认等 30 秒）
 *
 * 为什么它需要存在：
 *   cpolar 免费版的域名**每次重启都变**，房主得去黑窗口里肉眼找那一行
 *   Forwarding、再手抄给朋友 —— 抄错一位就连不上。这个脚本替他抄。
 *
 * 网址从哪来（两条路，都试过）：
 *   ① 结构化 API：`/api/tunnels` 返回空、`/api/v1/tunnels` 带 authtoken 返回 500
 *      —— cpolar 3.18 这两条都不给数据，靠不住。
 *   ② ✅ 控制台页面：`http://127.0.0.1:4042/` 返回的 HTML 里嵌着
 *      "PublicUrl":"https://xxx.cpolar.top" —— 那是控制台自己的数据源，稳。
 *      本脚本走这条；端口依次试 4042 / 4040 / 9200（不同版本不一样）。
 *
 * 没抓到时怎么提示：
 *   大概率是「隧道压根没开」或「cpolar 没配 authtoken」，脚本会把这两件事
 *   直接说清楚，不让房主对着空结果发呆。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORTS = [4042, 4040, 9200];
const DEFAULT_TXT = 'D:/Trae打包文件/生死转盘/当前房间网址.txt';

const argv = process.argv.slice(2);
const has = f => argv.indexOf(f) >= 0;
const WANT_COPY = has('--copy');
const WANT_WRITE = has('--write');
const WANT_CHECK = has('--check');
const WANT_JSON = has('--json');
const WAIT_FOREVER = has('--wait');
const TIMEOUT_MS = WAIT_FOREVER ? 10 * 60 * 1000 : 30 * 1000;

function say(s) { if (!WANT_JSON) console.log(s); }

/* 从控制台 HTML 里抠出 PublicUrl。
   页面里是转义过的 JSON（\"PublicUrl\":\"https://...\"），两种引号都要认。 */
function grabUrls(html) {
  const re = /\\?"PublicUrl\\?"\s*:\s*\\?"([^"\\]+)\\?"/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const u = m[1];
    if (/^https?:\/\//.test(u) && out.indexOf(u) < 0) out.push(u);
  }
  return out;
}

async function fetchConsole(port) {
  const url = 'http://127.0.0.1:' + port + '/';
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    return await r.text();
  } catch (e) { return null; }
}

/* 优先 https（朋友打开 https 页面，WebSocket 自动走 wss，不会撞混合内容） */
function pickBest(list) {
  const https = list.filter(u => u.indexOf('https://') === 0);
  return https[0] || list[0] || null;
}

function copyToClipboard(text) {
  /* Windows 的 clip 只认 stdin；用 spawn 喂进去，末尾别带多余换行 */
  try {
    const p = spawn('clip', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.stdin.on('error', () => {});
    p.stdin.end(text);
    return true;
  } catch (e) { return false; }
}

(async () => {
  if (!WANT_JSON) console.log('\n生死转盘 · 抓 cpolar 公网网址\n');

  const t0 = Date.now();
  let found = null;
  let usedPort = 0;
  let lastHtml = 0;

  while (!found && Date.now() - t0 < TIMEOUT_MS) {
    for (const port of PORTS) {
      const html = await fetchConsole(port);
      if (!html) continue;
      lastHtml = html.length;
      const urls = grabUrls(html);
      if (urls.length) { found = pickBest(urls); usedPort = port; break; }
    }
    if (!found) {
      if (WAIT_FOREVER) await new Promise(r => setTimeout(r, 1500));
      else break;   /* 默认模式：一轮就够，扫不到就报原因 */
    }
  }

  if (!found) {
    if (WANT_JSON) { console.log(JSON.stringify({ ok: false })); process.exit(1); }
    console.log('  ✗ 没抓到隧道网址。\n');
    console.log('  按顺序查这三件事：');
    console.log('    ① 隧道开了吗？  另开一个窗口跑：cpolar http 8080');
    console.log('       （服务端也得开着：双击「生死转盘-服务端.exe」，或 node server.js 8080）');
    console.log('    ② authtoken 配了吗？没配的话 cpolar 会直接退出（报「启动时没有 authtoken」）：');
    console.log('       cpolar authtoken 你的token');
    console.log('    ③ 控制台端口变了？本脚本试了 ' + PORTS.join(' / ') + ' 三个都连不上，');
    console.log('       去 cpolar 窗口看「Web Interface」那一行写的是几。');
    if (lastHtml) console.log('\n  （控制台页面能打开，但里面没有 PublicUrl —— 隧道可能刚断。）');
    process.exit(1);
  }

  if (WANT_JSON) {
    console.log(JSON.stringify({ ok: true, url: found, port: usedPort }));
    if (WANT_COPY) copyToClipboard(found);
    if (WANT_WRITE) { try { fs.writeFileSync(DEFAULT_TXT, found + '\n', 'utf8'); } catch (e) {} }
    process.exit(0);
  }

  say('  ✓ 隧道网址（来自 cpolar 控制台 127.0.0.1:' + usedPort + '）：\n');
  say('      ' + found + '\n');

  if (WANT_COPY) {
    const okc = copyToClipboard(found);
    say('  ' + (okc ? '✓ 已复制进剪贴板 —— 直接粘给朋友就行。' : '✗ 复制失败（本机没有 clip 命令），手动抄上面那行。'));
  }
  if (WANT_WRITE) {
    try {
      fs.mkdirSync(path.dirname(DEFAULT_TXT), { recursive: true });
      fs.writeFileSync(DEFAULT_TXT, found + '\n', 'utf8');
      say('  ✓ 已写进 ' + DEFAULT_TXT);
    } catch (e) { say('  ✗ 写文件失败：' + e.message); }
  }

  say('\n  朋友怎么用：浏览器打开上面这个网址 → 页面里会出现');
  say('  「本页就是这个服务器」这张卡片 → 点一下就进房间。');
  say('  （网址里没有你的 IP —— 界面和日志上都不会出现。）');

  if (WANT_CHECK) {
    say('\n  —— 接着跑穿透自检 ——\n');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'build', 'verify-tunnel.js'), found],
      { cwd: ROOT, stdio: 'inherit' });
    process.exit(r.status == null ? 1 : r.status);
  }

  say('');
  process.exit(0);
})().catch(e => {
  if (WANT_JSON) console.log(JSON.stringify({ ok: false, err: e.message }));
  else console.error('\n脚本崩了：' + e.message + '\n');
  process.exit(1);
});
