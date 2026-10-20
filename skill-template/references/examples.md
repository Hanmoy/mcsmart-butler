# 调用示例（examples.md）

以下示例中 `mcsmart` 均指 `node <skill目录>/scripts/mcsmart.mjs`。
对话中能得到的信息（门店、人数、心愿）直接填入输入；只有影响结果的关键歧义才向用户确认。

## 例 0：首次使用（面板引导）

用户说：「装好了，怎么开始用？」

```bash
mcsmart doctor      # → capabilities.realtimeOrdering = "missing-token"
mcsmart ui          # → {"action":"started","url":"http://127.0.0.1:8787/",…}
```

**话术**：把 `url` 给用户点击：「面板已打开：http://127.0.0.1:8787/ 。首次使用请在引导页完成配置：点击面板里的官方平台链接申请你自己的麦当劳 Token → 粘贴到输入框 → 验证并保存（只做只读连通性检查，不读取你的订单或地址）。配置一次后所有工作区都能直接用。**请勿把 Token 发到聊天里**。」
用户配置完成后，普通 `doctor` 可确认 Token 已配置；`capabilities.realtimeOrdering` 仍为 `unverified`，表示这次自检没有联网。只有本次运行 `doctor --live` 且只读时间探活成功，才返回 `ready`；它不等于菜单、核价和订单接口全部已验证。

## 例 1：单人双预算点餐

用户说：「今天只剩 650 大卡，饭钱不超过 32，帮我在麦当劳点一份。」

```bash
# /tmp/single.json（UTF-8）
{"kcal": 650, "yuan": 32, "objectives": ["protein"], "constraints": [{"metric":"kcal","op":"<=","value":650}]}
mcsmart solve-single --file /tmp/single.json
```

这里“只剩 650 大卡”按本人摄入硬上限处理，因此显式加入 `kcal<=650`；单独传 `kcal:650` 仅代表整篮贴合目标。仍须按结果说明整篮、本人分配与剩余。

已选定门店时加 `"storeCode":"…"`（省一次门店搜索）；未选定时按输入或配置中的城市与关键词真实搜索，
并在输出 `store` 字段中告知使用的门店。查询失败不静默回退演示门店。

**交付**（`--format text` 即得同款文本卡；JSON 则按 contracts.md §5 转述）：

1. 先说怎么买：门店 + 按渠道组织的购买清单（买几个套餐、每份槽位默认选配、可换选项）；
2. 再看详情：营养合计、约束覆盖、价格来源等级（`model-optimal` = 模型内最优，换选与结算以下单页为准）、快照降级提示（若有）；
3. **整篮不等于本人吃完**（v1.4.11 W01）：套餐买进来可能一份吃不完，此时必须分开说
   「整篮买到的热量（`intake.purchasedKcal`）/ 本人摄入（`intake.memberKcal`）/ 逐项剩余（`intake.leftovers`）」。
   热量与钠等硬约束按**本人摄入**判定，钱按整篮付；有剩余时给出应吃与应剩清单，不要只说「已满足 ≤500 大卡」。

## 例 2：多人拼单（粘贴群聊记录）

用户说：「办公室 4 个人拼麦当劳，群里的话发你：小李要麦辣鸡腿堡+可乐不吃香菜，王姐控卡450来个麦香鱼，阿强想吃板烧，帮我算怎么点怎么分账。」

**第 1 步**（可选，群聊乱序时用规则解析生成确认卡，无网络依赖）：

```bash
# /tmp/parse.json
{"pastedText": "小李要麦辣鸡腿堡+可乐不吃香菜，王姐控卡450来个麦香鱼，阿强想吃板烧"}
mcsmart parse-group --file /tmp/parse.json
```

把返回的 `members` 整理成**单张确认卡**请用户一次修正（禁止多轮逐条追问）。

**第 2 步**（按确认后的成员表求解）：

```bash
# /tmp/group.json
{
  "members": [
    {"alias": "小李", "wishes": ["麦辣鸡腿堡", "可乐"], "taboos": ["香菜"]},
    {"alias": "王姐", "wishes": ["麦香鱼"], "kcalCap": 450},
    {"alias": "阿强", "wishes": ["板烧"]}
  ]
}
mcsmart solve-group --file /tmp/group.json --format text
```

**交付**（对应 contracts.md §7）：

1. **先怎么买**：从 `unified[0]`（推荐方案）出发——整单实付、按 `basket[].channelLabel` 分组的购买清单（每行：名称 ×数量、价格、每份选配）、备选方案 2~3 概览；
2. **详情·分账**：`members[]` 每人「原价 → 摊后 → 个人券冲减 → 应付」，规则一句话（原价等比分摊、个人券只冲减本人、尾差守恒）；
3. **未满足与备注**：`unresolvedWishes` 明确列出（建议官方 App 补单）；`orderNotes` 汇总为可复制备注文本；
4. **比价结论**：`decision.label/reason`（官方 vs 券轨差价与判平阈值）。

## 例 3：带个人券的拼单

```bash
# /tmp/group-v.json
{
  "members": [{"alias": "我", "wishes": ["巨无霸", "中薯条"]}],
  "userVouchers": [
    {"channelLabel": "抖音", "name": "巨无霸套餐券", "priceYuan": 13.9,
     "contentsText": "巨无霸+中薯条+可乐", "expireNote": "购买后30天有效"}
  ]
}
mcsmart solve-group --file /tmp/group-v.json
```

输出 `voucherTrack` 与 `decision` 会给出「用券是否划算」；券价来源为 `kb-reference` 或 `user-claimed`，绝不冒充官方实时价。

## 例 4：McDNA 战报

用户说：「看看我的麦当劳人设。」

```bash
mcsmart mcdna --demo 1             # 明确选择演示样本（只有用户要求看演示时才用）
mcsmart mcdna --demo 0             # 读取真实订单；无订单/少订单/失败都不自动换演示，dataState 如实标注
```

返回 `svgPath` / `backSvgPath`（1080×1440 双面 SVG）+ `reportId` + `stats`；面板运行时另有本机 `panelUrl`
（`#mcdna?report=<reportId>`，载入同一快照、默认脱敏，不重读订单）。金额默认 `tier` 脱敏，
只有显式 `--amount full` 才显示明文；快照 1 小时过期。

## 例 5：错误处理

```bash
$ mcsmart solve-single --file /tmp/single.json   # 未配置 Token 时
{"ok":false,"error":{"code":"E_TOKEN_MISSING",
  "message":"未配置麦当劳 MCP Token：…",
  "hint":"按 references/setup.md 完成首次配置：…"}}

$ mcsmart solve-single --file bad.json           # 输入非法时
{"ok":false,"error":{"code":"E_INPUT_INVALID","message":"…","hint":"…"}}
```

智能体行动规则：`E_TOKEN_MISSING` → 引导用户走 setup.md 首次配置（一次性）；
`E_TOKEN_INVALID` → 提示重新申请 Token；
`E_RATE_LIMIT` → 等 5–10 秒重试一次；
`E_STORE_CLOSED` → 如实告知「非营业时段，价格为最后观测价」，或换门店重查；
`feasible:false`（退出码 0）→ 不是错误，向用户转述原因并建议放宽预算/约束。

## 例 6：开发与调试

```bash
mcsmart doctor --live        # 全面自检 + 联网探活
mcsmart config --check       # 配置校验 + 生效值
mcsmart version              # 版本/Node/HiGHS/布局模式
cat input.json | mcsmart solve-group --stdin    # 标准输入方式
```
