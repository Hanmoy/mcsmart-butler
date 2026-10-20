# 麦麦智能管家 · McSmart Butler

**把想吃什么、预算和营养目标，变成一张能照着点、能分清账的麦当劳购物清单。**

基于麦当劳官方 MCP 的本机面板与 Agent Skill：一个人搭配一餐，一群人比较套餐与团购，再把近期订单变成有自己本命食物的 McDNA 分享卡。

[![McDonald's MCP](https://img.shields.io/badge/McDonald's-MCP-DA291C)](https://github.com/M-China/mcd-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Contest](https://img.shields.io/badge/2026-麦当劳程序员创意开发大赛-FFC72C)](https://github.com/M-China/mcd-developer-innovation-challenge)
[![CI](https://github.com/Hanmoy/mcsmart-butler/actions/workflows/ci.yml/badge.svg)](https://github.com/Hanmoy/mcsmart-butler/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Hanmoy/mcsmart-butler?display_name=tag)](https://github.com/Hanmoy/mcsmart-butler/releases)

<p align="center">
  <img src="docs/screens/contest-20261020-mcdna.png" width="1000" alt="当前源码面板：使用内置演示订单生成 McDNA 正反面，未接入个人账户">
</p>

> 麦当劳程序员创意开发大赛参赛项目，非麦当劳官方产品。图中为明确标注的演示数据；真实点餐使用自己的麦当劳 MCP Token，程序只提供决策与清单，不代下单。

## 三件日常小事，一套确定性内核

| 你要完成的事 | 管家提供的结果 |
| --- | --- |
| 一个人点餐，在餐费上限内贴近热量目标 | 完整购物篮、每份选配、营养来源、整篮／本人分配／剩余说明 |
| 几个人各有想吃的，还要比较套餐、团购并 AA | 三类购买方案、逐人分配、心愿缺口、分账与可复制购买清单 |
| 把最近点过的麦当劳变成可分享的记录 | 纸板像素风 McDNA 双面卡，本命食物主角、麦门门派、成就与评语 |

面板可以直接使用，不要求先安装 Agent。WorkBuddy 等宿主可通过正式 Skill 调用同一套 CLI；Agent 负责理解需求和表达，食品匹配、套餐选配、营养、约束、价格排序与分账由程序完成。

想直接看面板：本项目是本地应用，暂无公网 Demo；按“在线预览”与“先运行起来”在本机启动。想在 WorkBuddy 里使用：下载 [Release](https://github.com/Hanmoy/mcsmart-butler/releases) 中的 Skill 安装包，按“在 WorkBuddy 中使用”安装。两条入口共用同一套业务服务与确定性内核。

适合自己点餐时想兼顾餐费与营养目标的人、办公室或宿舍的拼单发起人，以及想记录和分享麦当劳消费习惯的会员。

## 在线预览

**目前没有公网在线预览地址。** 面板是本地应用：需要本机 Node.js，麦当劳个人 MCP Token 只保存在本机，服务只监听 `127.0.0.1`；把带账户能力的服务直接公开会扩大凭据与订单泄露面。仓库 About 里的链接是代码仓库，不是可直接交互的 Demo。

不接 Token 也能看到的内容：

- 上面的界面截图，以及 `docs/screens/` 中的单人、多人、McDNA 截图；
- 按下面步骤启动后，没有 Token 也能浏览面板，并在 McDNA 页面使用内置演示样本；
- 真实配餐与真实订单需要自己的麦当劳 Token；团购查询使用随包或自配的联盟凭据，见“数据和价格怎么看”。

如果评审需要可交互演示，应单独做一个**模拟数据、明确标注、不接真实账户**的静态 Demo；不要把本地面板直接暴露到公网。

## 先运行起来

需要 Node.js 与 npm。项目声明 Node.js ≥20；建议使用 Node.js 24.x。Python 只用于可选的浏览器回归，不是日常运行依赖。

下面以 Windows PowerShell 为例：

~~~powershell
git clone https://github.com/Hanmoy/mcsmart-butler.git
if ($LASTEXITCODE -ne 0) { throw "克隆失败，请先确认仓库已公开且地址正确" }
Set-Location -LiteralPath mcsmart-butler -ErrorAction Stop
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw "依赖安装失败" }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "编译失败，未启动面板" }
node dist/cli.js ui --open
~~~

仓库已公开，可直接按上述步骤克隆；已有源码时，先进入源码根目录，从 `npm.cmd ci` 开始。终端返回本机面板地址，启动命令会尝试打开浏览器。服务仅监听 `127.0.0.1`；默认端口被占用时，可指定 `ui --port 8899 --open`。

1. 首次打开时，从页面进入 [麦当劳 MCP 开放平台](https://open.mcd.cn/mcp)，由本人申请个人 Token。
2. 粘贴到面板的遮蔽输入框，点击“验证并保存”。验证只调用官方时间接口。
3. 选择城市和门店，开始单人精算或多人拼单。

**无需把 Token 发到聊天、Issue 或仓库。** 没有 Token 也可先浏览面板，在 McDNA 页面使用内置演示样本；实时配餐和真实订单仍需本人接入。

开发者也可使用 `MCD_MCP_TOKEN` 环境变量。麦当劳 Token 读取顺序为非空环境变量优先、用户本地配置其次；上面的启动方式不要求创建 `.env`。

## 单人：预算内贴合这一餐

填写热量目标与整单价格预算，选填用餐时间、主食份数及营养目标。页面可选更省钱、蛋白质更多、钠更少、碳水更少，最多两项，按点击顺序排列优先级。

- **价格预算是整单上限；热量输入是整篮购买热量的贴合目标。** 严格营养上下界与目标值是两种要求。CLI／业务接口支持通过 `constraints` 显式设置热量等硬约束。
- 保留实际食品、规格、数量、套餐轮次与换选补差，不把含糖和无糖、大份和中份合并成同一食品。
- 单人购物篮可以有剩余。结果分别展示整篮营养、本人分配与逐项剩余；相关营养硬约束按本人分配判定，费用仍按整篮计算。
- 没有可行方案时说明原因，不用零元方案或营养未知值冒充满足需求。

<p align="center">
  <img src="docs/screens/contest-20261020-single.png" width="900" alt="当前源码单人精算输入界面，未配置 Token，未生成实时购买方案">
</p>

## 多人：先说明怎么买，再说明怎么分

粘贴群聊，或直接填写成员确认卡。支持最多 8 人，逐人编辑心愿、忌口、热量上限、无糖需求、个人优惠与备注。文本解析后仍需核对确认卡。

管家比较三类候选：

1. 官方单点；
2. 官方套餐与合法换选，再补齐缺少的单品；
3. 内容已核验的美团团购或用户录入券，加官方商品补齐。

结果展示每份套餐怎么配、谁拿什么、哪些心愿没有满足、不同渠道分别怎么买，以及每人的分账。食品内容相同的方案归并购买途径；不同规格、糖型或数量仍分别保留。

分账优先按分配食品的参考原价占比分摊；缺少可用原价时按食品单位数，再退到人数等额。个人优惠按结果中的个人口径扣减，金额尾差做舍入校正。

<p align="center">
  <img src="docs/screens/contest-20261020-group.png" width="900" alt="当前源码多人拼单输入界面，包含群聊、成员确认卡和自持券录入">
</p>

> 只输出购买指引与分账，不代下单、不代付、不托管券码或他人账户权益。“少冰、去配料”等备注仍需在实际下单时确认，不保证上游支持所有备注。

## 推荐方案怎么算

程序不是按菜名标签排序，也不是让 Agent 凭感觉挑。它把“买哪些食品／套餐／券、每份怎么选配、分给谁”建成一个混合整数线性规划（MILP）：先把可行候选和硬约束写进模型，再按固定优先级逐段求解；Agent 只负责理解需求和解释结果。完整调用链与字段口径见 [MCP_INTEGRATION.md](MCP_INTEGRATION.md)。

### 候选池

- 官方单品、套餐和真实套餐轮次：保留食品身份、规格、默认项、换选补差与数量；
- 官方套餐允许的合法换选，以及套餐缺少的单品补齐；
- 内容已通过核验、能映射到官方食品的美团团购券或用户券，加官方商品补齐；
- 营养按“食品 + 规格”匹配；缺失保持未知，不按 0 分；团购不校验具体适用门店，购买前请看券面与下单页。

### 单人

输入热量目标、整单预算、用餐时间、主食份数和最多两个营养优先级。整单预算和显式营养上下界是硬约束；热量输入默认是“尽量贴近的目标”，不是硬上限（在 `constraints` 中显式写 `kcal <=` 才是硬上限）。

求解按以下顺序进行，每一步把上一步的最优值固定住再解下一步：

1. 先减少营养未收录食品的份数，避免“热量按 0 算”的方案靠前；
2. 再最小化 `|整篮热量 − 目标|`，锁定到本次能达到的最优偏差；
3. 再按用户选择的优先级依次优化（蛋白质更多、钠更少等；若选“更省钱”，价格在这一步提前锁定）；
4. 再最小化整单价格；
5. 最后减少未分配的剩余食品。

默认输出最多 3 个完整购物篮，按“食品内容 + 数量”去重；换玩具、换排列不算新方案。价格是模型内最优价，结算以下单页为准；单人方案不承诺每个购物篮都经过官方实时核价。

### 多人

输入最多 8 名成员的心愿、忌口、热量上限、无糖要求、个人优惠和备注。心愿先匹配到具体食品；未匹配的心愿进入缺口统计，忌口项单独列出，都不会被悄悄删掉。

候选分三轨，每轨独立求解默认最多 3 个方案：

1. 官方单点；
2. 官方单点 + 套餐与合法换选；
3. 再加入内容已核验的美团团购券／用户券。

模型同时决定“买哪些、每份怎么配、每件分给谁”。硬约束包括成员热量上限、忌口／无糖、套餐必须按完整购买单元成立（不能把 A 套餐的槽位和 B 套餐拼成假套餐），以及“恰好／必须”类心愿。当前多人入口没有整单现金预算字段，不能把单人的预算能力直接当作多人已有功能。

多人的求解顺序：

1. 先让“最不满意成员”的缺口最小；
2. 再让全体缺口合计最小；
3. 再减少营养未收录食品；
4. 再最小化实付价格；
5. 最后减少未分配剩余。

覆盖率始终以原始心愿为分母。三轨默认按“缺口优先、价格其次”比较，也可配置为价格优先。券轨只有覆盖不少于官方轨时才参与推荐；券包比官方便宜不超过动态阈值（官方实付的 3%，最低 ¥3、最高 ¥8）时优先官方，避免为了几块钱跨 App 买券核销；便宜超过阈值才推荐券，券更贵则官方。最终候选按食品内容去重，页面上的“推荐”和“最便宜”来自同一份决策，不会互相矛盾。

### 价格与分账

官方部分能核价时用麦当劳 `calculate-price`，失败时保留模型价或菜单价并标注来源；券部分按券面参考价。分账优先按各人所得食品的参考原价比例；缺原价时按食品单位数；再不行按人数等额。未分配剩余成本按人数均摊，个人优惠只冲减本人应付，尾差只做分级差校正；分摊额合计等于方案实付。

价格、营养未知项和候选截断都会在结果里标注；求解受本次菜单、候选池和搜索预算限制，不承诺全平台绝对最低价。

## McDNA：本命食物长成你的麦门状态栏

一套纸板像素风，正反两张 **1080×1440** 分享卡：

- **正面**：订单等级、本命食品、食品背包、钱包档位与常驻饭点；
- **背面**：麦门门派、生活场景、成就、管家评语和可接话的分享提问；
- **8 个门派**：单推、夜巡、早课、图鉴、甜区、随心、准点、见习，按订单统计与明确门槛判定；
- 主角依据常点食品在 8 类身体、3 种姿势中选择，再搭配门派道具和 4 个场景。

<p align="center">
  <img src="docs/screens/mcdna-v1411-front.png" width="320" alt="McDNA 正面：演示样本，金额档位脱敏">
  <img src="docs/screens/mcdna-v1411-back.png" width="320" alt="McDNA 背面：演示样本，规则生成评语">
</p>

**默认不需要额外的文本模型 API。** 程序用内置梗库生成文案。想更有个人味道，可以在面板复制事实提示词，交给自己的 Agent，再把 JSON 粘贴回来。

Agent 只填写称号、判词、成就、对话和结尾提问；数字通过事实编号由程序代入。程序检查事实引用、食品、糖型／规格、长度和内容边界，不合格文案不会覆盖已有成品。

正反面可分别下载 SVG 与 PNG。金额默认档位脱敏；选择完整金额后，导出的卡片也会包含该金额。真实订单按接口实际返回的区间统计，少订单与零订单保留真实状态，失败时不自动改用演示。这是娱乐化消费记录，不是人格测评或健康评价。

## 数据和价格怎么看

| 数据 | 当前处理方式 |
| --- | --- |
| 门店菜单与套餐轮次 | 麦当劳官方 MCP；目标时间查询传递同一时间上下文 |
| 营养 | 按食品和规格联结 MCP 营养表、本地官网营养资料与已有调查补录；估算和未知字段保留标记 |
| 官方部分价格 | 标注官方计价、菜单价或模型价；单人方案不承诺整篮已逐一官方核价 |
| 美团团购 | 内置联盟客户端按城市查询；内容已核验且可映射的条目参与自动组合，其余保留为价格候选 |
| 历史菜单与团单 | 标记快照日期与参考价，受时效限制，不冒充实时结果 |

美团联盟凭据读取优先级为：**环境变量 → 用户配置 → 随包内置凭据**。当前项目保留随包内置来源；可配置自己的 `MEITUAN_UNION_APPKEY`、`MEITUAN_UNION_APPSECRET` 覆盖。联盟接入独立于麦当劳 MCP，项目不生成推广归因短链。

团购查询保留所选城市与官方门店菜单上下文，**不校验券的具体适用门店**，不据此宣称全国通用。购买与核销前请在券面和官方下单页确认适用条件。

完整调用链见 [MCP_INTEGRATION.md](MCP_INTEGRATION.md)，数据来源见 [data/README.md](data/README.md)。

## 在 WorkBuddy 中使用

根目录 `SKILL.md` 是开发仓库说明，**不能仅复制该文件就完成安装**。正式 Skill 从源码打包生成：

~~~powershell
node scripts/package-skill.mjs build --zip
if ($LASTEXITCODE -ne 0) { throw "打包失败，未进入安装步骤" }
~~~

输出 `dist-package/mcsmart-butler/` 与对应版本 ZIP。包内包含正式 Skill、参考文档、启动器、运行时、只读种子数据和完整面板资源，不包含 Node 本体。

先确认当前宿主实际加载的技能目录。例如使用 `.workbuddy-ai/skills` 时：

~~~powershell
$skillDir = Join-Path $env:USERPROFILE ".workbuddy-ai/skills/mcsmart-butler"
node scripts/package-skill.mjs install --from dist-package/mcsmart-butler --to "$skillDir"
if ($LASTEXITCODE -ne 0) { throw "安装失败，未启动面板" }
node "$skillDir/scripts/mcsmart.mjs" doctor
node "$skillDir/scripts/mcsmart.mjs" ui --open
~~~

国内版等其他安装环境可能使用 `.workbuddy/skills`，请按实际目录选择。重新加载技能后，可以这样描述需求：

~~~text
一个人，预算 25 元，热量目标 600 kcal，优先少钠，帮我选门店后配一餐。

三个人拼单：小林要麦辣鸡腿堡和无糖可乐，小周要大薯，
小陈想吃麦香鱼。先让我确认成员需求，再比较怎么买、怎么分账。

先用演示订单看看 McDNA。之后我明确选择真实订单时，再读取我的账户。
~~~

智能体统一调用确定性 CLI，不自行重新计算购物篮、营养或分账。详见 [正式 Skill 模板](skill-template/SKILL.md)。

## 本地数据与升级

- 安装目录保存程序与只读种子；配置、目录、配方、营养补录、快照及日志默认在 `~/.mcsmart-butler/`，可设置 `MCSMART_HOME` 覆盖。
- 麦当劳个人 Token 通过本机环境或配置接入，不放入分享卡；真实战报的聚合统计会在本地保存快照，用于重绘。
- 复制 Agent 提示词会把其中的聚合事实交给所选宿主，请按自己的分享范围使用。
- 升级前关闭面板，并确认对应进程退出。安装备份旧程序、通常保留最近两份；用户数据目录独立保留。宿主限制清理时可能保留额外备份或隔离目录。

~~~powershell
# 按实际启动入口二选一；如曾指定端口，补上相同的 --port
node dist/cli.js ui --stop                         # 从源码启动
# node "$skillDir/scripts/mcsmart.mjs" ui --stop   # 从已安装 Skill 启动

# 回退已安装程序（需要已有备份，先停服）
node scripts/package-skill.mjs rollback --to "$skillDir"
~~~

## 开发与验证

技术栈：Node.js、TypeScript、HiGHS WASM／MILP、原生 HTML/CSS/JavaScript。业务编排唯一入口为 `src/service.ts`，HTTP 与 CLI 共用它。

~~~powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:browser
node scripts/report-delivery-drift.mjs --install "$skillDir"
~~~

浏览器回归使用 **Python Playwright 与 Chromium**；未找到可用解释器时明确跳过，不等于通过。可用环境变量 `PYTHON` 指定解释器。浏览器脚本不会代替前置编译。

CI 在 Windows 上使用 Node.js 22／24 执行依赖安装、构建、Node 测试、浏览器回归和打包烟测；设置 `MCSMART_REQUIRE_BROWSER=1` 时，找不到 Playwright 会直接失败而不是跳过。

欢迎通过 Issue 反馈问题和提交 PR；提交前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，不要附带 Token、券码、订单或本机配置。

~~~text
src/service.ts              业务编排与输出契约
src/optimizer.ts            单人／多人共享 MILP 模型
src/groupKernel.ts          多渠道建池、方案比较与分账
src/menu.ts                 官方菜单、规格与套餐轮次
src/unionCps.ts              联盟团购查询与核验
src/mcdna*.ts               订单统计、门派与事实文案
src/cli.ts / src/server.ts  CLI 与本机 HTTP 入口
public/                     面板、战报渲染器与素材
skill-template/             正式 Skill、启动器与参考文档
scripts/package-skill.mjs   从源码构建／安装／回退
~~~

版本以 `package.json` 为准，当前为 **1.4.12**；发布记录见 [CHANGELOG.md](CHANGELOG.md)。同一版本号下源码仍可能有后续页面修订，发布包应重新由当前源码生成，并用漂移检查核对内容。

## 当前边界

- 目前以到店自取为主（`orderType=1`、`beType=1`）；查询目标时间菜单不代表已提交预约订单。
- 求解受本次菜单、候选池、搜索预算和核验能力限制，不承诺全平台绝对最低价。发现层及求解池设有上限，截断会给出说明。
- 营养缺失不视为零；估算可用于普通目标参考，不能据此宣称严格达标或作专业健康建议。
- 官方菜单与快照均不可用时，保留需求和渠道查询信息，不生成推荐购物篮；完整离线配餐尚未实现。
- McDNA 真实订单入口已实现，但**非空真实账户订单与金额字段适配尚未完成联网验收**；演示图与模拟测试不作为该项验收证明。
- 历史验证记录保留在本地，不随公开仓库分发；README 中的截图与测试结果仅代表对应时间和范围。

## 安全与第三方凭据

- 面板只监听 `127.0.0.1`；麦当劳个人 Token 只保存在本机用户目录，不写入仓库、日志或分享卡。
- 团购查询使用随包 `data/union-credentials.json` 中的第三方联盟凭据（来源与替换方式见 [SECURITY.md](SECURITY.md)）。它不是麦当劳官方凭据，也不代表美团官方授权；可用环境变量或用户配置替换为自己的凭据。
- 仓库不包含个人订单、账号配置或手机号。提交 Issue/PR 时请勿粘贴 Token、券码或订单截图。
- 安全问题请按 [SECURITY.md](SECURITY.md) 的私密渠道报告。

## 许可与致谢

项目原创代码采用 [MIT License](LICENSE)。麦当劳名称、标识及来源数据的相关权利归原权利人；第三方组件和字体遵循各自许可，见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

- [麦当劳官方 MCP 接入指南](https://github.com/M-China/mcd-mcp-server)
- [麦当劳程序员创意开发大赛](https://github.com/M-China/mcd-developer-innovation-challenge)
- [参赛声明](CONTEST_DECLARATION.md)
- [WorkBuddy 开发上下文](workbuddy.md)
