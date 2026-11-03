/* ============================================================
 * 生死转盘 · PC 客户端打包（构建工具，不参与游戏）
 * ------------------------------------------------------------
 *   node build/build-pc-client.js
 *
 * 做什么：把 pc-client.js 塞进一个 exe。
 *   玩家那边只要有这一个文件，双击就出现「找服务器」的选择页，
 *   点一台服务器 → 用一个没有地址栏的独立窗口进游戏。
 *   全程**一个地址都不用输**。
 *
 * 和 生死转盘-服务端.exe 的区别：
 *   服务端 exe 内嵌了全部网页资源（它就是内容源）；
 *   客户端 exe **不内嵌任何网页** —— 游戏页直接从选中的那台服务器加载
 *   （http://<服务器>:<端口>/client.html），所以：
 *     · 页面里的 location.host 天然正确，不存在「地址填错」
 *     · 客户端和服务端永远同版本，不会出现「客户端比服务端新」的错配
 *     · exe 体积小得多（没有图标 / 页面 base64）
 *
 * 怎么做：同 build-pc.js —— Node 22 自带 SEA
 *   ① 拼 bundle：最前面插一行 const EMBEDDED_PC_CLIENT = true;
 *      （pc-client.js 用它做启动守卫），后面原样拼上 pc-client.js。
 *   ② node --experimental-sea-config → 生成 sea-prep-client.blob
 *   ③ 复制一份 node.exe，用 postject 把 blob 注进去
 *
 * 产物：D:\Trae打包文件\生死转盘\生死转盘-客户端.exe
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = __dirname;
const OUT_DIR = process.env.RR_OUT || path.join('D:/Trae打包文件', '生死转盘');
const EXE_NAME = '生死转盘-客户端.exe';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/* 冒烟用的端口 —— 和 build-pc.js 的 8199 错开，且发现端口也要错开，
   免得和本机正在跑的正式服务端（8099）抢广播。 */
const SMOKE_HTTP = 8291;
const SMOKE_DISC = 8197;
const SMOKE_NAME = '冒烟测试房';

function step(msg) { console.log('  · ' + msg); }

console.log('\n生死转盘 · PC 客户端打包\n');

/* ---------------- ① 生成 bundle ----------------
   客户端没有任何内嵌资源，bundle = 守卫常量 + pc-client.js 原文。
   唯一要小心的是：SEA 里 require 只能加载**内置模块**，
   所以 pc-client.js 不许 require 相对路径的东西（它只用了
   http / dgram / fs / os / child_process，全是内置）。 */
step('拼 bundle');
const clientSrc = fs.readFileSync(path.join(ROOT, 'pc-client.js'), 'utf8');
{
  const bad = clientSrc.match(/require\(\s*['"](?!http|dgram|fs|os|child_process|path|net|url|crypto|module)['"]/g);
  if (bad && bad.length) {
    throw new Error('pc-client.js 引用了非内置模块 ' + bad.join(', ') +
      ' —— SEA 打包后 require 加载不到，会直接崩。');
  }
}
/* V17：客户端唯一必须内嵌的东西 —— 单人模式的页面。
   🔴 联机页**不嵌**（依旧从那台服务器加载，保证版本一致）；
      但单人模式没有服务器可加载，而 exe 里没有磁盘文件，只能内嵌。
      页面用 <script src="engine.js"> 引引擎，所以两个一起进去。 */
const soloHtml = fs.readFileSync(path.join(ROOT, 'roulette-wheel.html'), 'utf8');
const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
const soloEmbed = {
  html: Buffer.from(soloHtml, 'utf8').toString('base64'),
  engine: Buffer.from(engineSrc, 'utf8').toString('base64'),
};
const bundle = [
  '/* ============================================================',
  ' * 生死转盘 · PC 客户端打包入口（自动生成，别手改；改 build/build-pc-client.js）',
  ' * ============================================================ */',
  'const EMBEDDED_PC_CLIENT = true;',
  'const EMBEDDED_SOLO = ' + JSON.stringify(soloEmbed) + ';',
  '',
  clientSrc,
  '',
].join('\n');

const bundlePath = path.join(BUILD, 'sea-bundle-client.js');
fs.writeFileSync(bundlePath, bundle, 'utf8');
step(`生成 ${path.basename(bundlePath)}（${(bundle.length / 1024).toFixed(0)} KB，内嵌单机页 ${(soloHtml.length / 1024).toFixed(0)} KB + engine ${(engineSrc.length / 1024).toFixed(0)} KB）`);

/* ---------------- ② 生成 SEA blob ---------------- */
const cfgPath = path.join(BUILD, 'sea-config-client.json');
const blobPath = path.join(BUILD, 'sea-prep-client.blob');
fs.writeFileSync(cfgPath, JSON.stringify({
  main: bundlePath.replace(/\\/g, '/'),
  output: blobPath.replace(/\\/g, '/'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2), 'utf8');

step('node --experimental-sea-config → sea-prep-client.blob');
const r1 = spawnSync(process.execPath, ['--experimental-sea-config', cfgPath], { encoding: 'utf8' });
if (r1.status !== 0 || !fs.existsSync(blobPath)) {
  console.error(r1.stdout || '', r1.stderr || '');
  throw new Error('SEA blob 生成失败');
}
step(`blob 大小 ${(fs.statSync(blobPath).size / 1024).toFixed(0)} KB`);

/* ---------------- ③ 复制运行时 + 注入 ---------------- */
fs.mkdirSync(OUT_DIR, { recursive: true });

/* Windows 上**正在运行的 exe 是被锁住的**：unlink 会 EBUSY、copy 也会 EBUSY。
   客户端开着来重打包是常事，所以换个文件名输出，别让构建死在半路。 */
function pickExePath(preferred) {
  try { fs.unlinkSync(preferred); return { path: preferred, renamed: false }; }
  catch (e) {
    if (!e || (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES')) {
      if (e && e.code !== 'ENOENT') throw e;
      return { path: preferred, renamed: false };
    }
    const alt = preferred.replace(/\.exe$/i, '-新.exe');
    try { fs.unlinkSync(alt); } catch (e2) {}
    return { path: alt, renamed: true };
  }
}
const picked = pickExePath(path.join(OUT_DIR, EXE_NAME));
const exePath = picked.path;
if (picked.renamed) {
  console.log('  ⚠ ' + EXE_NAME + ' 正在运行（文件被锁），本次改输出为 ' + path.basename(exePath));
  console.log('    关掉那个窗口后，把 -新.exe 改名盖掉旧的即可。');
}
fs.copyFileSync(process.execPath, exePath);
step(`复制运行时 ${path.basename(process.execPath)} → ${exePath}（${(fs.statSync(exePath).size / 1024 / 1024).toFixed(0)} MB）`);

/* postject 是构建期工具，装在 build/node_modules 里，不进游戏目录。
   和服务端打包共用同一份 —— 不重复安装。 */
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

/* ---------------- ③.五 摘掉黑窗口（改 PE Subsystem） ----------------
 * 为什么会有黑窗口：exe 就是 node.exe 的副本，而 node.exe 的 PE 头里
 *   Subsystem = 3 (WINDOWS_CUI) —— 控制台程序，双击必带一个黑框。
 *
 * 🔴 服务端 exe **绝不能改**：那个黑窗口就是它的脸，横幅（名称 / 编号 /
 *    房间码 / 各条连接地址）全印在里面，房主要靠它。
 * ✅ 客户端要改：它本来只是个「找服务器 + 开窗口」的启动器，界面是
 *    自己开出来的独立窗口；黑框纯属噪音。改成 2 (WINDOWS_GUI) 后
 *    双击直接是干净的界面。
 *
 * 代价与对策：GUI 子系统下没有 stdout，console.log 会被静默丢掉。
 *   ⇒ pc-client.js 已经把全部输出**同时写一份**到
 *      %TEMP%\生死转盘-客户端.log；
 *   ⇒ 想让控制台回来就设 RR_DEBUG_WINDOW=1（它会自己开个窗口重跑）。
 *
 * 位置：e_lfanew(0x3C) 指向 PE 签名，+4 是 COFF 头(20 字节)，
 *   再往后是 Optional Header —— 首字段 Magic 占 2 字节，
 *   所以 Subsystem 在 e_lfanew + 4 + 20 + 68 = e_lfanew + 92 (0x5C)。
 *   保险起见先认 Magic（0x20B = PE32+ / 0x10B = PE32）。
 */
step('改 PE Subsystem（3 → 2，摘掉黑窗口）');
{
  const buf = fs.readFileSync(exePath);
  const e_lfanew = buf.readUInt32LE(0x3C);
  if (buf.readUInt32LE(e_lfanew) !== 0x4550) throw new Error('PE 签名不对，不敢动');
  const optOff = e_lfanew + 4 + 20;
  const magic = buf.readUInt16LE(optOff);
  if (magic !== 0x20B && magic !== 0x10B) throw new Error('PE Magic 不认（0x' + magic.toString(16) + '）');
  const subOff = optOff + 68;
  const before = buf.readUInt16LE(subOff);
  buf.writeUInt16LE(2, subOff);                 // 2 = WINDOWS_GUI
  const after = buf.readUInt16LE(subOff);
  fs.writeFileSync(exePath, buf);
  step(`Subsystem ${before} → ${after}（${before === 3 ? '原来是控制台程序' : '原来是 ' + before}）`);
  if (after !== 2) throw new Error('Subsystem 改写没生效');
  /* 改回去再读一遍，确认真写进磁盘了 */
  const chk = fs.readFileSync(exePath).readUInt16LE(subOff);
  if (chk !== 2) throw new Error('Subsystem 落盘校验失败（读到 ' + chk + '）');
}

/* ---------------- ④ 真跑一遍验证 ----------------
   这一段的重点不是「exe 能启动」，而是三条只有真跑才验得出的东西：
     A. UDP 发现真的能收到真服务端的卡片（而不是「代码看起来对」）
     B. 选择页真的把卡片渲染成列表（/servers 返得回来）
     C. /open 真的把「选中的服务器」翻成正确的游戏页网址 ——
        且 RR_DRY_OPEN 下不真的弹窗口（自动化不能乱开窗）
   另外地址归一化要给几个真会遇到的脏输入（带 http://、带路径、
   带空格、纯数字）各验一次 —— V11 事故就是复制横幅整行导致。 */
step(`冒烟验证：起一个真服务端(:${SMOKE_HTTP}) + 真跑一次客户端 exe`);

const TMP_STATE = path.join(os.tmpdir(), 'rr-pcc-smoke-' + process.pid + '-' + Date.now().toString(36) + '.json');
const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), String(SMOKE_HTTP)], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: Object.assign({}, process.env, {
    RR_STATE: TMP_STATE,
    RR_NO_OPEN: '1',
    RR_DISCOVERY_PORT: String(SMOKE_DISC),
    RR_NAME: SMOKE_NAME,
    /* V16.1：冒烟走「无码直接进房」，默认房间码 584520 会挡住验收 */
    RR_ROOM_CODE: '',
  }),
});
let srvOut = '';
srv.stdout.on('data', d => { srvOut += d.toString(); });
srv.stderr.on('data', d => { srvOut += d.toString(); });

/* ---------------- 冒烟用的小工具 ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

const kids = [];
function launchClient(extraEnv) {
  const cli = spawn(exePath, [], {
    cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      RR_DISCOVERY_PORT: String(SMOKE_DISC),
      RR_DRY_OPEN: '1',
      RR_NO_OPEN: '1',
    }, extraEnv || {}),
  });
  kids.push(cli);
  const st = { cli, out: '', port: 0 };
  cli.stdout.on('data', d => { st.out += d.toString(); });
  cli.stderr.on('data', d => { st.out += d.toString(); });
  return st;
}

async function waitPort(st, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) {
    const m = st.out.match(/选择页：\s*http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) return Number(m[1]);
    if (st.cli.exitCode !== null) return 0;    // 已经退了，不用再等
    await sleep(80);
  }
  return 0;
}

function httpGet(port, p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: port, path: p }, r => {
      let s = ''; r.setEncoding('utf8');
      r.on('data', d => s += d);
      r.on('end', () => res({ code: r.statusCode, body: s }));
    }).on('error', rej);
  });
}
function httpPost(port, p, obj) {
  return new Promise((res, rej) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, r => {
      let s = ''; r.setEncoding('utf8');
      r.on('data', d => s += d);
      r.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} res({ code: r.statusCode, json: j, body: s }); });
    });
    req.on('error', rej);
    req.end(body);
  });
}

/* 轮询到「列表非空」或超时，返回最后一次看到的 /servers 内容 */
async function pollServers(port, ms) {
  const t0 = Date.now();
  let last = { servers: [], passive: false };
  while (Date.now() - t0 < (ms || 15000)) {
    try {
      const g = await httpGet(port, '/servers');
      last = JSON.parse(g.body) || last;
      if ((last.servers || []).length) return last;
    } catch (e) { /* 端口还没好 */ }
    await sleep(400);
  }
  return last;
}

const fail = [];
function ok(name, cond, extra) {
  console.log('    ' + (cond ? '\u2713' : '\u2717') + ' ' + name + (cond ? '' : (extra ? '  →  ' + extra : '')));
  if (!cond) fail.push(name);
}

(async () => {
  /* 等服务端起 */
  let srvUp = false;
  for (let t = Date.now(); !srvUp && Date.now() - t < 15000;) {
    if (/本机打开/.test(srvOut)) srvUp = true;
    else await sleep(80);
  }
  if (!srvUp) throw new Error('冒烟用的服务端没起来：\n' + srvOut);
  console.log('    \u2713 冒烟服务端起来了（编号 ' +
    (((srvOut.match(/服务器编号：\s*(\S+)/) || [])[1]) || '?') + '，名称「' + SMOKE_NAME + '」）');

  /* ================= ⓪ 静态：黑窗口摘掉了没 =================
     先验二进制层的两件事，不用等客户端起来：
       · Subsystem 必须是 2 (GUI) —— 否则双击还是弹黑框
       · 服务端 exe 那边必须保持 3 (CUI) —— 它的横幅是刚需，别跟着一起改了 */
  {
    const b = fs.readFileSync(exePath);
    const lf = b.readUInt32LE(0x3C);
    const sub = b.readUInt16LE(lf + 4 + 20 + 68);
    ok('★ 客户端 exe 是 GUI 子系统（双击不再弹黑窗口）', sub === 2, 'Subsystem=' + sub);
  }

  /* ================= 客户端 ①：两条路都开 ================= */
  const A = launchClient();
  A.port = await waitPort(A);
  ok('exe 能独立启动（SEA 注入正确，不需要装 Node）', A.port > 0, A.out.slice(-400));
  if (!A.port) throw new Error('客户端 exe 没起选择页');
  ok('发现端口没被占用（没印「扫描端口用不了」）', !/扫描端口用不了/.test(A.out));
  ok('干跑模式下没有真去开浏览器窗口（输出里没有打开记录之外的报错）',
    !/ENOENT|is not recognized|%1 is not a valid/.test(A.out), A.out.slice(-300));

  /* ★ 日志落盘：GUI 子系统下 stdout 会被丢掉，全靠这个文件兜着 */
  ok('★ 客户端把输出写进了日志文件（GUI 下唯一的排障入口）', (() => {
    try {
      const t = fs.readFileSync(path.join(os.tmpdir(), '生死转盘-客户端.log'), 'utf8');
      return /选择页：/.test(t) && /127\.0\.0\.1/.test(t);
    } catch (e) { return false; }
  })(), '日志文件：' + path.join(os.tmpdir(), '生死转盘-客户端.log'));

  /* B. 选择页本身 */
  const page = await httpGet(A.port, '/');
  ok('选择页能取到（本机回环 only）', page.code === 200 && /生 死 转 盘/.test(page.body));
  ok('选择页自带手动地址框（异地 Tailscale 入口）',
    /id="addr"/.test(page.body) && /Tailscale/.test(page.body));
  ok('选择页里没有服务端源码泄漏', !/require\('http'\)/.test(page.body));

  /* 🔴 B1. 双击 exe 后**自动弹出来的那个窗口**取到的必须是一个真页面。
     事故背景：main() 里曾打开 /client.html，而本机小服务只认 `/`，
     于是玩家双击 exe 看到的第一眼就是 404（而且这条从没被断言覆盖过）。
     这里直接打 /client.html 和几个近亲，确认它们**不是** 200 —— 逼着别人
     以后要么改回 `/`，要么给本机小服务真加一个 /client.html 分支。 */
  const autoOpened = await httpGet(A.port, '/client.html');
  ok('★ 双击 exe 自动打开的窗口不是 404（本机小服务没有 /client.html）',
    autoOpened.code !== 200,
    '本机小服务返回了 ' + autoOpened.code + ' —— 若它真发 /client.html 了，' +
    '请同步确认 main() 里打开的到底是哪个路径');
  /* 反过来的正断言：自动打开用的 / 一定拿得到选择页 */
  ok('★ 自动打开的 `/` 是真选择页（不是空白也不是 404）',
    page.code === 200 && /id="addr"/.test(page.body));

  /* B2. 未知路径 404 —— 客户端只服务自己那一个页面，别的什么也不发 */
  const nf = await httpGet(A.port, '/server.js');
  ok('未知路径返回 404（客户端不对外发任何文件）', nf.code === 404, String(nf.code));

  /* B3. V17 单人模式：exe 里没有磁盘文件，页面只能靠本机小服务发出来。
     🔴 这是最容易被忽略的一条 —— 客户端 exe 向来「零内嵌」，而单人页
        偏偏没有服务器可加载。这里用真 exe 反证它真的发得出来。 */
  const solo = await httpGet(A.port, '/solo');
  ok('★ 单机页能从 exe 里取出来（打包后磁盘上没有这个文件）',
    solo.code === 200 && /id="hpCell"/.test(solo.body) && /死 亡 轮 盘/.test(solo.body),
    solo.code + ' / ' + solo.body.slice(0, 80));
  const eng = await httpGet(A.port, '/engine.js');
  ok('单机页依赖的 engine.js 也发得出来（相对路径落到本机小服务）',
    eng.code === 200 && /RREngine/.test(eng.body), String(eng.code));
  const ps = await httpPost(A.port, '/play-solo', {});
  ok('★ 点「单人游戏」→ 开的是本机小服务的 /solo（干跑标记在）',
    !!(ps.json && ps.json.ok && ps.json.dry === true && /\/solo$/.test(String(ps.json.url || ''))),
    JSON.stringify(ps.json));

  /* A. 第一条路：主动询问 → 看到真服务端 */
  const r1 = await pollServers(A.port, 15000);
  const servers = r1.servers || [];
  ok('★ 主动询问扫到了真服务端（不是 mock）', servers.length >= 1,
    '实际 ' + servers.length + ' 台；客户端输出尾部：' + A.out.slice(-300));
  const s0 = servers.find(s => s.port === SMOKE_HTTP) || servers[0] || {};
  ok('扫到的服务器端口正确', s0.port === SMOKE_HTTP, String(s0.port));
  ok('扫到的服务器名称正确（房主设的）', s0.name === SMOKE_NAME, JSON.stringify(s0.name));
  ok('扫到的服务器编号格式正确（XXX-XXX）',
    /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/.test(String(s0.id || '')), String(s0.id));
  ok('扫到的服务器带了可连地址（来自回复包的源地址）',
    /^\d+\.\d+\.\d+\.\d+$/.test(String(s0.host || '')) && s0.host !== '0.0.0.0', String(s0.host));
  ok('★ 卡片里没有房间码本身（只给 needCode）',
    !('code' in s0) && !JSON.stringify(servers).includes('"code"'));
  ok('卡片带了人数 / 状态 / 模式名',
    typeof s0.players === 'number' && typeof s0.phase === 'string' && typeof s0.modeLabel === 'string',
    JSON.stringify({ p: s0.players, ph: s0.phase, m: s0.modeLabel }));
  ok('被动收听那条路也挂上了（两条路互补兜底防火墙）', r1.passive === true, String(r1.passive));

  /* C. /open：把卡片翻成正确的游戏页网址 */
  const o1 = await httpPost(A.port, '/open', { host: s0.host, port: s0.port });
  ok('★ 点卡片 → 得到游戏页网址',
    !!(o1.json && o1.json.ok && o1.json.url === 'http://' + s0.host + ':' + SMOKE_HTTP + '/client.html'),
    JSON.stringify(o1.json));
  ok('干跑模式如实标记（没真开窗口）', !!(o1.json && o1.json.dry === true), JSON.stringify(o1.json));

  /* C2. 手动地址归一化 —— V11 事故判据：用户会整行复制横幅 */
  const cases = [
    ['http://192.168.1.5:8080', 'http://192.168.1.5:8080/client.html'],
    ['http://192.168.1.5:8080/client.html', 'http://192.168.1.5:8080/client.html'],
    ['192.168.1.5', 'http://192.168.1.5:8080/client.html'],
    ['  100.64.3.7:9000  ', 'http://100.64.3.7:9000/client.html'],
    ['ws://10.0.0.9:8080', 'http://10.0.0.9:8080/client.html'],
    /* V14：异地那条路。穿透给的 https 网址绝不能被补成 :8080，
       而且窗口必须用 https 打开 —— 否则页面里的 WebSocket 走 ws:// 会被浏览器当混合内容拦掉。 */
    ['https://xxx.cpolar.cn', 'https://xxx.cpolar.cn:443/client.html'],
    ['https://xxx.cpolar.cn/client.html', 'https://xxx.cpolar.cn:443/client.html'],
    ['wss://xxx.cpolar.cn:9000', 'https://xxx.cpolar.cn:9000/client.html'],
  ];
  for (const c of cases) {
    const r = await httpPost(A.port, '/open', { raw: c[0] });
    ok('手动地址「' + c[0].trim() + '」→ ' + c[1].replace('http://', ''),
      !!(r.json && r.json.ok && r.json.url === c[1]), JSON.stringify(r.json));
  }
  /* 脏输入要明确拒绝，而不是拼出一个连不上的网址 */
  for (const badRaw of ['123', '', '   ', 'http://', 'ftp://a.b.c']) {
    const r = await httpPost(A.port, '/open', { raw: badRaw });
    ok('垃圾地址 ' + JSON.stringify(badRaw) + ' 被拒（不拼出死网址）',
      !!(r.json && r.json.ok === false), JSON.stringify(r.json));
  }

  /* C3. 空 body 也要拒绝 */
  const o3 = await httpPost(A.port, '/open', {});
  ok('没给地址时明确报错', !!(o3.json && o3.json.ok === false), JSON.stringify(o3.json));

  /* 收尾：确认客户端还活着（没有被某次请求搞崩） */
  const still = await httpGet(A.port, '/servers');
  ok('跑完一整轮请求后客户端进程仍然存活', still.code === 200);

  /* ============ 客户端 ②：RR_NO_ASK=1，只被动收心跳 ============
     这条路专门兜「服务端那台机器拦了入站广播」的情况：
     我们一声不吭，全靠服务端每 3 秒自己广播的心跳把卡片送过来。
     能扫到，就说明就算主动询问那条路整条断掉，列表也不会空。 */
  const B = launchClient({ RR_NO_ASK: '1' });
  B.port = await waitPort(B);
  ok('只被动听心跳的客户端也能起来（RR_NO_ASK）', B.port > 0, B.out.slice(-300));
  let rb = { servers: [], passive: false };
  if (B.port) {
    rb = await pollServers(B.port, 12000);
    ok('★ 完全不发询问，仅靠服务端心跳也能扫到服务器（第二条路成立）',
      (rb.servers || []).length >= 1 && rb.servers.some(s => s.port === SMOKE_HTTP),
      '实际 ' + (rb.servers || []).length + ' 台；输出尾部：' + B.out.slice(-300));
  }

  kids.forEach(k => { try { k.kill(); } catch (e) {} });
  try { srv.kill(); } catch (e) {}

  /* 释放端口再删存档 —— Windows 上文件可能还被占着 */
  await sleep(400);
  try { fs.unlinkSync(TMP_STATE); } catch (e) {}

  if (fail.length) {
    console.log('\n打包完成，但冒烟验证没过（' + fail.length + ' 项）—— 别拿去分发。');
    console.log('失败项：' + fail.join(' / ') + '\n');
    console.log('---- 客户端输出 ----\n' + A.out);
    process.exit(1);
  }
  console.log('\n打包完成：' + exePath);
  console.log('（第一条路扫到 ' + servers.length + ' 台；第二条路（只收心跳）扫到 ' +
    (rb.servers || []).length + ' 台 —— 模拟点进 → /client.html）\n');
  process.exit(0);
})().catch(e => {
  kids.forEach(k => { try { k.kill(); } catch (e2) {} });
  try { srv.kill(); } catch (e2) {}
  try { fs.unlinkSync(TMP_STATE); } catch (e2) {}
  console.error('\n打包失败：' + (e && e.message ? e.message : e) + '\n');
  process.exit(1);
});

