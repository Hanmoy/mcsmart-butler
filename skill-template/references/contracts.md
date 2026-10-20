# 输入输出契约（contracts.md）

本文件是 `mcsmart.mjs` CLI 的稳定契约。智能体按此构造输入、解析输出、处理错误；
**智能体只做转述，不得补造价格、营养或购买链接**——所有业务字段（价格/营养/方案/分账）
均由确定性内核（MILP 优化器 + 官方计价核验）产出。

## 1. 通用约定

| 约定 | 说明 |
|---|---|
| 金额单位 | **分**（`*Cents` 后缀字段）；人类可读文本卡中渲染为元 |
| 数量单位 | 整数份数（`qty`） |
| 热量单位 | kcal（千卡）；营养其他单位：蛋白质/脂肪/碳水 g，钠 mg |
| 输入传递 | 复杂输入 = UTF-8 JSON 文件（`--file 路径`）或标准输入（`--stdin`）；避免命令行内联中文 JSON |
| 输出分离 | 正常结果 → stdout（结构化 JSON）；日志/进度 → stderr；`--format text` 时 stdout 为人类可读文本卡 |
| 结果信封 | 成功 `{"ok":true,"data":…}`；失败 `{"ok":false,"error":{"code","message","hint"}}` |
| 退出码 | 0 成功（含 `feasible:false` 的正常业务结果）；2 输入/配置错误；3 环境缺失（Token/布局）；4 上游/网络错误；5 无解；1 内部错误 |

## 2. 稳定错误码表

| code | 退出码 | 含义 | 处理建议（`error.hint` 摘要） |
|---|---|---|---|
| `E_INPUT_INVALID` | 2 | 输入缺失/非法/JSON 解析失败 | 修正输入字段；对照 §4/§5 与 examples.md |
| `E_CONFIG_INVALID` | 2 | 数据目录 config.json 的 tuning 字段非法 | 修正配置（见 setup.md 字段表）；`config --check` 复验 |
| `E_TOKEN_MISSING` | 3 | 未配置麦当劳 MCP Token | 按 setup.md 首次配置；离线命令（doctor/config/parse-group）不受影响 |
| `E_LAYOUT` | 3 | 安装包结构不完整 | 重新安装（需 SKILL.md + scripts/runtime/dist + scripts/data 齐全） |
| `E_NETWORK` | 4 | 上游连接失败或超时 | 检查网络后重试；`doctor --live` 排查 |
| `E_TOKEN_INVALID` | 4 | Token 失效/无权限（401/403/404） | 重新申请 Token 并更新配置 |
| `E_RATE_LIMIT` | 4 | 触发官方限流（600 次/分钟） | 等待 5–10 秒重试一次 |
| `E_UPSTREAM` | 4 | 官方服务端错误（5xx 或未知上游错误） | 稍后重试 |
| `E_STORE_CLOSED` | 4 | 门店非营业时段 | 结果已按菜单快照降级（价格=最后观测价），或换门店 |
| `E_STORE_NOT_FOUND` | 4 | 门店未找到 | 用 `stores` 按城市+关键词重查 |
| `E_PORT_BUSY` | 2 | ui 端口被其他程序占用 | 换端口：`ui --port 8899`（或改 config.json `tuning.uiPort`） |
| `E_NO_SOLUTION` | 5 | 硬约束下无可行方案 | 放宽预算/热量/约束（注意：solve 输出 `feasible:false` 时退出码仍为 0） |
| `E_INTERNAL` | 1 | 程序内部错误 | 查看 stderr 日志；附 `version` 输出反馈问题 |

## 3. 命令一览

| 命令 | 用途 | 需要 Token |
|---|---|---|
| `doctor [--live]` | 环境自检（布局/数据/配置/求解器/面板/凭据/实时能力/渠道；`--live` 联网验证） | 可选 |
| `ui [--port N] [--open] [--stop]` | 操作面板：启动/复用/打开浏览器/关闭（后台安静启动，仅监听 127.0.0.1） | ✗ |
| `stores --city X [--keyword Y]` | 查询附近门店（MCP 每次最多返回 5 家） | ✓ |
| `solve-single --file F \| --stdin` | 单人双预算配餐（热量×价格 MILP） | ✓ |
| `solve-group --file F \| --stdin` | 多人拼单仲裁（三轨比价 + 透明分账） | ✓ |
| `parse-group --file F \| --stdin` | 粘贴群聊文本 → 结构化成员（确认卡，无网络依赖） | ✗ |
| `mcdna [--demo 0] [--amount tier\|full] [--out 路径]` | 消费人格战报（SVG 落盘，stdout 返回统计+路径） | ✓ |
| `config [--check]` | 查看/校验生效配置 | ✗ |
| `version` | 版本与运行时信息 | ✗ |

全局：`--format text`（solve-single/solve-group 输出人类可读购买卡）。

面板（`ui` 启动的本机服务）另提供配置管理接口（供面板前端使用）：`GET /api/setup/status`（Token 配置状态，仅遮蔽摘要）、`POST /api/setup/token`（只读验证并保存）、`POST /api/setup/verify`（重验证）、`DELETE /api/setup/token`（清除）、`GET /api/health`（复用探测）。业务 API 在未配置 Token 时返回 `{needSetup:true, code:"E_TOKEN_MISSING"}`（HTTP 200，前端据此切换引导页）。

## 4. solve-single：输入

```jsonc
{
  "kcal": 650,                      // 必填，整篮购买热量贴合目标 kcal（1..5000）；不是硬上限
  "yuan": 32,                       // 必填，整单实付预算，元（1..500）
  "objectives": ["protein"],        // 可选，有序优化目标 ≤2 个，顺序即优先级
  "constraints": [                  // 可选，营养硬约束
    {"metric": "sodium", "op": "<=", "value": 1200},
    {"metric": "staple", "op": ">=", "value": 1}
  ],
  "storeCode": "1450684",           // 可选，已选门店；缺省=自动搜索/配置默认门店
  "storeName": "…",                 // 可选，与 storeCode 配套展示
  "city": "上海", "keyword": "…",   // 可选，未给 storeCode 时的门店搜索条件
  "preferCombo": true               // 可选（保留字段）
}
```

- `objectives` 支持 `protein`、`fat`、`carbohydrate`（别名 `carb`／`carbs`）、`sodium`、`fastCarb`、`veggie`、`price`；最多取两个有序目标。`kcal`／`kcal-fill`／`price-fill` 不单独加入优先目标，由热量贴合阶段承载。先减少未知热量食品，再最小化整篮热量与目标的绝对偏差；同偏差并列解再按用户目标、价格等阶段决定。蛋白质／蔬菜求更多，脂肪／碳水／钠／快碳求更少。方案的 `reasonNotes` 给出实际阶段说明。
- `constraints.metric` 支持 `protein`、`fat`、`carbohydrate`（别名 `carb`／`carbs`）、`sodium`、`fastCarb`、`veggie`、`staple`、`kcal`；`op` 为 `">="` 或 `"<="`。未显式给出主食约束时默认加 `staple>=1`。例如 `{"metric":"kcal","op":"<=","value":650}` 表示本人分配食品的热量硬上限；购买篮可以有剩余，仍按整篮付费。缺失或估算字段不能支撑相关严格达标声明。
- 热量语义：单人 `kcal` 是整篮购买热量的目标值，允许上下偏离；`fitToleranceKcal`（默认 150）是声明容差，不是放宽最优偏差的搜索带；最优解仍超出时如实提示。成员营养硬约束按实际分配计算，`yuan` 按整篮支付计算。上述带注释示例为 JSONC 说明，保存为 CLI 输入时须去掉注释并使用合法 JSON。

## 5. solve-single：输出（data 字段）

```jsonc
{
  "store": {"storeCode": "…", "storeName": "…"},
  "feasible": true,                 // false 时 solutions 为空、reason 说明原因（非错误）
  "reason": "",
  "scanned": 80, "comboCount": 42, "unmatched": 39,
  "officialMenu": {"status": "realtime"},  // v1.2：官方菜单渠道状态 realtime/snapshot/unavailable（与美团独立）
  "unmatchedNote": "未联结营养的菜单条目数（…）",
  "menuFromSnapshotAt": "2026-10-13T…",   // 仅当菜单来自快照（非营业时段）
  "menuSnapshotNote": "…",
  "objectives": ["kcal-fit", "protein", "price-min"],  // 实际生效的目标顺序
  "constraints": […],               // 实际生效的硬约束（含默认主食）
  "topK": 3,
  "solutions": [                    // ≤ topK 个完整购物篮，已按目标顺序排序
    {
      "items": [                    // 购买清单（本方案）
        {
          "code": "mcd-9900000890", "name": "板烧鸡腿堡四件套",
          "qty": 1,
          "price": 3150,            // 分/份（含槽位差价摊入）
          "kcal": 636,              // kcal/份（按默认槽位聚合）
          "category": "套餐（官方 App）",   // 套餐（官方 App）/ 单点（官方 App）/ 美团团购 · 券品
          "nutritionComplete": true,       // false = 含营养未收录组件（非食品玩具不计入）
          "stapleCount": 1,
          "deconstruction": [      // 每份选配（槽位）：默认项 + 可换选项差价
            {"roundName": "小食", "defaultName": "小杯玉米杯",
             "options": [{"name": "中薯条", "diffCents": 300}, …]}
          ]
        }
      ],
      "metrics": {
        "kcal": 636, "price": 3150,          // 聚合值（分）
        "protein": 28, "fat": 22, "carb": 60, "carbohydrate": 60,
        "sodium": 1180, "fastCarb": 0, "veggie": 0, "staple": 1,
        "nutritionPartial": true              // 仅当存在营养未收录槽位（此时宏量为已收录品项合计，不得宣称满足营养约束）
      },
      "menuPriceCents": 3150, "finalPriceCents": 3150, "discountCents": 0,
      "priceSource": "model-optimal",        // 价格来源等级，见 §7（v1.2 增加 snapshot=历史快照参考价）
      "priceNote": "…",                      // 人类可读口径说明
      "reasonNotes": ["…"],                  // v1.2：推荐理由（热量贴合/优先级/价格各阶段决策链）
      // ★ v1.4.11 W01：单人整篮**允许剩余**。三个口径必须分开说，不得混用：
      "memberKcal": 636,                     // = intake.memberKcal，本人实际摄入热量
      "intake": {
        "purchasedKcal": 800,                // 整篮买到的热量（金额按整篮支付）
        "memberKcal": 636,                   // 本人分配到的热量（营养硬约束按此口径判定）
        "leftoverKcal": 164,                 // 买而未分给本人的部分
        "complete": false,                   // true = 整篮全部吃完，无剩余
        "macros": {"protein": 28, "fat": 22, "carbohydrate": 60, "sodium": 1180},  // ★ 本人摄入，不是整篮合计
        "leftovers": [{"itemName": "中薯条", "qty": 1, "kcal": 164, "refPriceCents": 1300}]  // 仅当有剩余
      },
      "solveState": "proven-optimal",        // proven-optimal / feasible / infeasible
      "coverage": {"total": 4, "met": 3},    // 心愿/需求覆盖（分母=原始需求数）
      "gapTotal": 0,                         // 未满足软需求份数
      "leftovers": […],                      // 仅当存在合理富余（计入实付但未分给成员）
      "singleFallback": false                // 套餐池无解时放宽单点的标记
    }
  ],
  "channelDiagnostics": {…},       // 渠道诊断（美团团单召回情况），见 §8
  "disclaimer": "…"
}
```

## 6. solve-group：输入

```json
{
  "storeCode": "…", "storeName": "…",   // 可选；缺省=配置默认门店
  "members": [                           // 结构化成员（经确认卡修正后），1..8 人
    {
      "alias": "小李",
      "wishes": ["麦辣鸡腿堡", "中杯可乐"],   // 心愿短语原话（含数量/规格词）
      "taboos": ["香菜"],                      // 禁忌关键词（命中品名即排除）
      "kcalCap": 450,                          // 可选，个人控卡上限 kcal
      "sugarFree": true,                       // 可选，排除含糖快碳饮品
      "notes": ["少冰"],                       // 可选，特制需求 → 订单备注
      "personalCouponCents": 500               // 可选，个人券冲减（分）
    }
  ],
  "pastedText": "群聊记录原文",          // 可选，members 为空时的规则解析降级路径
  "userVouchers": [                      // 可选 ≤8 张，用户自持外部券
    {"channelLabel": "抖音", "name": "堡券", "priceYuan": 13.9,
     "contentsText": "巨无霸+中薯条+可乐", "storeScope": "…", "expireNote": "…"}
  ]
}
```

- 心愿短语解析由程序完成（数量词/规格词/同义词/口味词二段匹配），智能体**保留原话**即可，不要预先改写。
- 需要一次性确认卡修正（禁止多轮逐条追问）时：先调 `parse-group`，把 `members` 回显给用户修正后传给 `solve-group`。

## 7. solve-group：输出与价格来源等级

```jsonc
{
  "solution": { … },              // 轨道 1/内核主方案（结构见下）
  "bundle": { … } | null,         // 轨道 2：随心配套壳方案（未优于散点时附注「仅供参考」）
  "voucherTrack": { … } | null,   // 轨道 3：券方案（未用券且无避坑提示时为 null）
  "decision": {"winner": "official|voucher|tie-official", "label": "…",
               "reason": "…", "deltaCents": -1120, "thresholdCents": 300} | null,
  "unified": [ … ],               // ★ 跨轨去重排序后的候选方案 ≤5（推荐按此交付）
  "channelDiagnostics": {…}
}
```

方案对象（`unified[i]`）关键字段：

```jsonc
{
  "track": "a-la-carte|bundle|voucher", "trackNote": "…",
  "store": {"storeCode": "…", "storeName": "…"},
  "basket": [                      // ★ 按行组织的购买清单（含渠道）
    {"kind": "single|combo|voucher", "code": "…", "name": "…", "qty": 1,
     "refPriceCents": 1490,        // 该行模型价（券行 = 券参考价 + 补差）
     "perUnitConfig": ["巨无霸", "中薯条"],  // 每份选配摘要
     "channelLabel": "官方 App"}   // ★ 渠道标签（按此分组呈现购买路径）
  ],
  "members": [                     // ★ 每人食品分配与应付
    {"alias": "小李",
     "items": [{"code","name","qty","priceCents","isCombo","nutritionMatched","deconstruction",…}],
     "originalCents": 1860,        // 本人菜单原价合计
     "shareCents": 1210,           // 原价等比分摊份额
     "payableCents": 1210,         // 应付 = share − 个人券（≥0）
     "savedCents": 650,
     "personalCouponCents": 0, "kcal": 485,
     "unresolvedWishes": [], "tabooFiltered": []}
  ],
  "orderNotes": ["少冰…"],         // 汇总后的订单备注（可复制）
  "totals": {"originalCents": 5840, "paidCents": 4330, "discountCents": 1510,
             "priceSource": "calculate-price|menu-price|mixed", "priceNote": "…"},
  "deliveryFeeCents": 0,           // 到店自取恒 0
  "warnings": ["…"], "disclaimer": "…",
  "coverage": {"total": 4, "met": 4}, "gapTotal": 0, "solveState": "proven-optimal",
  // ★ v1.4.11 W09：结构化缺口。覆盖率扣掉的每一条心愿都要能在这里找到原因，不得静默。
  //   reason: no-candidate（池中无候选）/ taboo（与本人禁忌冲突）/ unsatisfied（候选有但没满足，缺 N 份）
  //           / kcal-unknown（营养未收录，控卡无法验证）/ structure-unknown（套餐结构未取得）
  "unmet": [{"alias": "小李", "keyword": "板烧鸡腿麦满分套餐", "reason": "no-candidate", "missingQty": 1}],
  "kernel": "milp-v6", "alternatives": [ … ]
}
```

**价格来源等级**（交付时必须如实标注，不得混用）：

| 等级 | 来源 | 含义 |
|---|---|---|
| `calculate-price` | 官方计价接口核验 | 已核验实付，最高可信 |
| `model-optimal` | MILP 模型内最优价 | 套餐默认配置 + 槽位差价；换选与结算以下单页为准 |
| `menu-price` | 菜单促销价 | 计价接口失败时的回退估算（显式标注「估算」） |
| `kb-reference` | 预置知识库/历史团单 | 券价为调研核验日参考价（`verifiedAt` 标注核验日期）；**历史参考，不是实时在售价** |

## 8. 渠道诊断与数据时效

`channelDiagnostics`（solve 输出）：

```jsonc
{"union": {"queried": 10, "admitted": 2, "tips": 0, "degraded": false,
           "dbUsed": false, "dbCount": 0, "source": "independent|none",
           "stats": {"queried": 20, "admitted": 2, "detailUnverified": 16,
                     "saleEnded": 1, "validityExpired": 1, "other": 0, "menuVerified": 0},
           "deals?": [{"name": "…", "priceYuan": 13.9, "verified": false, "note": "…"}],
           "unavailableReason?": "无凭据/查询失败原因（不含凭据）"},
 "preset": {"considered": 5, "admitted": 2},
 "user": {"considered": 0, "admitted": 0},
 "excluded": [{"name": "…", "priceYuan": 13.9, "reason": "…"}]}
```

- **「接口查询成功」≠「可参与求解」**：`stats.queried` 是接口返回团单数，`stats.admitted` 表示该阶段通过内容准入的数量（配方、受支持模式、官方同名套餐／单品等核验路径；还须继续通过建槽、求解与最终推荐，不能将准入数量等同于推荐数量）；`detailUnverified`（券面明细未核验，仅展示）、`saleEnded`（售卖期已过/停售）、`validityExpired`（券有效期已过）逐类计数；`menuVerified`（v1.2）= 通过「券名 ↔ 官方菜单同名套餐归一化全名一致」核验入池的数量（内容取官方套餐构成，零假造）；
- `union.deals` 是包含未入池者的独立清单，`status` 为 `admitted`／`price-candidate`／`unavailable`，`note` 给原因。`stats.discovery` 记录发现层分页、截断及求解池情况；池外条目保留为价格候选。可查询 ≠ 可购买 ≠ 可核销。
- `source:"independent"` = 内置独立客户端直连联盟网关（凭据可来自环境、本地配置或随包来源，不表示凭据一定归项目所有）（内置客户端独立接入，运行时不依赖任何外部 Skill）；`source:"none"` = 无凭据未查询（本地团单库/预置知识库兜底，历史参考口径）；
- `menuFromSnapshotAt` 非空 = 菜单来自快照（非营业时段），价格为最后观测价——**历史快照不是实时菜单**；v1.2 起快照兜底按「当前可购池」口径过滤（观测时效 + 餐段启发式，`menuSnapshotNote` 说明明细）；
- solve-group 输出增加 `menuUnavailable`（v1.2）：官方菜单不可用（实时失败且无快照）时 `solution` 为需求回执（不构成配餐方案），美团查询结果保留在 `channelDiagnostics`；
- 券的 `verifiedAt` 距今超过 14 天（`KB_STALE_DAYS`）在 warnings 中标注「可能过期」。

## 9. stores / parse-group / mcdna / ui / doctor 输出速览

- `stores` → `{"city","keyword","cap":5,"stores":[{"storeCode","storeName","address","distance","open"}]}`
- `parse-group` → `{"members":[…],"needsConfirm":bool,"note?":"…"}`（needsConfirm=false 表示完全未识别，需切换快捷表单）
- `mcdna` → `{stats,svgPath,backSvgPath,agentRequestPath|null,reportId,snapshotId,templateId:"status",persona,copy,commentaryStatus:"rules"|"agent",hashes,warnings,note}`。唯一模板「麦门状态栏」，双面1080×1440（viewBox 540×720，文字为随包像素点阵矢量，图片仅 data: URI）。`persona={sect,sectName,sectRule,role,scene,sceneName,body,pose,prop,qualifier:{word,level:item|category},why,weak}` 由程序按订单判定；`copy={title,verdict,achievements[],dialogue,hook}` 为代入事实后的上卡文字。`--demo 0`真实模式不隐式回退演示，`stats.dataState=empty|cold-start|ready`；失败保持稳定错误码。`amountMode:tier`时返回stats的金额字段为null，钱包打码+档位；full才返回已知分值，缺金额仍null。`spendBasis`区分订单实付/食品小计/混合/未知，真实字段适配尚未联网实测。`pfcKnownQty/pfcUnknownQty`按食品份数；收录不足八成不显示供能比，PFC不参与人设。`--report-id <id> --file <文案JSON>`复用1小时有效的快照（schemaVersion 2；旧版快照返回 E_REPORT_EXPIRED），不重读官方订单；文案 `{snapshotId,title,verdict,achievements,dialogue,hook}` 用 `{事实编号}` 引用数字/食品，字数按代入后计（title 2–10、verdict 4–16、成就 1–3 条各 2–10 且须引用事实、dialogue 8–64、hook 2–14），自写数字/虚构事实/未点过的食品/越界话题/他牌梗/字库缺字一律 `E_INPUT_INVALID` 并给逐条原因，被拒不覆盖已接受文案；零订单 `agentRequestPath:null` 且不接收文案。`E_ORDER_FORMAT`=官方结构尚不支持，`E_REPORT_EXPIRED`=快照过期/缺失，不换演示。
- `ui` → `{"action":"started|reuse","url","port","pid","tokenConfigured","message","hint?"}`；`--stop` → `{"action":"stop","stopped","message"}`
- `doctor` → `{"layout":{…},"configErrors":[],"configWarnings":[],"credentials":{mcdTokenConfigured,meituanConfigured,verifiedAt,source},"capabilities":{programReady,panelReady,realtimeOrdering:"ready|unverified|missing-token|unavailable",meituanSource:"independent|none",offlineTools:[…],offlineOrdering:false},"checks":[{"id","name","status":"ok|warn|fail","detail","hint?"}],"ok":bool}`；检查项含 `panel`（面板资源与 ui 入口）与 `live`（实时菜单/计价；`--live` 时以只读时间接口真实验证）

## 10. 面板配置接口（`ui` 启动的本机服务内部 API，供面板前端使用）

| 接口 | 说明 |
|---|---|
| `GET /api/health` | 复用探测：`{ok, name, version, pid, tokenConfigured}` |
| `GET /api/setup/status` | Token 状态：`{tokenConfigured, tokenSource: "env\|config\|none", tokenMasked(仅前4后4), hasMeituan, configFile, mcdPortalUrl}` |
| `POST /api/setup/token` | `{token}` → 只读验证（仅时间接口，不读订单/地址）→ 保存到数据目录 config.json 并记录 verifiedAt；失败返回 `{ok:false, code, message, hint?}` |
| `POST /api/setup/verify` | 重新验证已配置 Token |
| `DELETE /api/setup/token` | 清除本地保存的 Token（env 来源提示从启动环境移除） |
| 业务 API | 未配置 Token 时返回 `{needSetup:true, code:"E_TOKEN_MISSING", setupUrl}`（HTTP 200，前端据此切换引导页） |

## 11. 智能体行为边界（重申）

1. 网页、CLI、Skill 共用同一业务内核；智能体不得按提示词重算价格/营养/排序。
2. 智能体职责 = 理解需求 → 补齐必要输入（成员表/门店/预算）→ 调用 CLI → 按 §5/§7 字段转述；功能介绍以 `doctor.capabilities` 为准，不得自行扩展（离线配餐未实现）。
3. 心愿匹配不到菜单就明说（`unresolvedWishes`），建议官方 App 补单；不编造品项。
4. 只读决策：不代下单、不托管资金；订单备注汇总后由用户在官方下单页自行填写。
5. 凭据边界：Token 只进面板输入框或本机数据目录，不进聊天、日志、诊断报告、分享物、发布包；不使用共享/他人 Token。
