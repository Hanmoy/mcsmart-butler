# 安装与首次配置（setup.md）

下文 `mcsmart` 均为 `node "<已安装Skill目录>/scripts/mcsmart.mjs"` 的简写，不是已注册的全局命令。开发者仍需从源码生成并安装完整包，不能仅复制根目录 SKILL.md。

## 1. 前提条件

| 前提 | 检查方式 | 说明 |
|---|---|---|
| Node.js ≥ 20 | `node --version`（doctor 也会准确检测） | 唯一运行前提；发布包自带编译产物、HiGHS WASM、面板资源、静态数据，无需 TypeScript、无需编译 |
| 麦当劳 MCP 个人 Token | `mcsmart doctor` | 实时菜单/计价必需；**使用每个人自己的 Token，由本人申请**（面板引导页有官方入口）；本 Skill 不内置、不代取、不共享任何人的 Token |
| 美团联盟凭据（可选） | `mcsmart doctor` | 没有它官方配餐完全可用；有它才有美团实时团单。当前随包保留内置来源，可用 env 或 config.json 覆盖，最终用户无需自行申请联盟开发者凭据，也不需要安装任何其他 Skill |

## 2. 首次配置（一次性，首选面板引导）

1. 运行 `mcsmart ui`（已运行的面板会自动复用），得到本机地址（形如 `http://127.0.0.1:8787/`，仅本机可访问）。
2. 打开面板——**没有 Token 时面板照常可用**，首次会自动弹出引导页：
   - 阅读说明（Token 用于访问你自己的麦当劳账户，只存本机）；
   - 点击「打开麦当劳官方 MCP 平台」由你本人注册申请；
   - 在遮蔽输入框粘贴 Token（默认隐藏显示，可点 👁 核对）；
   - 点击「验证并保存」——只调用只读时间接口验证连通性，**不读取订单历史、配送地址等个人数据**；
   - 成功后自动保存到用户数据目录，进入点餐面板。
3. 验证：`mcsmart doctor` 查看 Token 是否已配置。普通自检的 `realtimeOrdering` 仍是 `unverified`，即本次未联网；`doctor --live` 只调用时间接口，成功才为 `ready`，不代表全部业务接口已逐一通过。也可在面板点「验证连接」。
4. 之后直接说需求即可使用（跨工作区自动复用；升级/回退不覆盖）。

**备选（手动）**：不便打开面板时，把 Token 写入用户数据目录 `config.json`（目录见 doctor 输出 `userHome`，默认 `~/.mcsmart-butler/`）：

```json
{
  "schemaVersion": 1,
  "credentials": {
    "mcdMcpToken": "你的Token"
  }
}
```

也可以用环境变量 `MCD_MCP_TOKEN`（环境变量优先于 config.json；此来源没有「验证时间」记录，doctor 会标注"未联网验证"）。

**诚实边界**：安装本 Skill 不会自动获得你的麦当劳账户数据；个人账户接入始终需要你自己的 Token/授权。Token 仅存于本地数据目录，不进入聊天记录、日志、诊断报告或分享物。更换/清除 Token：面板右上角「连接状态」，或 `doctor` 查看。

## 3. 用户数据目录（可写区）

```
<userHome>/                     # MCSMART_HOME 环境变量可覆盖；默认 ~/.mcsmart-butler/
├─ config.json                  # 凭据 + 调优配置（用户所有，升级不覆盖）
├─ catalog.json                 # 菜单/团单运行缓存（观测数据持续累积）
├─ panel.pid                    # 面板后台进程记录（ui --stop 使用）
├─ logs/                        # 诊断日志
└─ out/                         # 生成物（McDNA SVG 等）
```

- 安装目录（Skill 包内）是**只读**的：种子数据（`scripts/data/`）、面板资源（`ui/`）与编译程序（`scripts/runtime/`）不回写；
- 缓存读取顺序：用户数据目录优先 → 包内种子兜底；
- **升级/回退只替换安装目录**，`<userHome>` 原样保留——凭据、配置、缓存均不受影响。

## 4. 操作面板（ui 命令）

| 操作 | 命令 | 说明 |
|---|---|---|
| 打开/复用 | `mcsmart ui [--port N] [--open]` | 端口上已有本面板 → 直接复用并返回地址；否则后台安静启动（PID 记录到用户数据目录）；`--open` 同时打开系统浏览器 |
| 关闭 | `mcsmart ui --stop` | 读取 PID 记录关闭后台面板；端口被其他程序占用时会明确提示 |

- 只监听 `127.0.0.1`（仅本机可访问）；默认端口 8787（`tuning.uiPort` 可改）；
- 面板内功能：单人精算 / 多人拼单 / McDNA / 首次配置引导 / 连接设置（更换、验证、清除 Token）；
- 方案卡以「在哪个平台买什么」为主体，每张卡自带「分账详情」切换（各方案用各自的分账数据）。

## 5. 配置字段表（config.json 的 tuning 段）

不写 `tuning` 段 = 全部用内置默认值。所有字段都有范围校验，非法值在 `config --check` 与 `doctor` 中报 `E_CONFIG_INVALID` 级错误；未知字段降级为警告（防拼写错误静默失效）。

```jsonc
{
  "tuning": {
    // —— 求解策略 ——
    "topK": 3,                      // 1..5    默认输出方案数
    "maxUnifiedPlans": 5,           // 1..5    多人跨轨统一输出上限
    "fitToleranceKcal": 150,        // 50..500 单人热量贴合容差（声明值：最优偏差超过时如实提示）
    "externalCouponLimit": 3,       // 0..5    整单外部券上限（程序口径，非平台规则）
    "comboMaxQty": 3,               // 1..8    官方套餐单篮数量上限
    "singleMaxQty": 2,              // 1..8    单品单篮数量上限
    "strictSurplusSingle": true,    // 单人富余声明口径（true=富余≤数量）

    // —— 排序策略 ——
    "groupRankStrategy": "coverage-first",  // coverage-first（先照顾「都想吃到」）| cost-first（先照顾「更便宜」）

    // —— 数据与缓存 ——
    "menuCacheTtlMin": 15,          // 1..120    菜单缓存分钟
    "comboCacheTtlMin": 60,         // 30..1440  套餐构成缓存分钟
    "dealMaxAgeDays": 14,           // 1..30 本地团单库观测窗口天
    "menuSnapshotMaxAgeDays": 30,   // 1..365 菜单快照「当前可购池」观测时效天
    "comboMaxPriceCents": 7000,     // 1000..20000 兼容保留字段；当前菜单采集不按此价格剔除商品
    "comboFetchLimit": 80,          // 10..200   套餐构成抓取条数上限
    "unionSolvePoolLimit": 60,      // 10..200  团购「受控求解池」条数：完整目录先分页取满，再按券面价升序取前 N 条逐条核验入池；池外条目保留为价格候选并逐条写明「未参与本次求解」
    "unionSearchLimit": 40,         // 10..60   旧口径单次查询条数上限（仅非发现层调用方使用，保留兼容）

    // —— 网络与上游 ——
    "mcdMcpUrl": "https://mcp.mcd.cn",  // 上游地址（测试可覆盖）
    "mcpTimeoutMs": 15000,          // 5000..60000  请求超时毫秒
    "groupKernel": "milp",          // milp（默认）| legacy（回滚旧贪心内核）
    "uiPort": 8787,                 // 1024..65535  面板默认端口

    // —— 默认门店 ——（用户未指定门店时的回退；建议改成常用门店）
    "defaultCity": "上海",
    "defaultKeyword": "上海",
    "demoStoreCode": "1450713",    // v1.2 起不再用于静默回退（门店查询失败会明确报错）
    "demoStoreName": "麦当劳上海黄浦华旭国际大厦餐厅（默认演示门店）",

    // —— 展示与诊断 ——
    "mcdnaAmountMode": "tier",      // tier（分享版金额脱敏）| full（仅本人查看）
    "logLevel": "info"              // silent | info | debug
  },
  "credentials": {
    "mcdMcpToken": "…",             // 麦当劳 MCP 个人 Token（或环境变量 MCD_MCP_TOKEN）
    "verifiedAt": "2026-10-13T…",   // 面板保存成功时自动写入的只读验证时间（勿手改）
    "meituanUnionAppkey": "…",      // 可选：美团联盟（独立接入，见 §6）
    "meituanUnionAppsecret": "…",
    "meituanUnionSid": "…"
  }
}
```

修改后运行 `mcsmart config --check` 校验并查看生效值。

## 6. 美团渠道（独立接入，开箱即用）

- **随包内置凭据**（v1.1 决策）：本项目拆用了公开发布的 meituan-assistant 内置联盟凭据（来源按项目记录说明；公开可获取不等于已核实授权或比赛豁免），凭据有效且接口可访问时可查询实时团单，**无需用户申请任何凭据、无需安装任何其他 Skill**；使用口径与原 skill 一致：只读比价、零收益、不生成推广短链；
- **用户可覆盖**（三级来源，前级优先）：环境变量 `MEITUAN_UNION_APPKEY/APPSECRET` → `config.json` 的 `credentials` 段 → 随包内置凭据；需要换成自己的联盟凭据时配置前两级即可；当前业务链不生成归因短链，不据此承诺产生收益；
- **「接口查询成功」≠「可参与求解」**：诊断输出逐类统计（查到 queried / 可求解 admitted / 明细未核验 / 售卖期已过 / 有效期已过），受控求解池内通过配方、受支持模式、官方同名套餐或同名单品等路径核验、可映射且满足售卖／时效要求的团单才参与自动比价；其余仅展示价格并注明原因；
- 内置凭据失效时（如原作者轮换密钥）：实时团单自动降级为本地团单库（最近 14 天观测）+ 预置知识库参考价（`kb-reference`，历史参考口径），官方配餐完全不受影响；渠道诊断会给出明确失败原因；
- 本项目不做第三方归因短链、不代下单、不托管券码。

## 7. doctor 能力状态（智能体据此介绍功能）

`doctor` 逐项返回并在 `capabilities` 汇总；**介绍功能时以此为唯一依据，不得自行扩展**：

| 状态字段 | 含义 |
|---|---|
| `programReady` | 程序与 HiGHS 求解器可加载 |
| `panelReady` | 面板资源完整、ui 命令可用 |
| `realtimeOrdering` | `ready`（本次 --live 时间探活通过）/ `unverified`（已配置但本次未联网）/ `missing-token`（未配置）/ `unavailable`（本次探活失败） |
| `meituanSource` | `independent`（独立凭据）/ `none` |
| `offlineTools` | 无 Token 可用功能清单（面板与首次配置、parse-group、config、doctor、version、城市列表、预置券库浏览） |
| `offlineOrdering` | 恒为 `false`——**离线配餐未实现**；历史快照不是实时菜单，模型价不是核价结果 |

## 8. 升级与回退

```bash
# 升级（自动备份当前版本到 <目标>/.versions/<旧版本>-<时间戳>/，保留最近 2 份）
node scripts/package-skill.mjs install --from <新包目录> --to <已安装的skill目录>

# 回退到上一版本
node scripts/package-skill.mjs rollback --to <已安装的skill目录>
```

- 用户数据目录（凭据/配置/缓存）在升级与回退中均不受影响；
- 也可以手动整目录替换（安装目录是自包含的）；替换后跑一次 `doctor` 确认；
- 版本号以 `mcsmart.mjs version` 与包内 `VERSION` 文件为准，WB 包与通用包一致。

## 9. 隐私与安全

- Token/凭据只存本地（环境变量或 `<userHome>/config.json`），不出现在输出、日志、分享物中；诊断报告只含遮蔽摘要（前 4 后 4 位）；
- Token 验证只调用只读时间接口，不读取订单历史、配送地址等个人数据；McDNA 战报仅在用户主动要求时读取订单；
- McDNA 分享版金额默认档位化脱敏（`mcdnaAmountMode:"tier"`）；对外分享物中不含手机号、姓名、门牌号；
- 只读决策边界：不代下单、不建立资金池、不托管他人账户权益；下单由用户本人在官方 App 完成。
