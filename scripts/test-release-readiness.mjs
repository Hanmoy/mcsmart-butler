// 发布回归：验证时间须属于当前凭据；安装包必须携带完整原创代码许可。
// 全部使用隔离目录与合成凭据，不读取个人账户、不调用业务接口。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'mcsmart-release-'));
process.env.MCSMART_HOME = home;
process.env.MCSMART_DISABLE_BUNDLED_UNION = '1';
for (const key of ['MCD_MCP_TOKEN', 'MEITUAN_UNION_APPKEY', 'MEITUAN_UNION_APPSECRET', 'MEITUAN_UNION_SID']) delete process.env[key];
globalThis.fetch = () => { throw new Error('release fixture must stay offline'); };
try {
  const { readCredentials } = await import('../dist/config.js');
  const save = (credentials) => writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 1, tuning: {}, credentials }));
  const verifiedAt = '2026-10-20T00:00:00.000Z';
  save({ mcdMcpToken: 'fixture-token', verifiedAt });
  assert.equal(readCredentials().verifiedAt, verifiedAt, '保存过的验证时间必须可读');
  process.env.MCD_MCP_TOKEN = 'another-fixture-token';
  assert.equal(readCredentials().verifiedAt, undefined, '环境变量凭据不能继承文件中另一凭据的验证记录');
  process.env.MCD_MCP_TOKEN = '   ';
  assert.equal(readCredentials().verifiedAt, verifiedAt, '空环境变量回退文件时保留验证记录');
  save({ mcdMcpToken: 'fixture-token', verifiedAt: 'invalid-date' });
  assert.equal(readCredentials().verifiedAt, undefined, '非法时间不能作为验证证据');
  save({ verifiedAt });
  assert.equal(readCredentials().verifiedAt, undefined, '无凭据时不保留验证证据');
  save({ mcdMcpToken: 'fixture-token', verifiedAt });
  const { doctorReport } = await import('../dist/service.js');
  const doctor = await doctorReport(null, { live: false });
  assert.equal(doctor.credentials.verifiedAt, verifiedAt);
  assert.equal(doctor.capabilities.realtimeOrdering, 'unverified', '历史验证记录不能冒充本次联网');
  console.log('✓ 发布凭据元数据：6 个场景通过（离线合成配置）');
  if (process.env.MCSMART_PACKAGE_DIR) {
    const pkg = resolve(process.env.MCSMART_PACKAGE_DIR);
    assert.ok(existsSync(join(pkg, 'LICENSE')), '安装包缺少原创代码 LICENSE');
    assert.equal(readFileSync(join(pkg, 'LICENSE'), 'utf8'), readFileSync(join(root, 'LICENSE'), 'utf8'), '安装包许可必须与源码一致');
    console.log('✓ 安装包完整携带原创代码 LICENSE');
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
