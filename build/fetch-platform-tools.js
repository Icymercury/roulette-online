/* ============================================================
 * 生死转盘 · 构建工具：装 Android platform-tools（含 adb）—— 一次性
 * ------------------------------------------------------------
 *   node build/fetch-platform-tools.js
 *
 * 为什么需要它：
 *   真机验收要用 adb（装 APK / 抓 logcat / 模拟点击 / 看网络），
 *   而本机只装过 build-tools 与 platforms，**没有 platform-tools**。
 *
 * 装到：D:\Android\android-sdk\platform-tools\
 * 来源：dl.google.com（本机可达，之前装 build-tools 走的就是它）约 12 MB
 *
 * 解压用 Windows 自带的 tar.exe（bsdtar，认 zip）。
 * 环境变量 ANDROID_SDK 可改目标 SDK 根目录。
 * ============================================================ */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const SDK = process.env.ANDROID_SDK || 'D:/Android/android-sdk';
const URL = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
const ZIP_INNER = 'platform-tools';        // 这个 zip 里就这一层目录

const DEST = path.join(SDK, 'platform-tools');
const TMP = path.join(__dirname, 'android', '_download');
const ZIP = path.join(TMP, 'platform-tools.zip');

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

console.log('\n生死转盘 · 安装 Android platform-tools（adb）\n');

if (fs.existsSync(path.join(DEST, 'adb.exe'))) {
  const v = spawnSync(path.join(DEST, 'adb.exe'), ['version'], { encoding: 'utf8' });
  console.log('  已经装过了：' + DEST);
  console.log('  ' + (v.stdout || '').split('\n')[0].trim() + '\n');
  process.exit(0);
}

fs.mkdirSync(TMP, { recursive: true });

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
        if (pct >= last + 25) { last = pct; step('下载中 ' + pct + '%'); }
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

  /* 自检 */
  const adb = path.join(DEST, 'adb.exe');
  const v = spawnSync(adb, ['version'], { encoding: 'utf8' });
  step('adb 自检：' + (v.stdout || '').split('\n')[0].trim());
  if (v.status !== 0) throw new Error('adb 跑不起来：' + (v.stderr || ''));

  fs.rmSync(TMP, { recursive: true, force: true });

  /* 顺手看一眼有没有插着设备 */
  const dev = spawnSync(adb, ['devices'], { encoding: 'utf8' });
  console.log('\n当前连接的安卓设备：');
  console.log('  ' + (dev.stdout || '').trim().split('\n').join('\n  '));
  console.log('\nADB 就绪 → ' + adb + '\n');
})().catch(e => {
  console.error('\n安装失败：' + (e && e.message ? e.message : e) + '\n');
  process.exit(1);
});
