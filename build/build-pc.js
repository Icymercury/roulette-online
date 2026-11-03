/* ============================================================
 * 生死转盘 · PC 版打包（构建工具，不参与游戏）
 * ------------------------------------------------------------
 *   node build/build-pc.js
 *
 * 做什么：把 server.js + engine.js + 所有网页资源塞进一个 exe。
 *   朋友那边只要有这一个文件，双击就起服，不需要装 Node。
 *
 * 怎么做：用 Node 22 自带的 SEA（Single Executable Application）
 *   ① 生成 bundle：把 engine.js 内联成 EMBEDDED_ENGINE，把网页资源
 *      转成 base64 表 EMBEDDED_ASSETS，然后原样拼上 server.js。
 *      server.js 靠 typeof 探测这两个常量 —— 所以它自己完全不知道
 *      自己是被打包了还是被 node 直接跑的。
 *   ② node --experimental-sea-config → 生成 sea-prep.blob
 *   ③ 复制一份 node.exe，用 postject 把 blob 注进去
 *
 * 产物：D:\Trae打包文件\生死转盘\生死转盘-服务端.exe
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = __dirname;
const OUT_DIR = process.env.RR_OUT || path.join('D:/Trae打包文件', '生死转盘');
const EXE_NAME = '生死转盘-服务端.exe';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/* 打进 exe 的文件 —— 必须和 server.js 的 SERVE_EXACT / 素材扩展名对得上 */
const FILES = [
  'client.html',
  'roulette-wheel.html',
  'online-test.html',
  'engine.js',
  /* V16：启动页（首屏选单人 / 联机）+ 房主管理台。
     admin.html 不在 SERVE_EXACT 里 —— 它只由管理端口（127.0.0.1）发，公网 404。 */
  'start.html',
  'admin.html',
  'manifest.json',
  'sw.js',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
];

function step(msg) { console.log('  · ' + msg); }

console.log('\n生死转盘 · PC 版打包\n');

/* ---------------- ⓪ 先过真机验收 ----------------
   假 DOM 的 Node 测试挡不住「页面在真浏览器里是死的」这类错误：
   2026-09-24 就因为 client.html 里 appendChild 拿错变量，
   init() 第一行就抛异常，整页（PC + 手机）全废，
   而 452 条断言全绿。所以打包前必须先在真 Chromium 里跑一遍。 */
{
  const r = spawnSync(process.execPath, [path.join(BUILD, 'verify-page.js')], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status === 2) {
    console.log('  ⚠ 没找到 Edge / Chrome，跳过真机验收（不阻断打包，但有风险）\n');
  } else if (r.status !== 0) {
    console.log(out);
    throw new Error('真机验收没过 —— 页面在真浏览器里跑不起来，先修再打包');
  } else {
    const line = out.split('\n').filter(s => /结果：/.test(s))[0] || '';
    console.log('  ✓ 真机验收通过 ' + line.trim() + '\n');
  }
}

/* ---------------- ① 生成 bundle ---------------- */
step('收集资源');
const assets = {};
let total = 0;
for (const f of FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) throw new Error('缺文件：' + f + '（先跑 build/make-icons.js 生图标）');
  const buf = fs.readFileSync(p);
  assets['/' + f] = buf.toString('base64');
  total += buf.length;
}
const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

/* server.js 里那两个 typeof 探测就是靠这两个名字对上号的 */
const bundle = [
  '/* ============================================================',
  ' * 生死转盘 · 打包入口（自动生成，别手改；改 build/build-pc.js）',
  ' * 下面先内联引擎与资源，再原样拼上 server.js。',
  ' * ============================================================ */',
  'const EMBEDDED_ENGINE = (function () {',
  '  const M = require("module");',
  '  const m = new M("engine.js");',
  '  m._compile(' + JSON.stringify(engineSrc) + ', "engine.js");',
  '  return m.exports;',
  '})();',
  'const EMBEDDED_ASSETS = ' + JSON.stringify(assets) + ';',
  '',
  '/* ======================== server.js 原文 ======================== */',
  serverSrc,
  '',
].join('\n');

const bundlePath = path.join(BUILD, 'sea-bundle.js');
fs.writeFileSync(bundlePath, bundle, 'utf8');
step(`生成 ${path.basename(bundlePath)}（内联 ${FILES.length} 个文件 / ${(total / 1024).toFixed(0)} KB 原始资源，共 ${(bundle.length / 1024).toFixed(0)} KB）`);

/* ---------------- ② 生成 SEA blob ---------------- */
const cfgPath = path.join(BUILD, 'sea-config.json');
const blobPath = path.join(BUILD, 'sea-prep.blob');
fs.writeFileSync(cfgPath, JSON.stringify({
  main: bundlePath.replace(/\\/g, '/'),
  output: blobPath.replace(/\\/g, '/'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2), 'utf8');

step('node --experimental-sea-config → sea-prep.blob');
const r1 = spawnSync(process.execPath, ['--experimental-sea-config', cfgPath], { encoding: 'utf8' });
if (r1.status !== 0 || !fs.existsSync(blobPath)) {
  console.error(r1.stdout || '', r1.stderr || '');
  throw new Error('SEA blob 生成失败');
}
step(`blob 大小 ${(fs.statSync(blobPath).size / 1024).toFixed(0)} KB`);

/* ---------------- ③ 复制运行时 + 注入 ---------------- */
fs.mkdirSync(OUT_DIR, { recursive: true });

/* Windows 上**正在运行的 exe 是被锁住的**，直接覆盖会 EBUSY 崩掉整个打包。
   房主常常就把服务端开着来打包 —— 那时宁可换个文件名输出，也别让构建死掉。
   （历史教训：2026-09-24 第一次重打产物时就是这么炸的。） */
function pickExePath(preferred) {
  try {
    const fd = fs.openSync(preferred, 'r+');
    fs.closeSync(fd);
    return { path: preferred, renamed: false };
  } catch (e) {
    if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')) {
      const alt = preferred.replace(/\.exe$/i, '-新.exe');
      try { fs.unlinkSync(alt); } catch (e2) {}
      return { path: alt, renamed: true };
    }
    throw e;
  }
}
const picked = pickExePath(path.join(OUT_DIR, EXE_NAME));
const exePath = picked.path;
if (picked.renamed) {
  console.log('  ⚠ ' + EXE_NAME + ' 正在运行（文件被锁），本次改输出为 ' + path.basename(exePath));
  console.log('    关掉那个黑窗口后，把 -新.exe 改名盖掉旧的即可。');
}
fs.copyFileSync(process.execPath, exePath);
step(`复制运行时 ${path.basename(process.execPath)} → ${exePath}（${(fs.statSync(exePath).size / 1024 / 1024).toFixed(0)} MB）`);

/* postject 是构建期工具，装在 build/node_modules 里，不进游戏目录 */
const postjectCli = path.join(BUILD, 'node_modules', 'postject', 'dist', 'cli.js');
if (!fs.existsSync(postjectCli)) {
  step('安装构建期工具 postject（只在 build/ 里，不污染游戏目录）');
  if (!fs.existsSync(path.join(BUILD, 'package.json'))) {
    fs.writeFileSync(path.join(BUILD, 'package.json'),
      JSON.stringify({ name: 'rr-build', version: '1.0.0', private: true }, null, 2));
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r2 = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--prefix', BUILD, 'postject'],
    { encoding: 'utf8', cwd: BUILD, shell: process.platform === 'win32' });
  if (r2.status !== 0 || !fs.existsSync(postjectCli)) {
    console.error(r2.stdout || '', r2.stderr || '');
    throw new Error('postject 安装失败');
  }
}
step('postject 注入 SEA blob');
const r3 = spawnSync(process.execPath,
  [postjectCli, exePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', FUSE],
  { encoding: 'utf8' });
if (r3.status !== 0) {
  console.error(r3.stdout || '', r3.stderr || '');
  throw new Error('注入失败');
}
step(`exe 产出完毕（${(fs.statSync(exePath).size / 1024 / 1024).toFixed(0)} MB）`);

/* ---------------- ④ 真跑一遍验证 ---------------- */
step('冒烟验证：真跑一次 exe，看它能不能起服 + 发页面');
const TMP_STATE = path.join(require('os').tmpdir(), 'rr-sea-smoke-' + process.pid + '-' + Date.now().toString(36) + '.json');
const TEST_PORT = 8199;
const child = spawn(exePath, [String(TEST_PORT)], {
  env: Object.assign({}, process.env, { RR_STATE: TMP_STATE }),
});
let out = '';
child.stdout.on('data', d => { out += d.toString(); });
child.stderr.on('data', d => { out += d.toString(); });

(async () => {
  const http = require('http');
  const deadline = Date.now() + 15000;
  let served = null, pageOK = false, iconOK = false;
  while (Date.now() < deadline) {
    if (/本机打开/.test(out)) {
      served = true;
      break;
    }
    await new Promise(r => setTimeout(r, 120));
  }
  if (!served) {
    child.kill();
    throw new Error('exe 没能起服：\n' + out);
  }

  const get = (p) => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: TEST_PORT, path: p }, r => {
      let s = ''; r.setEncoding('utf8');
      r.on('data', d => s += d);
      r.on('end', () => res({ code: r.statusCode, body: s }));
    }).on('error', rej);
  });

  const a = await get('/client.html');
  pageOK = a.code === 200 && /生 死 转 盘/.test(a.body) && /engine\.js/.test(a.body);
  const b = await get('/icon-192.png');
  iconOK = b.code === 200;
  const c = await get('/server.js');
  const leak = c.code !== 404;

  console.log('    ' + (pageOK ? '\u2713' : '\u2717') + ' 内嵌页面能发出来');
  console.log('    ' + (iconOK ? '\u2713' : '\u2717') + ' 内嵌图标能发出来（二进制没坏）');
  console.log('    ' + (leak ? '\u2717' : '\u2713') + ' 服务端源码没被外发（/server.js → ' + c.code + '）');
  /* 横幅必须印出「一条可连地址」，且**不能印 169.254.* 死地址**（APIPA）。
     后者就是 V11 事故：4 条死地址排在真地址前面，用户照第一条输，必然连不上。 */
  const addrOK = /★ 别人连这一行/.test(out) && /\d+\.\d+\.\d+\.\d+:8199/.test(out);
  const deadOK = !/169\.254\./.test(out);
  console.log('    ' + (addrOK ? '\u2713' : '\u2717') + ' 横幅印出了可连地址（★ 别人连这一行）');
  console.log('    ' + (deadOK ? '\u2713' : '\u2717') + ' 横幅没印 169.254 死地址（V11 事故判据）');
  /* V14：横幅必须把「异地朋友」单独说清楚。局域网地址外地根本连不上，
     房主照着最显眼那行报出去，朋友必然失败 —— 所以这一块不能缺席。 */
  const remoteOK = /★ 异地朋友连这一行/.test(out) || /没检测到虚拟网卡/.test(out);
  console.log('    ' + (remoteOK ? '\u2713' : '\u2717') + ' 横幅说清了「外地朋友怎么连」（V14）');

  /* ④b 把 exe 真正发出来的那份页面取回来，再跑一遍真机验收 ——
     证明的是「打进 exe 的这一份是活的」，而不只是源文件是活的。 */
  const eng = await get('/engine.js');
  const vdir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rr-exe-page-'));
  fs.writeFileSync(path.join(vdir, 'client.html'), a.body, 'utf8');
  fs.writeFileSync(path.join(vdir, 'engine.js'), eng.body, 'utf8');
  const rv = spawnSync(process.execPath,
    [path.join(BUILD, 'verify-page.js'), path.join(vdir, 'client.html')], { encoding: 'utf8' });
  const alive = rv.status === 0 || rv.status === 2;   // 2 = 这台机器没浏览器，跳过
  console.log('    ' + (alive ? '\u2713' : '\u2717') + ' exe 发出来的页面过了真机验收'
    + (rv.status === 2 ? '（跳过：没浏览器）' : ''));
  if (!alive) console.log(rv.stdout || '');
  try { fs.rmSync(vdir, { recursive: true, force: true }); } catch (e) {}

  child.kill();
  try { fs.unlinkSync(TMP_STATE); } catch (e) {}

  if (!(pageOK && iconOK && !leak && alive && addrOK && deadOK && remoteOK)) {
    console.log('\n打包完成，但冒烟验证没过 —— 别拿去分发。\n');
    process.exit(1);
  }
  console.log('\n打包完成：' + exePath + '\n');
})().catch(e => {
  try { child.kill(); } catch (e2) {}
  console.error('\n打包失败：' + e.message + '\n');
  process.exit(1);
});
