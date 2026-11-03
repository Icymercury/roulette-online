/* ============================================================
 * 生死转盘 · 异地接入体检（V15）
 * ------------------------------------------------------------
 *   node build/check-vpn.js
 *
 * 回答三个问题：
 *   ① 这台电脑上有没有「异地网卡」（Tailscale / ZeroTier / 其他 VPN）？
 *      有的话，服务端横幅会多出一行「★ 异地朋友连这一行」，朋友填那个地址就行。
 *   ② 那条通道现在是 DIRECT（直连）还是 RELAY（中继）？
 *      RELAY 意味着数据要绕海外，延迟高风险大 —— 值得知道。
 *   ③ 局域网广播在你现在的网络里通不通？
 *      不通的话「打开就自动列出服务器」必然失效，只能手输地址。
 *      （赐红在校园网实测过：广播全被拦，但单播通 —— 这就是典型结果。）
 * ============================================================ */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { startDiscovery, listServers } = require(path.join(ROOT, 'pc-client.js'));

const VIRT = /tailscale|zerotier|wireguard|tun|tap|vpn|hamachi|openvpn|wg/i;
const DEAD = /^169\.254\./;

function kindOf(name, ip) {
  if (DEAD.test(ip)) return '死';
  if (/^127\./.test(ip)) return '本机';
  /* Tailscale 专用段 100.64/10（CGNAT） */
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return '异地';
  if (VIRT.test(name)) return '异地';
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return '同网';
  return '公网';
}

console.log('\n生死转盘 · 异地接入体检\n');

/* ---------- ① 网卡 ---------- */
console.log('① 网卡清单');
const ifs = os.networkInterfaces();
const rows = [];
for (const name of Object.keys(ifs)) {
  for (const a of ifs[name] || []) {
    if (a.family !== 'IPv4' && a.family !== 4) continue;
    rows.push({ name: name, ip: a.address, kind: kindOf(name, a.address) });
  }
}
rows.sort((x, y) => (x.kind === '异地' ? -1 : 0) - (y.kind === '异地' ? -1 : 0));
for (const r of rows) console.log('   ' + r.kind + '   ' + r.ip.padEnd(18) + '  ' + r.name);
const vpn = rows.filter(r => r.kind === '异地');
console.log('');
if (vpn.length) {
  console.log('   ✓ 检测到异地网卡 —— 服务端横幅会多出「★ 异地朋友连这一行」：');
  vpn.forEach(v => console.log('       ' + v.ip + '   ← ' + v.name));
} else {
  console.log('   ○ 没检测到异地网卡 —— 服务端横幅只会印「没检测到虚拟网卡」。');
  console.log('     想让外地朋友连进来，三条路任选其一：');
  console.log('       ① 装 Tailscale（两边都装、登同一账号）');
  console.log('       ② 装 ZeroTier（两边都装、加入同一个网络 ID）');
  console.log('       ③ 内网穿透（cpolar / 花生壳），朋友零安装、浏览器打开网址就玩');
}
console.log('');

/* ---------- ② 组网工具的状态 ---------- */
console.log('② 组网工具（装了才查）');
const tools = [
  ['Tailscale', [
    'C:/Program Files/Tailscale/tailscale.exe',
    'C:/Program Files (x86)/Tailscale/tailscale.exe',
  ], 'status'],
  ['ZeroTier', [
    'C:/Program Files/ZeroTier/One/zerotier-cli.exe',
    'C:/Program Files (x86)/ZeroTier/One/zerotier-cli.exe',
  ], 'peers'],
];
let anyTool = false;
for (const t of tools) {
  const exe = t[1].find(p => fs.existsSync(p));
  if (!exe) { console.log('   · ' + t[0] + '：没装'); continue; }
  anyTool = true;
  const r = spawnSync(exe, [t[2]], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  console.log('   ✓ ' + t[0] + '：装了（' + exe + '）');
  if (!out) { console.log('       查不到状态（可能没启动 / 需要管理员）'); continue; }
  const lines = out.split('\n').slice(0, 12);
  lines.forEach(l => console.log('       ' + l.trim()));
  /* DIRECT / RELAY 判定：ZeroTier 的 peers 里 DIRECT 就是打洞成功 */
  const relay = /RELAY/i.test(out);
  const direct = /DIRECT/i.test(out);
  if (t[0] === 'ZeroTier') {
    if (direct && !relay) console.log('       → 打洞成功（DIRECT）：广播能过，自动发现大概率能用');
    else if (relay) console.log('       → 走中继（RELAY）：延迟高风险大，建议改内网穿透');
  }
}
if (!anyTool) console.log('   （两个都没装 —— 上面 ③ 内网穿透是唯一不用装东西的路）');
console.log('');

/* ---------- ③ 广播实测 ---------- */
console.log('③ 局域网广播实测（等 7 秒）');
let sock = null;
try { sock = startDiscovery(); } catch (e) { console.log('   扫描器起不来：' + e.message); }
if (sock) {
  const t0 = Date.now();
  const wait = ms => new Promise(r => setTimeout(r, ms));
  (async () => {
    let list = [];
    while (Date.now() - t0 < 7000) {
      list = listServers();
      if (list.length) break;
      await wait(300);
    }
    try { sock.close(); } catch (e) {}
    if (list.length) {
      console.log('   ✓ 广播通 —— 扫到 ' + list.length + ' 台：');
      list.forEach(s => console.log('       ' + (s.name || '未命名') + '  ' + (s.id || '') + '  ' + s.host + ':' + s.port));
      console.log('     → 同一个 WiFi 下的朋友打开就能看见列表，自动发现是好的。');
    } else {
      console.log('   ✗ 广播不通（或此刻没有服务端在跑）');
      console.log('     先确认：电脑上双击了「生死转盘-服务端.exe」，且防火墙弹窗点了「允许」。');
      console.log('     确认之后还是扫不到 ⇒ 这个网络拦了广播（校园网 / 公共 WiFi 常见）。');
      console.log('     ⇒ 那就用手输地址：服务端黑窗口里「★ 别人连这一行」那串。');
    }
    console.log('');
    console.log('体检结束。\n');
    process.exit(0);
  })();
} else {
  console.log('\n体检结束（广播没测成）。\n');
  process.exit(0);
}
