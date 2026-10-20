# data/ 数据资产说明

## nutrition-official-web.json

- **来源**：https://www.mcdonalds.com.cn/nutrition_calculator 页面内嵌数据（`var raw_data`）
- **抓取日期**：2026-10-11（页面标注数据更新时间：2025 年 4 月）
- **结构**：`category_list`（8 分类）/ `Product`（93 产品）/ `ProductType`（137 规格）
  - 产品 → 规格（小/中/大/1个/1份/2块/4块/5块/默认）两级结构
  - `nutrition` 数组 14 列：`[0]参考重量g [1]能量kJ [2]蛋白质g [3]脂肪g [4]碳水g [5]钠mg … [13]钙mg`
- **kcal 换算**：`Math.round(kJ / 4.184)`（与官网 JS `formatKcal` 口径一致）
- **与 MCP 的关系**：与 `list-nutrition-foods`（160 行）同源同数据期（均为 2025-04），逐条吻合（可乐中杯 616kJ=147kcal、巨无霸 2146kJ=513kcal）；官网版额外覆盖 MCP 表缺失的品项（奥利奥麦旋风 266kcal、香芋派 232kcal、草莓新地 245kcal、纯悦 0kcal 等）并提供权威的产品-规格关系。
- **使用位置**：`src/officialNutrition.ts`（规格感知营养首选源，失败时回退 MCP 营养表）
- **刷新方法**：重新抓取该页面并重新提取 `raw_data` 覆盖本文件（结构不变，代码无需修改）

## 合规说明

数据来自麦当劳官网公开页面（无需鉴权），仅作产品营养计算的数据源；页面数据版权归麦当劳所有。本项目不代理、不修改该数据，仅在计算时引用并标注来源。
## catalog.json（v1.2 起作为发布种子）

- **性质**：本地产品目录快照（菜单 + 美团团单 + MCP 营养表观测），**历史观测数据，不是实时菜单**
- **覆盖范围（如实声明）**：
  - 门店菜单：仅 1450684（上海，2026-10-13 观测，119 项，每项含 firstSeen/lastSeen）；**其他门店无快照**，打烊/接口失败时无兜底属预期行为
  - 美团团单：38 条（2026-10-13 联盟实时查询观测，历史参考价口径，超 14 天观测窗口后自动失效）
  - MCP 营养表：7 行（部分观测；完整营养覆盖来自 nutrition-official-web.json）
- **隔离纪律**：测试样本（CAT-STORE/S1/SIGN-* 等）只允许出现在隔离的 MCSMART_HOME 测试目录，严禁写入本种子；`scripts/package-skill.mjs` 打包时会断言种子无测试标记
- **运行期写入**：一律写用户数据目录（MCSMART_HOME/catalog.json），种子永不回写

## meituan-city-dict.json（v1.3 起随包分发）

- **来源**：美团联盟官方城市字典 2025（https://s3plus.meituan.net/media-public/城市字典2025.xlsx）
- **抓取日期**：2026-10-14（359 城，城市 ID 为字母数字混合串）
- **用途**：`query_coupon` 搜索场景 `cityId` 参数（到店商品不传城市/经纬度时接口默认北京——必须显式传城市）
- **使用位置**：`src/dealDetail.ts` `meituanCityId()`（「上海」「上海市」均可命中）
- **刷新方法**：重新下载官方 xlsx，用项目工作目录同款解析脚本（zipfile+XML stdlib）重新生成覆盖本文件
