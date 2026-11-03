/* ============================================================
 * 生死转盘 · 手机版打包（构建工具，不参与游戏）
 * ------------------------------------------------------------
 *   node build/build-android.js
 *
 * 产出一支可直接安装的 .apk。**不用 gradle** —— 本机 gradle 源连不上，
 * 所以这里把 AGP 干的活拆成原始工具链自己串：
 *
 *   aapt2 compile   资源 → 二进制
 *   aapt2 link      资源 + 清单 + assets → 未签名 APK（含 R.java）
 *   javac           编译壳的 Java 代码（对着 android.jar）
 *   d8              字节码 → classes.dex
 *   (python)        把 classes.dex 塞进 APK
 *   zipalign        4 字节对齐
 *   apksigner       签名（自动生成 debug keystore）
 *
 * 依赖（全在 D 盘，不碰 C 盘）：
 *   D:\Android\android-sdk\platforms\android-34\android.jar
 *   D:\Android\android-sdk\build-tools\34.0.0\{aapt2,d8.bat,zipalign,apksigner.bat}
 *   D:\Java21\java21\bin\{javac,keytool}
 *   （build-tools 由 build/fetch-android-tools.js 下载安装）
 *
 * 产物：D:\Trae打包文件\生死转盘\生死转盘-手机版.apk
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = __dirname;
/* 中间产物一律放纯 ASCII 路径：d8.bat / apksigner.bat 要经 cmd.exe 跑，
   中文路径过命令行有编码风险。最终产物再由 Node 拷到中文目标目录。 */
const WORK = process.env.RR_WORK || 'D:/Android/rrbuild';

const SDK = process.env.ANDROID_SDK || 'D:/Android/android-sdk';
const BT_VER = process.env.ANDROID_BT || '34.0.0';
const BT = path.posix.join(SDK, 'build-tools', BT_VER);
const ANDROID_JAR = path.posix.join(SDK, 'platforms', 'android-34', 'android.jar');

const JDK = process.env.JAVA_HOME || 'D:/Java21/java21';
const JAVAC = path.posix.join(JDK, 'bin', 'javac' + (process.platform === 'win32' ? '.exe' : ''));
const KEYTOOL = path.posix.join(JDK, 'bin', 'keytool' + (process.platform === 'win32' ? '.exe' : ''));

const AAPT2 = path.posix.join(BT, 'aapt2' + (process.platform === 'win32' ? '.exe' : ''));
const ZIPALIGN = path.posix.join(BT, 'zipalign' + (process.platform === 'win32' ? '.exe' : ''));
const D8 = path.posix.join(BT, 'd8' + (process.platform === 'win32' ? '.bat' : ''));
const APKSIGNER = path.posix.join(BT, 'apksigner' + (process.platform === 'win32' ? '.bat' : ''));
const AAPT = path.posix.join(BT, 'aapt' + (process.platform === 'win32' ? '.exe' : ''));

const OUT_DIR = process.env.RR_OUT || 'D:/Trae打包文件/生死转盘';
const APK_NAME = '生死转盘-手机版.apk';

const PKG = 'com.shengsizhuanpan.app';
const KS_PASS = 'android';
const KS_ALIAS = 'androiddebugkey';

/* 装进 App 的网页资源 —— 必须和 client.html 的相对引用对得上 */
const WEB_FILES = [
  'client.html',
  'roulette-wheel.html',
  'engine.js',
  /* V16 启动页：App 打开后先看到它（选单人 / 联机）。
     注意 admin.html 不装进 App —— 管理台只属于开服务端的那台电脑。 */
  'start.html',
  'manifest.json',
  'sw.js',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
];

function step(m) { console.log('  · ' + m); }
function die(m) { console.error('\n打包失败：' + m + '\n'); process.exit(1); }
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
/* 不用 fs.cpSync —— 本机这套 Node 22 跑 cpSync 会硬崩（exit 127，catch 都拦不住）。
   手写递归拷贝，稳。 */
function copyTree(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src)) copyTree(path.join(src, e), path.join(dst, e));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}
function sh(exe, args, opts) {
  const r = spawnSync(exe, args, Object.assign({
    encoding: 'utf8',
    env: Object.assign({}, process.env, { JAVA_HOME: JDK }),
    stdio: ['ignore', 'pipe', 'pipe'],
  }, opts || {}));
  return {
    code: r.status,
    out: (r.stdout || '') + (r.stderr || ''),
    err: r.error ? String(r.error.message) : '',
  };
}
function must(label, r) {
  if (r.err) die(label + ' 起不来：' + r.err);
  if (r.code !== 0) die(label + ' 失败（exit ' + r.code + '）：\n' + r.out);
  return r.out;
}

console.log('\n生死转盘 · 手机版（APK）打包\n');

/* ---------------- ⓪ 检查工具链 ---------------- */
step('检查工具链');
for (const [name, p] of [
  ['aapt2', AAPT2], ['zipalign', ZIPALIGN], ['d8.bat', D8],
  ['apksigner.bat', APKSIGNER], ['aapt', AAPT],
  ['android.jar', ANDROID_JAR], ['javac', JAVAC], ['keytool', KEYTOOL],
]) {
  if (!fs.existsSync(p)) {
    die('缺 ' + name + '：' + p + '\n' +
        '  → build-tools 用 node build/fetch-android-tools.js 装；\n' +
        '  → JDK 用 D:\\Java21\\java21。');
  }
}
step('工具链就绪（' + BT_VER + ' + JDK21）');

/* ---------------- ⓪b 真机验收 ----------------
   壳里内置的是 client.html 原件，所以源文件是死的 = App 装上去就是白屏加一个
   关不掉的遮罩。假 DOM 的 Node 测试挡不住这类错误，打包前先在真 Chromium 里跑。
   V16：启动页 start.html 才是 App 打开后看见的第一屏，比联机页更该验 ——
   首页是死的 = 一打开就废，玩家连"选单人还是联机"的机会都没有。 */
{
  const runs = [
    ['verify-page.js', '联机页'],
    ['verify-start.js', '启动页'],
  ];
  let browserMissing = false;
  for (const [script, label] of runs) {
    const r = spawnSync(process.execPath, [path.join(BUILD, script)], { encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status === 2) { browserMissing = true; continue; }   /* 2 = 这台机器没浏览器 */
    if (r.status !== 0) {
      console.log(out);
      die('真机验收没过（' + label + '）—— 内置页面在真浏览器里跑不起来，先修再打包');
    }
    const line = out.split('\n').filter(s => /结果：/.test(s))[0] || '';
    step('✓ ' + label + '真机验收通过 ' + line.trim());
  }
  if (browserMissing) step('⚠ 没找到 Edge / Chrome，跳过真机验收（不阻断打包，但有风险）');
}

/* ---------------- ① 铺 assets ---------------- */
rmrf(WORK);
fs.mkdirSync(path.join(WORK, 'assets', 'www'), { recursive: true });

/* aapt2 / javac 等原生工具对中文路径不稳（实测 aapt2 直接报“找不到目录”），
   所以把 android/ 工程和网页资源全部复制到纯 ASCII 的 WORK 下再编译。 */
const SRC = path.join(WORK, 'src');
copyTree(path.join(ROOT, 'android', 'res'), path.join(SRC, 'res'));
copyTree(path.join(ROOT, 'android', 'java'), path.join(SRC, 'java'));
copyTree(path.join(ROOT, 'android', 'AndroidManifest.xml'), path.join(SRC, 'AndroidManifest.xml'));
step('复制安卓工程到 ASCII 工作区（' + SRC.replace(/\\/g, '/') + '）');

let webBytes = 0;
for (const f of WEB_FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) die('缺网页资源：' + f);
  fs.copyFileSync(src, path.join(WORK, 'assets', 'www', f));
  webBytes += fs.statSync(src).size;
}
step(`铺 assets/www（${WEB_FILES.length} 个文件 / ${(webBytes / 1024).toFixed(0)} KB）`);

/* ---------------- ② 资源 → 二进制 ---------------- */
step('aapt2 compile（res/ → res.zip）');
const resZip = path.join(WORK, 'res.zip');
must('aapt2 compile', sh(AAPT2, ['compile', '--dir', path.join(SRC, 'res').replace(/\\/g, '/'), '-o', resZip.replace(/\\/g, '/')]));

/* ---------------- ③ 链接 → 未签名 APK ---------------- */
step('aapt2 link（清单 + 资源 + assets → base.apk）');
const baseApk = path.join(WORK, 'base.apk');
const genDir = path.join(WORK, 'gen');
fs.mkdirSync(genDir, { recursive: true });
must('aapt2 link', sh(AAPT2, [
  'link',
  '-o', baseApk.replace(/\\/g, '/'),
  '-I', ANDROID_JAR,
  '--manifest', path.join(SRC, 'AndroidManifest.xml').replace(/\\/g, '/'),
  '-R', resZip.replace(/\\/g, '/'),
  '--auto-add-overlay',
  '--java', genDir.replace(/\\/g, '/'),
  '-A', path.join(WORK, 'assets').replace(/\\/g, '/'),
  '--min-sdk-version', '21',
  '--target-sdk-version', '34',
  '--version-code', '1',
  '--version-name', '1.0',
]));
step('base.apk ' + (fs.statSync(baseApk).size / 1024).toFixed(0) + ' KB');

/* ---------------- ④ javac → class ---------------- */
step('javac（壳代码 + 生成的 R.java）');
const javaSrcRoot = path.join(SRC, 'java');
const sources = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.java')) sources.push(p);
  }
})(javaSrcRoot);
(function walk(d) {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.java')) sources.push(p);
  }
})(genDir);
if (!sources.length) die('没找到任何 .java 源文件');

const classesDir = path.join(WORK, 'classes');
fs.mkdirSync(classesDir, { recursive: true });
const jr = sh(JAVAC, [
  '-encoding', 'UTF-8',
  '-source', '8', '-target', '8',
  '-bootclasspath', ANDROID_JAR,
  '-classpath', ANDROID_JAR,
  '-nowarn',
  '-d', classesDir.replace(/\\/g, '/'),
].concat(sources.map(s => s.replace(/\\/g, '/'))));
/* javac 在 JDK21 上会为 -source 8 打废纸警告，filter 掉 */
if (jr.code !== 0 || jr.err) {
  const onlyWarn = !/error/i.test(jr.out);
  if (!onlyWarn) die('javac 失败：\n' + jr.out + '\n' + jr.err);
}
step('编译出 ' + sources.length + ' 个源文件');

/* ---------------- ⑤ d8 → classes.dex ---------------- */
step('d8（class → classes.dex）');
const dexDir = path.join(WORK, 'dex');
fs.mkdirSync(dexDir, { recursive: true });
const classes = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.class')) classes.push(p);
  }
})(classesDir);
if (!classes.length) die('javac 没产出任何 .class');
const r8 = sh(D8, [
  '--lib', ANDROID_JAR,
  '--min-api', '21',
  '--output', dexDir.replace(/\\/g, '/'),
].concat(classes.map(c => c.replace(/\\/g, '/'))), { shell: process.platform === 'win32' });
must('d8', r8);
const dexPath = path.join(dexDir, 'classes.dex');
if (!fs.existsSync(dexPath)) die('d8 没产出 classes.dex');
step('classes.dex ' + (fs.statSync(dexPath).size / 1024).toFixed(0) + ' KB');

/* ---------------- ⑥ 塞进 APK ---------------- */
step('把 classes.dex 合进 APK');
const unsignedApk = path.join(WORK, 'unsigned.apk');
const injectPy = path.join(BUILD, 'inject-dex.py');

/* ⚠ 别写死 `python`。这台机器上 PATH 里没有 python（跑起来就是 exit 9009
   「找不到命令」），但环境里装了托管版 Python。所以按顺序探一遍，
   谁能真跑起来用谁 —— 拿 `-c print(1)` 实测，不看文件存不存在。 */
function findPython() {
  const cands = [
    process.env.RR_PYTHON,
    'C:/Users/13154/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'C:/Users/13154/AppData/Local/Programs/Python/Python312/python.exe',
    'python',
    'python3',
    'py',
  ].filter(Boolean);
  for (const c of cands) {
    const probe = spawnSync(c, ['-c', 'print(1)'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0 && /1/.test(String(probe.stdout || ''))) return c;
  }
  return null;
}
const py = findPython();
if (!py) {
  die('找不到可用的 Python —— 需要它把 classes.dex 塞进 APK。\n' +
      '  → 装一个 Python，或用 RR_PYTHON 环境变量指定解释器路径。');
}
step('用 ' + py + ' 注入');
const ri = sh(py, [injectPy, baseApk, dexPath, unsignedApk]);
must('注入 classes.dex', ri);

/* ---------------- ⑦ zipalign ---------------- */
step('zipalign -p 4');
const alignedApk = path.join(WORK, 'aligned.apk');
must('zipalign', sh(ZIPALIGN, ['-f', '-p', '4', unsignedApk, alignedApk]));

/* ---------------- ⑧ 签名 ---------------- */
/* ⚠ 密钥必须放在 WORK **外面**：WORK 每轮构建都被 rmrf 清空，
   密钥要是跟着没了，每打一次包就换一次签名 ——
   安卓会拒绝用新签名覆盖安装旧 App（只能先卸载，存档全丢）。
   放在 build/ 下，签名从此固定，覆盖升级即可。 */
const ks = process.env.RR_KEYSTORE || path.join(BUILD, 'debug.keystore');
if (!fs.existsSync(ks)) {
  step('生成 debug keystore（自签，仅供侧载安装）');
  must('keytool', sh(KEYTOOL, [
    '-genkeypair',
    '-keystore', ks,
    '-storepass', KS_PASS,
    '-keypass', KS_PASS,
    '-alias', KS_ALIAS,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10000',
    '-dname', 'CN=Android Debug,O=Android,C=US',
  ]));
}
step('apksigner（v1+v2 签名）');
const signedApk = path.join(WORK, 'signed.apk');
try { fs.unlinkSync(signedApk); } catch (e) {}
must('apksigner', sh(APKSIGNER, [
  'sign',
  '--ks', ks,
  '--ks-pass', 'pass:' + KS_PASS,
  '--key-pass', 'pass:' + KS_PASS,
  '--ks-key-alias', KS_ALIAS,
  '--v1-signing-enabled', 'true',
  '--v2-signing-enabled', 'true',
  '--out', signedApk,
  alignedApk,
], { shell: process.platform === 'win32' }));

/* 验收走 ASCII 临时路径，过了再拷到中文目标目录（Node 读写不受编码影响） */
const outApk = path.join(OUT_DIR, APK_NAME);

/* ---------------- ⑨ 验收 ---------------- */
step('验收：签名 / 清单 / 内置页面');
const v = sh(APKSIGNER, ['verify', '--verbose', '--print-certs', signedApk], { shell: process.platform === 'win32' });
const signedOK = /Verified using v2 scheme \(APK Signature Scheme v2\): true/.test(v.out) || /Verified/.test(v.out);

const badging = sh(AAPT, ['dump', 'badging', signedApk]);
const pkgOK = new RegExp('package: name=\'' + PKG.replace(/\./g, '\\.') + '\'').test(badging.out);
const launchOK = /launchable-activity: name='com\.shengsizhuanpan\.app\.MainActivity'/.test(badging.out);
const sdkOK = /sdkVersion:'21'/.test(badging.out);
const listing = sh(AAPT, ['list', signedApk]).out;
const assetsOK = /assets\/www\/client\.html/.test(listing)
              && /assets\/www\/engine\.js/.test(listing)
              && /assets\/www\/roulette-wheel\.html/.test(listing)
              && /assets\/www\/start\.html/.test(listing);   /* V16 启动页：App 的首页 */

/* 把 APK 里内置的那份页面抽出来，再跑一遍真机验收 ——
   证明的是「打进 APK 的这一份是活的」，而不只是源文件是活的。
   假 DOM 测试挡不住 appendChild 传错变量这类错误（2026-09-24 的事故），
   但那类错误会让 App 一装上就是白屏 + 关不掉的遮罩。 */
const pyVerify = py;      // 用 ⑥ 里探测出来的解释器，别写死 `python`
const vdir = path.join(WORK, 'verify');
fs.mkdirSync(vdir, { recursive: true });
const extractPy = path.join(BUILD, 'extract-asset.py');
const exPage = path.join(vdir, 'client.html');
const exEng = path.join(vdir, 'engine.js');
const exStart = path.join(vdir, 'start.html');
must('抽出内置页面', sh(pyVerify, [extractPy, signedApk, 'assets/www/client.html', exPage]));
must('抽出内置引擎', sh(pyVerify, [extractPy, signedApk, 'assets/www/engine.js', exEng]));
must('抽出内置启动页', sh(pyVerify, [extractPy, signedApk, 'assets/www/start.html', exStart]));
const rv = spawnSync(process.execPath, [path.join(BUILD, 'verify-page.js'), exPage],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/* V16：启动页是 App 的第一屏，正是"抽出来再验"最有价值的那一份 ——
   它是纯静态的，抽出来单独一个文件照样验得动（不依赖同目录的 engine.js）。 */
const rs = spawnSync(process.execPath, [path.join(BUILD, 'verify-start.js'), exStart],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const aliveOK = rv.status === 0 || rv.status === 2;   // 2 = 这台机器没浏览器，跳过
const startAliveOK = rs.status === 0 || rs.status === 2;
if (!aliveOK) console.log((rv.stdout || '') + (rv.stderr || ''));
if (!startAliveOK) console.log((rs.stdout || '') + (rs.stderr || ''));

console.log('    ' + (signedOK ? '\u2713' : '\u2717') + ' APK 已签名');
console.log('    ' + (pkgOK ? '\u2713' : '\u2717') + ' 包名 ' + PKG);
console.log('    ' + (launchOK ? '\u2713' : '\u2717') + ' 启动入口 MainActivity');
console.log('    ' + (sdkOK ? '\u2713' : '\u2717') + ' minSdk 21（安卓 5.0 起都能装）');
console.log('    ' + (assetsOK ? '\u2713' : '\u2717') + ' 内置页面齐了（启动页/client/engine/单机页）');
console.log('    ' + (aliveOK ? '\u2713' : '\u2717') + ' APK 里那份联机页过了真机验收'
  + (rv.status === 2 ? '（跳过：没浏览器）' : ''));
console.log('    ' + (startAliveOK ? '\u2713' : '\u2717') + ' APK 里那份启动页（首页）过了真机验收'
  + (rs.status === 2 ? '（跳过：没浏览器）' : ''));

if (!(signedOK && pkgOK && launchOK && assetsOK && aliveOK && startAliveOK)) {
  console.log('\nAPK 出来了，但验收没过 —— 别拿去装。\n');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
try { fs.unlinkSync(outApk); } catch (e) {}
fs.copyFileSync(signedApk, outApk);
console.log('    ' + '\u2713' + ' 已拷到 ' + outApk + '（' + (fs.statSync(outApk).size / 1024 / 1024).toFixed(1) + ' MB）');
console.log('\n打包完成：' + outApk + '\n');
