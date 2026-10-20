// 评审四轮：内置 CPS 客户端（unionClient.ts）验收——签名跨语言一致性、响应解析、凭据分层
// 运行：npm test 或 npm run build && node scripts/test-union-client.mjs
import { signSca, buildHeaders, parseCouponItems, resolveUnionCredentials } from '../dist/unionClient.js';
import { createHash } from 'node:crypto';

let failures = 0;
const check = (cond, label) => {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures++; }
};

// 跨语言测试向量（由 python 版 union_api.py 同一算法对固定输入计算，保证 TS 移植逐字节一致）
const SECRET = 'test-secret';
const APPKEY = 'test-appkey';
const TS = '1710000000000';
const PATH = '/cps_open/common/api/v1/query_coupon';
// 与 python 相同的紧凑序列化（键序固定、无空格、中文原样 UTF-8）
const BODY = JSON.stringify({ pageNo: 1, pageSize: 20, sortField: 1, ascDescOrder: 1, searchText: '麦当劳' });
// python 向量：bodyLen=76, md5=LCscg8CjCoK1N8TcMP4aZQ==, sig=5UmOsu9U9G/UzSaYRdX7LieTW7ruqII/rl7Uqt3kfgk=
const VEC_MD5 = 'LCscg8CjCoK1N8TcMP4aZQ==';
const VEC_SIG = '5UmOsu9U9G/UzSaYRdX7LieTW7ruqII/rl7Uqt3kfgk=';

console.log('【U1】S-Ca 签名与 python 版逐字节一致');
{
  const md5 = createHash('md5').update(BODY, 'utf-8').digest('base64');
  check(BODY.length === 76, `紧凑序列化一致（长度 ${BODY.length}=76）`);
  check(md5 === VEC_MD5, `Content-MD5 一致（${md5}）`);
  const sig = signSca(SECRET, APPKEY, TS, md5, PATH);
  check(sig === VEC_SIG, `HMAC-SHA256 签名一致（${sig.slice(0, 20)}…）`);
  const h = buildHeaders({ appkey: APPKEY, appsecret: SECRET }, BODY, PATH, TS);
  check(h['S-Ca-Signature'] === VEC_SIG && h['S-Ca-Timestamp'] === TS && h['S-Ca-App'] === APPKEY, '请求头组装完整');
}

console.log('【U2】query_coupon 多形态响应解析（无 productViewSign 丢弃）');
{
  const resp = { data: [
    { couponPackDetail: { name: '团单A', skuViewId: 'S1', productViewSign: 'S1_A-B', sellPrice: '39.9', poiName: '店1', headUrl: 'https://img.meituan.net/a.jpg@350_0_900_900a|267h' }, brandInfo: { brandName: '麦当劳' } },
    { name: '无ID坏数据' },
    { sellPrice: '9.9' },
    // v1.4.7 R07：只有 skuViewId、没有 productViewSign 的条目必须丢弃。
    //   旧实现把 skuViewId 回填到 productViewSign，再省略 sku 字段 → 伪造的完整身份（同一串 ID 冒充两种标识）。
    { couponPackDetail: { name: '团单B', skuViewId: ['S2'], sellPrice: 25.5 }, brandInfo: {} },
  ] };
  const items = parseCouponItems(resp, 10);
  check(items.length === 1, `只有带 productViewSign 的团单可用（实际 ${items.length}）`);
  check(!items.some((it) => it.skuViewId === undefined && it.productViewSign === 'S2'), 'skuViewId 不回填 productViewSign');
  // v1.3：productViewSign（A_B 段）与 skuViewId（A 段）分开保留，绝不互相填充
  check(items[0].productViewSign === 'S1_A-B', `productViewSign 取 A_B 段（实际 ${items[0].productViewSign}）`);
  check(items[0].skuViewId === 'S1', `skuViewId 独立保留（实际 ${items[0].skuViewId}）——旧实现把 skuViewId 填进 productViewSign 字段`);
  check(items[0].headUrl === 'https://img.meituan.net/a.jpg', `headUrl 提取并去尺寸后缀（实际 ${items[0].headUrl}）`);
  check(items[0].name === '团单A' && items[0].sellPrice === '39.9', '字段提取正确');
  const onlySku = parseCouponItems({ data: [{ couponPackDetail: { name: '仅SKU', skuViewId: 'S9', sellPrice: '1.0' }, brandInfo: {} }] }, 10);
  check(onlySku.length === 0, '仅 skuViewId 的条目整体丢弃（不得伪造 productViewSign）');
  const empty = parseCouponItems({ data: 'bad' }, 10);
  check(empty.length === 0, '非数组 data 安全返回空');
}

console.log('【U3】凭据分层：env 缺失 → null（走 skill/团单库兜底）');
{
  const saved = [process.env.MEITUAN_UNION_APPKEY, process.env.MEITUAN_UNION_APPSECRET];
  delete process.env.MEITUAN_UNION_APPKEY; delete process.env.MEITUAN_UNION_APPSECRET;
  check(resolveUnionCredentials() === null, '无 env 凭据 → null');
  process.env.MEITUAN_UNION_APPKEY = 'k';
  process.env.MEITUAN_UNION_APPSECRET = 's';
  const c = resolveUnionCredentials();
  check(!!c && c.appkey === 'k' && c.appsecret === 's', 'env 凭据 → 解析生效');
  if (saved[0] != null) process.env.MEITUAN_UNION_APPKEY = saved[0];
  if (saved[1] != null) process.env.MEITUAN_UNION_APPSECRET = saved[1];
  else { delete process.env.MEITUAN_UNION_APPKEY; delete process.env.MEITUAN_UNION_APPSECRET; }
}

console.log(failures === 0 ? '\n内置 CPS 客户端验收全部通过 ✓' : `\n${failures} 项未通过 ✗`);
process.exit(failures === 0 ? 0 : 1);
