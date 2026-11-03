/* ============================================================
 * 生死转盘 · 测试跑壳（辅助工具，不参与游戏）
 * ------------------------------------------------------------
 *   node run-test.js <输出文件> <测试脚本> [脚本自己的参数…]
 *
 * 为什么需要它：
 *   本机的 Bash shim 坏了（ls / grep / dirname 全 exit 127），PowerShell 又
 *   用 OEM 代码页解码子进程 stdout —— 直接跑测试，中文输出会变成乱码，
 *   或者干脆什么都抓不到。这个壳子把测试的 console.log / stdout 全部
 *   以 UTF-8 直接写进文件，编码不经过任何中间层。
 *
 *   例：
 *     node run-test.js out.txt engine-modes-test.js
 *     node run-test.js out.txt client-mp-test.js
 *     node run-test.js out.txt ./build/verify-page.js
 *     node run-test.js out.txt ./build/verify-live.js 8130
 *
 * ⚠ 脚本自己的参数必须**写在本壳子后面**。直接 `node run-test.js out ./a.js`
 *   时，脚本看到的 process.argv[1] 是本文件、process.argv[2] 是输出路径 ——
 *   verify-page.js 会把输出路径当成「要验的页面」，verify-live.js 会把
 *   端口算成 NaN，然后两边都莫名失败。所以下面把 argv 重写成
 *   「[node, 目标脚本, ...附加参数]」再 require，让脚本看到正常的命令行。
 *
 * 注：在正常终端里跑测试不需要这个壳子，直接 node xxx-test.js 即可。
 * ============================================================ */

const fs = require('fs');
const util = require('util');
const path = require('path');
const outFile = process.argv[2];
const target = process.argv[3];
const extraArgs = process.argv.slice(4);

if (!outFile || !target) {
  console.log('用法：node run-test.js <输出文件> <测试脚本> [脚本自己的参数…]');
  process.exit(1);
}

/* 把命令行还原成脚本期待的样子 —— 见文件头 ⚠ */
process.argv = [process.execPath, path.resolve(target)].concat(extraArgs);


fs.writeFileSync(outFile, '', 'utf8');

/* ⚠ Windows 上 appendFileSync 偶尔会 EPERM（杀软 / 索引器正巧按住文件）。
   真发生过的后果很坑：异常从 console.log 里抛出去 ⇒ 测试**中途夭折**，
   日志上看只剩前几行 —— 很像「测试挂了」。所以这里同步重试几次。 */
function syncSleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { /* 退化成不睡 */ }
}
function w(s) {
  for (let i = 0; ; i++) {
    try { fs.appendFileSync(outFile, s, 'utf8'); return; }
    catch (e) {
      if (i >= 6) throw e;
      syncSleep(20);
    }
  }
}
function fmt(a) {
  return a.map(function (x) {
    return typeof x === 'string' ? x : util.inspect(x, { depth: 4 });
  }).join(' ');
}

console.log = function () { w(fmt(Array.prototype.slice.call(arguments)) + '\n'); };
console.error = console.log;
console.warn = console.log;
process.stdout.write = function (s) { w(typeof s === 'string' ? s : String(s)); return true; };
process.stderr.write = process.stdout.write;

try {
  require(path.resolve(target));
} catch (e) {
  w('\n[THROWN] ' + (e && e.stack ? e.stack : String(e)) + '\n');
}
