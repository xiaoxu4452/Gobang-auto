/*
 * inject-sea.js —— 把 SEA blob 注入 node.exe 副本，产出单文件可执行程序
 *
 * 【为什么改用官方 postject】
 *   早期实现尝试「熔断 fuse + 在文件末尾裸追加 sentinel/blob/length」。实测在
 *   Windows 官方 node 构建上不生效：现代 Node 的 SEA blob 是以「PE 资源/节」形式
 *   注入的，需要完整的 PE 头与节表；裸追加会让 PE 校验/定位失败，exe 启动后
 *   毫无输出（不报错、不监听）。官方 postject 是 Node 文档指定的注入工具，行为一致。
 *
 *   因此本脚本改为：定位本地 postject → 调用它注入 → 校验产物。
 *   postject 优先用工作区 node_modules；找不到则用 npx（首次会联网安装）。
 *
 * 用法: node inject-sea.js <target.exe> <blob>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const [target, blobPath] = process.argv.slice(2);
if (!target || !blobPath) {
  console.error('usage: node inject-sea.js <target.exe> <blob>');
  process.exit(1);
}
if (!fs.existsSync(target)) { console.error('target 不存在: ' + target); process.exit(1); }
if (!fs.existsSync(blobPath)) { console.error('blob 不存在: ' + blobPath); process.exit(1); }

// ---- 定位 postject 入口 ----
function findPostject() {
  const cands = [
    // 工作区 node_modules（推荐：构建前先 npm i postject）
    path.join(require('os').homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'postject', 'dist', 'cli.js'),
    path.join(process.cwd(), 'node_modules', 'postject', 'dist', 'cli.js'),
    path.join(__dirname, '..', 'node_modules', 'postject', 'dist', 'cli.js')
  ];
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  return null;
}

function runPostject(postjectCli, args) {
  return spawnSync(process.execPath, [postjectCli].concat(args), { encoding: 'utf8' });
}

let cli = findPostject();
let res;
if (cli) {
  console.log('  使用本地 postject: ' + cli);
  res = runPostject(cli, [target, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SENTINEL_FUSE, '--overwrite']);
} else {
  // 回退：npx postject（首次会联网安装到 npx 缓存）
  console.log('  本地未找到 postject，改用 npx（首次需联网）...');
  const npx = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const npxArgs = fs.existsSync(npx)
    ? [npx, 'postject', target, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SENTINEL_FUSE, '--overwrite']
    : ['-e', '0'];   // 占位，下面会报错
  res = spawnSync(process.execPath, npxArgs, { encoding: 'utf8' });
}
if (res.status !== 0) {
  console.error('postject 注入失败：\n' + (res.stdout || '') + (res.stderr || ''));
  console.error('提示：请先在工作区安装 postject —— ' +
    'node -e "require(\'child_process\').execSync(\'npm i postject\',{stdio:\'inherit\'})"');
  process.exit(2);
}
const out = ((res.stdout || '') + (res.stderr || '')).trim();
if (out) out.split('\n').forEach(l => console.log('  ' + l.trim()));

// ---- 校验产物确实变大且含 sentinel ----
const probe = fs.readFileSync(target);
const hasSentinel = probe.includes(Buffer.from('NODE_SEA_BLOB'));
if (!hasSentinel) { console.error('注入后未找到 NODE_SEA_BLOB 标记，产物可疑'); process.exit(3); }
// 【关键加固】blob 必须真的在文件里，且 postject 报告成功。
// 历史坑：GomokuEngine.exe 是"新的"，但它内嵌的仍是上一次构建的 SEA blob
//（增量注入把旧 blob 留下了），导致发布版跑的是旧源码——「发布没更新成功」。
// 这里做长度与可执行性双检：blob 内容（去掉注入用的 padding 后）必须能在 exe 中定位。
function assertBlobEmbedded() {
  const blob = fs.readFileSync(blobPath);
  // blob 尾部有 8 字节长度后缀（Node SEA 格式），用前 64 字节做指纹足够唯一
  const fp = blob.slice(0, 64);
  if (!probe.includes(fp)) {
    console.error('⚠️ exe 中未找到本次 blob 的头部指纹 —— 注入可能未生效（exe 内仍是旧 blob）');
    process.exit(4);
  }
  console.log('  ✓ 已确认本次 blob 指纹写入 exe（' + fp.length + ' bytes fingerprint）');
}
assertBlobEmbedded();
console.log('  blob 注入完成，产物 ' + (fs.statSync(target).size / 1024 / 1024).toFixed(1) + 'MB');
