/* ============================================================
 * 生死转盘 · 一次跑完全部测试
 * ------------------------------------------------------------
 *   node build/run-all.js            → 六套 Node 测试 + 四个真机验收
 *   node build/run-all.js --node     → 只跑六套 Node 测试（快，不用浏览器）
 *   node build/run-all.js --live     → 只跑真机验收
 *
 * 为什么要这个脚本：每轮改完都要回归，一个个敲容易漏（漏过 engine-modes
 * 那一套 125 条），所以把清单钉死在这里。
 *   · Node 那六套必须走 run-test.js 跑壳：它会把 process.argv 重写成
 *     [node, 目标脚本]，否则被测脚本把输出文件当成自己的参数。
 *   · 真机四个是直接 node 跑；exit 2 = 这台机器没浏览器，算跳过不算失败。
 * ============================================================ */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const onlyNode = process.argv.includes('--node');
const onlyLive = process.argv.includes('--live');

/* 假 DOM / 假 socket 的纯 Node 测试 */
const NODE_SUITES = [
  'engine-test.js',
  'engine-modes-test.js',
  'client-solo-test.js',
  'test-online.js',
  'client-mp-test.js',
  'discovery-test.js',
];
/* 真浏览器 / 真服务端 / 真 WebSocket 的验收 */
const LIVE_SUITES = [
  ['build/verify-page.js', '联机页真渲染'],
  ['build/verify-start.js', '启动页真渲染'],
  ['build/verify-live.js', '真·端到端（真服务端 + 真 WebSocket）'],
  ['build/verify-admin.js', '管理台真机验收'],
];

let totalPass = 0, totalFail = 0;
const bad = [];

function line(txt) {
  const m = txt.match(/结果：通过 (\d+) 项，失败 (\d+) 项/);        // 真机验收
  if (m) return { pass: +m[1], fail: +m[2] };
  const m2 = txt.match(/结果：(\d+) 通过 \/ (\d+) 失败/);           // Node 测试
  if (m2) return { pass: +m2[1], fail: +m2[2] };
  const m3 = txt.match(/通过 (\d+) 项，失败 (\d+) 项/);
  if (m3) return { pass: +m3[1], fail: +m3[2] };
  return null;
}

console.log('\n生死转盘 · 全量回归\n');

if (!onlyLive) {
  console.log('── Node 测试');
  for (const s of NODE_SUITES) {
    const out = path.join(os.tmpdir(), 'rr-out-' + s + '.txt');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'run-test.js'), out, s],
      { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
    let txt = '';
    try { txt = fs.readFileSync(out, 'utf8'); } catch (e) { txt = ''; }
    const res = line(txt);
    if (res) {
      console.log('   ' + (res.fail ? '✗' : '✓') + ' ' + s.padEnd(24) + res.pass + ' 通过 / ' + res.fail + ' 失败');
      totalPass += res.pass; totalFail += res.fail;
    } else {
      console.log('   ⚠ ' + s.padEnd(24) + '没解析到结果行（exit ' + r.status + '）');
      console.log('     ' + String(r.stdout || '').slice(0, 200).replace(/\n/g, ' '));
      bad.push(s);
    }
    txt.split('\n').filter(l => /^\s*✗/.test(l)).slice(0, 10)
      .forEach(l => console.log('       ' + l.trim()));
  }
}

if (!onlyNode) {
  console.log('\n── 真机验收');
  for (const [s, label] of LIVE_SUITES) {
    const r = spawnSync(process.execPath, [path.join(ROOT, s)],
      { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
    const txt = (r.stdout || '') + (r.stderr || '');
    const res = line(txt);
    if (r.status === 2) {
      console.log('   · ' + s.padEnd(24) + '跳过（这台机器没浏览器）');
      continue;
    }
    if (res) {
      console.log('   ' + (res.fail ? '✗' : '✓') + ' ' + label.padEnd(24) + res.pass + ' 通过 / ' + res.fail + ' 失败');
      totalPass += res.pass; totalFail += res.fail;
    } else {
      console.log('   ⚠ ' + label.padEnd(24) + '没解析到结果行（exit ' + r.status + '）');
      console.log('     ' + txt.slice(0, 300).replace(/\n/g, ' '));
      bad.push(s);
    }
    txt.split('\n').filter(l => /^\s*✗/.test(l)).slice(0, 10)
      .forEach(l => console.log('       ' + l.trim()));
  }
}

console.log('\n合计：通过 ' + totalPass + ' / 失败 ' + totalFail
  + (bad.length ? '   ⚠ 有套没能判分：' + bad.join(', ') : ''));
console.log(totalFail === 0 && !bad.length ? '全绿。\n' : '有红的 —— 先修再打包。\n');
process.exit(totalFail === 0 && !bad.length ? 0 : 1);
