/* ============================================================
 * 生死转盘 · 构建工具：装 Android build-tools（一次性）
 * ------------------------------------------------------------
 *   node build/fetch-android-tools.js
 *
 * 为什么需要它：
 *   本机只装了 Android SDK 的 platforms，没有 build-tools；
 *   而 gradle 官方源（services.gradle.org）在本机连不上，
 *   所以打 APK 走「裸工具链」路线，build-tools 必须自己装。
 *
 * 装到：D:\Android\android-sdk\build-tools\<版本>\
 * 来源：dl.google.com（可达）约 56 MB
 *
 * 解压用 Windows 自带的 tar.exe（bsdtar，认 zip）。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const SDK = process.env.ANDROID_SDK || 'D:/Android/android-sdk';
const BT_VER = '34.0.0';
const URL = 'https://dl.google.com/android/repository/build-tools_r34-windows.zip';
const ZIP_INNER = 'android-14';           // 这个 zip 里就这一层目录

const DEST = path.join(SDK, 'build-tools', BT_VER);
const TMP = path.join(__dirname, 'android', '_download');
const ZIP = path.join(TMP, 'build-tools.zip');

function step(m) { console.log('  · ' + m); }
/* 不用 fs.cpSync —— 本机 Node 22 跑 cpSync 会硬崩，手写递归拷贝 */
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

console.log('\n生死转盘 · 安装 Android build-tools ' + BT_VER + '\n');

if (fs.existsSync(path.join(DEST, 'aapt2.exe'))) {
  console.log('  已经装过了：' + DEST + '\n');
  process.exit(0);
}

fs.mkdirSync(TMP, { recursive: true });

/* ---------- 下载 ---------- */
function download(url, dest, redirects) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向太多'));
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0, last = 0;
      const f = fs.createWriteStream(dest);
      res.on('data', d => {
        got += d.length;
        const pct = total ? Math.floor(got / total * 100) : 0;
        if (pct >= last + 20) { last = pct; step('下载中 ' + pct + '%'); }
      });
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve(got)));
      f.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  step('下载 ' + URL);
  const bytes = await download(URL, ZIP, 0);
  step('拿到 ' + (bytes / 1024 / 1024).toFixed(1) + ' MB');

  /* ---------- 解压 ---------- */
  const tar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
  if (!fs.existsSync(tar)) {
    throw new Error('找不到 Windows 自带的 tar.exe，请手动把 ' + ZIP + ' 解压到 ' + DEST);
  }
  step('解压（tar.exe）');
  const ex = spawnSync(tar, ['-xf', ZIP, '-C', TMP], { encoding: 'utf8' });
  if (ex.status !== 0) throw new Error('解压失败：' + (ex.stderr || ex.stdout));

  const inner = path.join(TMP, ZIP_INNER);
  if (!fs.existsSync(inner)) throw new Error('压缩包里没找到 ' + ZIP_INNER);

  fs.mkdirSync(DEST, { recursive: true });
  copyTree(inner, DEST);
  step('装好 → ' + DEST);

  /* ---------- 验证 ---------- */
  const chk = spawnSync(path.join(DEST, 'aapt2.exe'), ['version'], { encoding: 'utf8' });
  step('aapt2 自检：' + (chk.stdout || '').trim());

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\nbuild-tools 就绪，可以跑 node build/build-android.js 了。\n');
})().catch(e => {
  console.error('\n安装失败：' + e.message + '\n');
  process.exit(1);
});
