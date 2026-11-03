/* ============================================================
 * 生死转盘 · 真机验收（需要手机 USB 连电脑 + 已授权 USB 调试）
 * ------------------------------------------------------------
 *   node build/verify-device.js            只体检，不装不改
 *   node build/verify-device.js --install  顺手把最新 APK 装上去
 *   node build/verify-device.js --run      装完启动 App 并抓日志/截图
 *
 * 干什么：
 *   ① 确认设备已授权
 *   ② 列出手机与电脑两侧的网络接口 —— 判断「USB 网络共享」有没有生效
 *   ③ 手机能不能 ping 通电脑的服务端地址
 *   ④ （--install）装 APK ；（--run）启动 App、抓 logcat、截图
 *
 * 环境变量：RR_ADB 指定 adb；RR_APK 指定 apk。
 * ============================================================ */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ADB = process.env.RR_ADB || 'D:/Android/android-sdk/platform-tools/adb.exe';
const APK = process.env.RR_APK || 'D:/Trae打包文件/生死转盘/生死转盘-手机版.apk';
const PKG = 'com.shengsizhuanpan.app';
const ACT = PKG + '/.MainActivity';
const OUT = path.join(__dirname, '..', '.workbuddy', 'tmp');
const DO_INSTALL = process.argv.includes('--install');
const DO_RUN = process.argv.includes('--run');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  console.log('  ' + (cond ? '\u2713' : '\u2717') + ' ' + name + (cond || !extra ? '' : '  →  ' + extra));
  if (cond) pass++; else { fail++; fails.push(name); }
}

/* adb 输出一律按 UTF-8 取，绕开 Windows OEM 代码页 */
function adb(args, timeoutMs) {
  const r = spawnSync(ADB, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs || 60000 });
  const out = Buffer.concat([
    r.stdout || Buffer.alloc(0),
    r.stderr || Buffer.alloc(0),
  ]).toString('utf8');
  return { code: r.status, out: out.trim() };
}

/* 同步等待。本机 `node -e` 内联是坏的，Atomics.wait 最稳 */
function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

console.log('\n生死转盘 · 真机验收\n');

if (!fs.existsSync(ADB)) {
  console.error('  找不到 adb：' + ADB + '\n  先跑：node build/fetch-platform-tools.js\n');
  process.exit(1);
}

/* ---------- ① 设备 ---------- */
const dev = adb(['devices', '-l']);
const lines = dev.out.split('\n').slice(1).filter(s => s.trim());
const authorized = lines.filter(s => /\sdevice\s|\sdevice$/.test(s));
const unauthorized = lines.filter(s => /unauthorized/.test(s));

console.log('[1] 设备');
console.log('    ' + lines.join('\n    '));

if (unauthorized.length && !authorized.length) {
  console.log('\n  ✗ 手机还没授权 USB 调试。');
  console.log('    看手机屏幕上的「允许 USB 调试吗？」弹窗 → 勾「始终允许」→ 点「允许」。');
  console.log('    没弹窗就：设置 → 开发者选项 → 撤销 USB 调试授权，再拔插一次数据线。\n');
  process.exit(1);
}
ok('有一台已授权的安卓设备', authorized.length === 1, '授权设备数=' + authorized.length);
if (authorized.length !== 1) {
  console.log('\n  设备数不对，后面的检查跳过。\n');
  process.exit(1);
}

/* ---------- ② 网络接口 ---------- */
console.log('\n[2] 手机侧网络接口');
const ipOut = adb(['shell', 'ip', '-4', 'addr']);
console.log('    ' + ipOut.out.split('\n').join('\n    '));

const phoneIps = [];
const reInet = /inet\s+(\d+\.\d+\.\d+\.\d+)/;
/* 按接口块解析 */
const blocks = ipOut.out.split(/\n(?=\d+: )/);
for (const b of blocks) {
  const m = b.match(/^\d+:\s+(\S+)/);
  const a = b.match(reInet);
  if (m && a) phoneIps.push({ iface: m[1].replace(/@.*/, ''), ip: a[1] });
}
const usbIf = phoneIps.find(p => /^(usb|rndis|eth)/i.test(p.iface));
const wifiIf = phoneIps.find(p => /^wlan/i.test(p.iface));

ok('手机拿到了 USB 共享网段地址（usb0/rndis0）', !!usbIf,
  usbIf ? '' : '只有这些：' + phoneIps.map(p => p.iface + '=' + p.ip).join(', '));
if (usbIf) console.log('    ★ USB 接口 ' + usbIf.iface + ' = ' + usbIf.ip);
if (wifiIf) console.log('    · 同时还有 WiFi ' + wifiIf.iface + ' = ' + wifiIf.ip);

/* ---------- ③ 电脑侧网卡 ---------- */
console.log('\n[3] 电脑侧网卡（找 USB 共享那张）');
const ps = spawnSync('powershell', ['-NoProfile', '-Command',
  'Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -ne "127.0.0.1"} | ' +
  'ForEach-Object { $_.IPAddress + "  <-  " + $_.InterfaceAlias }'
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const pcIfaces = (ps.stdout || '').trim();
console.log('    ' + pcIfaces.split('\n').join('\n    '));
const pcUsb = pcIfaces.split('\n').find(l => /192\.168\.(42|137)\.|远程 NDIS|Remote NDIS|Ndis/i.test(l));
ok('电脑出现了 USB 共享网卡', !!pcUsb, pcUsb ? '' : '没找到 192.168.42.x / 远程 NDIS 设备');

/* ---------- ④ 手机能不能摸到服务端 ---------- */
console.log('\n[4] 手机 → 电脑 连通性');
const candidates = [];
if (pcUsb) {
  const m = pcUsb.match(/(\d+\.\d+\.\d+\.\d+)/);
  if (m) candidates.push(m[1]);
}
for (const c of candidates) {
  const p = adb(['shell', 'ping', '-c', '2', '-W', '2', c], 20000);
  const good = /2 packets received|2 received|1 received|0% packet loss|0% loss/.test(p.out);
  ok('手机 ping 得通服务端地址 ' + c, good, p.out.split('\n').slice(0, 4).join(' / '));
  const h = adb(['shell', 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '4',
                 'http://' + c + ':8080/client.html'], 20000);
  const code = (h.out.match(/\b\d{3}\b/) || [])[0];
  if (code) ok('手机取得到 http://' + c + ':8080/client.html（' + code + '）', code === '200');
  else console.log('    · 手机没有 curl，页面检查跳过（用 App 扫描结果代替）');
}
if (!candidates.length) console.log('    · 没有 USB 共享网卡地址可测，先开「USB 网络共享」');

/* ---------- ⑤ 装 / 跑（可选） ---------- */
if (DO_INSTALL) {
  console.log('\n[5] 安装最新 APK');
  if (!fs.existsSync(APK)) {
    ok('APK 存在 ' + APK, false, '文件不在');
  } else {
    let r = adb(['install', '-r', APK.replace(/\//g, '\\')], 180000);
    if (r.code !== 0 && /INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(r.out)) {
      console.log('    · 旧版签名不同，先卸载再装');
      adb(['uninstall', PKG], 60000);
      r = adb(['install', '-r', APK.replace(/\//g, '\\')], 180000);
    }
    ok('APK 装上了', r.code === 0, r.out.split('\n').slice(-3).join(' / '));
  }
}

if (DO_RUN) {
  console.log('\n[6] 启动 App + 抓日志');
  adb(['logcat', '-c']);
  const st = adb(['shell', 'am', 'start', '-n', ACT], 30000);
  ok('App 启动了', /Starting:|Warning: Activity not started/.test(st.out) || st.code === 0,
    st.out.split('\n').slice(0, 3).join(' / '));

  console.log('    · 等 9 秒让扫描器跑两轮…');
  syncSleep(9000);

  const log = adb(['logcat', '-d', '-t', '400'], 30000);
  const keep = log.out.split('\n').filter(l =>
    /Roulette|RRNative|Discovery|Discover|Heartbeat|discover|shengsizhuanpan|WebView|chromium/i.test(l));
  console.log('\n    ---- App 相关日志 ----');
  console.log('    ' + (keep.length ? keep.join('\n    ') : '（没有相关日志）'));
  const crashed = /FATAL EXCEPTION|AndroidRuntime.*(Exception|Error)/i.test(log.out);
  ok('App 没有崩溃（无 FATAL EXCEPTION）', !crashed,
    crashed ? log.out.split('\n').filter(l => /FATAL|AndroidRuntime/.test(l)).slice(0, 5).join(' / ') : '');

  const shot = path.join(OUT, '真机-入口页.png');
  const s = spawnSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 32 * 1024 * 1024 });
  if (s.status === 0 && s.stdout && s.stdout.length > 1000) {
    fs.writeFileSync(shot, s.stdout);
    ok('截到手机屏幕 → ' + shot, true);
  } else {
    ok('截到手机屏幕', false, 'screencap 失败');
  }
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败' + (fails.length ? ' —— ' + fails.join(' / ') : '') + '\n');
process.exit(fail ? 1 : 0);
