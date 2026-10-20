---
name: mcsmart-butler
description: 麦麦智能管家（开发仓库版）：拼单仲裁、双预算精算与 McDNA 战报的业务内核与 Skill 打包源码。本文件面向开发者；面向智能体/用户的正式 Skill 见 skill-template/SKILL.md（由打包脚本生成到发布包）。
---

# 麦麦智能管家（开发仓库）

> 本仓库是 **mcsmart-butler Skill 的源码仓库**：网页演示页与 Skill CLI 共用同一业务内核。
> 正式的 Skill 定义在 [`skill-template/SKILL.md`](./skill-template/SKILL.md)（打包时注入版本号）。

## 模块地图（Skill 化改造后）

| 域 | 模块 | 说明 |
|---|---|---|
| 配置 | `src/config.ts` | 可调参数单例（默认值 ← 用户 config.json ← 请求参数），零依赖校验器 |
| 路径 | `src/paths.ts` | 安装布局解析（dev/package 就近优先）；种子只读 + 用户数据目录可写 |
| 服务 | `src/service.ts` | **唯一业务编排层**：stores / solveSingle / solveGroup / mcdna / doctor；网页（server.ts）与 CLI（cli.ts）共用 |
| 单人配餐 | `src/optimizer.ts` | 双约束 MILP 内核（HiGHS WASM），套餐/槽位/购买单元建模 |
| 多人配餐 | `src/groupKernel.ts` + `src/group.ts` | 三轨统一内核（散点/套壳/券包）+ 心愿解析原语 |
| 渠道 | `src/unionCps.ts` + `src/unionClient.ts` + `src/vouchers.ts` | 美团 CPS 客户端（凭据来源：env → config → bundled；查询失败再退到本地团单库／预置参考资料）+ 券轨 |
| 营养 | `src/nutrition.ts` + `src/officialNutrition.ts` | MCP 营养表解析 + 官网营养库（规格级行） |
| 分账 | group/groupKernel 内（`members[].shareCents/payableCents`） | 参考原价→食品单位数→人数分摊；个人券只冲减本人，尾差守恒 |
| 展示 | `src/present.ts` | 「先怎么买，再怎么看详情」文本卡（CLI `--format text`） |
| CLI | `src/cli.ts` | doctor/stores/solve-single/solve-group/parse-group/mcdna/config/version；稳定错误码 |
| 网页 | `src/server.ts` | HTTP 薄壳（业务全部委托 service.ts，响应结构与 CLI 同源） |

## 开发与验证

```bash
npm run build        # tsc 编译（src → dist）
npm test             # 全量回归（内核契约/解析/目标/券轨/CLI 契约）
npm run watch        # 监听编译
npm run cli -- ui    # 直接打开操作面板（无 Token 时进入首次配置引导）
```

改单个模块后：`npm run build && node scripts/test-<对应域>.mjs`（如改 groupKernel → `test-group-kernel.mjs`）；全量验证跑 `npm test`。

## 打包与安装（发布包一律从源码生成）

```bash
npm run package                       # = node scripts/package-skill.mjs build（编译→组装→隐私断言→烟测）
node scripts/package-skill.mjs build --zip   # 额外生成 mcsmart-butler-vX.Y.Z.zip
node scripts/package-skill.mjs install --from dist-package/mcsmart-butler --to <目标skill目录>   # 安装/升级（自动备份）
node scripts/package-skill.mjs rollback --to <目标skill目录>                                     # 回退上一版本
node scripts/acceptance-test.mjs      # 干净环境验收（中文+空格路径/无Token/失效Token/断网/缺依赖/升级回退/真实端到端）
```

发布包结构、配置字段表、验收矩阵详见：

- [`skill-template/SKILL.md`](./skill-template/SKILL.md) —— Skill 正式定义
- [`skill-template/references/setup.md`](./skill-template/references/setup.md) —— 首次配置与字段表
- [`skill-template/references/contracts.md`](./skill-template/references/contracts.md) —— CLI 输入输出契约与错误码
- [`docs/README.md`](./docs/README.md) —— 公开文档索引与验收范围说明

## 历史文档

- 演示页运行：`npm run dev`（http://127.0.0.1:8787）
- 完整开发过程、PRD 与内部能力边界记录不随公开仓库分发；公开说明见 [`docs/README.md`](./docs/README.md)。
