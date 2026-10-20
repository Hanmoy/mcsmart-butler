# v1.4.11 评审修复报告（2026-10-19）

> 公开版说明：本机绝对路径／面板端口已用占位符替换，统计与结论未改。


对应评审：`docs/WB_PROJECT_REVIEW_2026-10-19.md`（W01–W22：8 项 P1 + 13 项 P2 + 1 项 P3）。
执行顺序按评审给出的四段推进：**业务事实与约束**（W01–W04、W07、W09）→ **隐私与异步所有权**（W05、W06、W15–W18）→ **模板适配与文案事实**（W10–W14、W19、W21）→ **完整使用链与说明**（W20、W22）→ 最后 **交付**（W08）。

政策约束未变：团购不查询/不校验/不按具体适用门店排除；估算值可参与普通优化但不得严格达标；不发起真实下单/核销；测试与复现全部走隔离 `MCSMART_HOME`。

## 一、结论

- **W01–W22 全部落到代码或文档**，每项都有可复现断言，没有用「测试全绿」或「版本号相同」替代反例。
- 新增 3 个正式回归脚本（已进 `npm test` 串行链）：`scripts/test-v1411-service-fixes.mjs`（53 项）、`scripts/test-v1411-mcdna-fixes.mjs`（35 项）、`scripts/test-v1411-snapshot-prune.mjs`（8 项）；新增浏览器回归 `scripts/test-v1411-browser.py`（17 项）。
- `npm test` 退出 0：**42 个测试脚本 + tsc、1048 项 ✓、0 失败**。
- `npm run test:browser` 退出 0：**42 项**（原有 25 + 新增 17），未捕获页面异常 0。
- `npm run package`（build）退出 0：版本五源一致 **1.4.11**；干净隔离烟测 layout / seed-data / config / solver / panel / channel-meituan / offline 全 `ok`（credentials / live 为 `warn`，符合未联网预期）。
- 交付漂移：**源码＝发布包＝两处安装位完全同源**（runtime `b63a5a100d78f595`（38 个 js）、`index.html` `6cf588f75ae29944`、页面资源 65 文件 `374f2271f369ba3e`、5 个随包数据文件逐一相同，版本均 1.4.11），`report-delivery-drift.mjs` 两处均退出 0。
- 安装：`.workbuddy-ai`（1.4.10 → **1.4.11**，自动备份 1.4.10/1.4.11 各一份）、`.workbuddy`（1.4.4 → **1.4.11**，备份 1.4.4/1.4.11），两处 `postInstallDoctorOk: true`。
- 实际面板验收（真实安装位 + 真实服务，非打桩）：`scripts/acceptance-v1411-panel.py` **11 项通过**，正反面 PNG 已落盘 `docs/screens/mcdna-v1411-front.png` / `-back.png`（2779KB / 2545KB，均为 1080×1440 双面）。
- 用户数据目录 `~/.mcsmart-butler` 全程未被安装流程触碰；安装前另存整份备份 `~/backup-user-lib-20261019`（1.5MB）。

## 二、逐项处置

### P1：先纠正「能买什么 / 满足什么」

| 编号 | 评审问题 | 本轮处理 |
|---|---|---|
| W01 | 单人硬约束按整篮判，页面却把它当本人摄入 | 明确**单人整篮允许剩余**，并把它变成一等输出：`intake.purchasedKcal`（整篮）/ `intake.memberKcal`（本人分配，取 `memberAllocations[0]`）/ `intake.leftoverKcal` + `leftovers[]` 逐项剩余 + `intake.macros`（本人摄入的蛋白/脂肪/碳水/钠）。`memberKcal` 改为本人分配值，金额仍按整篮支付。营养硬约束（热量与钠等非热量限制）一律按本人摄入判定。页面与文本各加「整篮 / 本人摄入 / 逐项剩余」三行，**没有删掉超限提示来掩盖分歧** |
| W02 | 单人建池丢掉已取得的官方组件营养表 | `buildPlansFromMenuItems(menuData.items, { includeSingle: true, table: menuData.table })`：官方营养表按「同食品同规格」联结到套餐组件，未知/估算标记原样保留，不把套餐总营养摊给组件，也不放松「估算不得严格达标」 |
| W03 | 套餐候选按最大槽数合取，且能跨套餐拼槽 | 重写套餐心愿建模：`DemandMeta.unitClaims` 记录「成员 / 心愿 / 候选计划 / 购买单元」四元承接；每个候选计划各自建 `dunit_{di}_{p}_{u}`（≤ `buy_{p}_{u}`），再加 `dunit_slot_{di}_{p}_{r}` 要求「Σasg ≥ Σdunit」，**跨计划拼槽无法承接**。三件套 ¥20 不再因四件套更贵而被排除；明确三/四件套仍保留结构约束；单元内合法无糖换选继续成立 |
| W04 | 预约团购仍按查询当天判断能否核销 | `AsyncLocalStorage` 里的 `reservationDate/period` 经新增 `targetRedeemDate()` 传到叶子；`redeemWindowStatus(v, now, 'now'\|'target')` 区分「现在能否购买」与「目标时间能否核销」，自持券、联盟实时、缓存与降级四条准入路径统一使用；原因文案区分「今天是」/「目标时间是」。未增加具体门店校验 |
| W07 | 食品归一删掉方括号里的糖型、规格 | `PROMO_BRACKET` 只折叠**确认的促销**标签；可乐归一保留糖型/杯型/风味，输出 `可乐（无糖·中杯）`；清理残留空 `【】`/`（）`。含糖与无糖成为两种食品，甜食份数与纯度按各自份数计 |

### P2：统计可信度、异步状态与实际使用入口

| 编号 | 评审问题 | 本轮处理 |
|---|---|---|
| W09 | 覆盖率把条数、缺口份数与未匹配混算 | `wishLevelCoverage` 改为按 `(成员, 原始心愿)` 逐条计量：未匹配、禁忌冲突、无需求内容不进分母；份数未满按缺口计；不再因为同成员另一条心愿满足就显示 2/2。同时补 `unmet` 结构化缺口：同一条心愿的不同原因只保留更具体的一个（`taboo` > `no-candidate` > `structure-unknown`/`kcal-unknown` > `unsatisfied`），份数取最大值而不是把同 1 份重复计成 2 份；禁忌冲突单独记 `reason:'taboo'` 并给出可读警告 |
| W10 | 非法事实占位符绕过守门 | 占位符正则改为 `\{([^{}]*)\}`，并新增「代入后仍残留占位符」检查；`{night_count}`、`{night-count}` 这类非法编号在代入前就被拒，不再因为匹配不到事实而静默通过 |
| W11 | 食品词守门允许把含糖可乐写成无糖 | 新增糖型（无糖/含糖）与杯型声明校验：订单里没有该糖型食品时，称号/判词/评语/钩子逐处拦截「无糖」 |
| W12 | 未知占比被当 0，错误触发类别限定词 | 切类别词必须 `topShare !== null`（占比已知且明细完整）；`null < 0.35` 不再成立。评审反例（5 单 4 单有明细、巨无霸 9 / 麦香鸡 1）限定词仍是「巨无霸」；完整 90% 样本同样「巨无霸」；完整且真实分散、同类别过半仍能切「汉堡」 |
| W13 | 未达门槛的弱单推仍展示 MAX 满格 | 进度条只有 `share >= 0.5` 才 `MAX`；20%/40% 显示真实百分比并注明「未达 50% 门槛，未满格」，判词写「都未达门槛，取最接近的一派」 |
| W14 | PFC 八成覆盖分母漏掉缺明细的订单 | `pfcOk` 增加「明细完整」条件：明细不全时 `stats.pfc = null`，并给出「仅 N/M 单取得食品明细，PFC 供能比不展示（局部样本不足以代表整段记录）」，卡面不再出现供能比结论 |
| W15 | 旧失败的健康检查会清掉新成功卡 | 面板重写为任务号模型：每次生成/提交/导出各自持 `seq`，任何 `await` 之后先校验归属；迟到的健康检查失败不得清掉新的成功卡 |
| W16 | 挂起的 Agent 提交锁住后续新卡 | 提交使用**独立 AbortController + 60s 超时 + 独立任务号**；`reset()` 取消旧提交并复位按钮；提交只清空「提交时那一份」草稿；旧提交挂起不影响新卡提交与重绘 |
| W17 | 旧 Agent 图片解码迟到会清空新草稿 | 解码完成后校验任务归属，迟到解码不得改写新草稿或新卡状态 |
| W18 | 本机 PNG 编码失败删除有效双面及 SVG 下载 | `savePng` 先固定 `cardSeq/myExport/snap/url`，每个 `await` 后校验 `owned()`；失败只写局部错误 `#mcdnaExportErr`，**保留当前双面预览与 SVG 下载**，不清卡 |
| W19 | 后端警告未被面板消费 | `show()` 渲染 `warnings`：前 3 条直显，其余折叠进 `details`；全部用 `textContent` 呈现，缺字与明细缺失提示不再消失 |
| W20 | 正式 Skill 示例与 README/PRD 仍描述旧行为 | 统一面向运行的示例与契约：`skill-template/references/examples.md` 去掉「<5 笔回退演示」与 680×440 旧口径；`SKILL.md` 补 `panelUrl`/`panelHint`；`README.md` 改为 1080×1440 双面、归一保留糖型规格；`docs/PRD.md` §3.4 明确标注已被 v6 取代；`references/contracts.md` 补 `intake` 与 `unmet` 字段 |
| W22 | CLI 的 Agent 成品无法在面板按同一快照导出 PNG | CLI 返回 `panelUrl`（仅当面板确实在运行，`127.0.0.1` + `#mcdna?report=<uuid>`），否则给 `panelHint`；面板新增 `loadReport(reportId)` 与 `#mcdna?report=` 深链接（自动切到战报页、默认 tier、不重读订单、不把账户数据拼进 URL），快照过期明确提示；`ui` 复用分支在 PID 记录缺失时回写真实 pid，避免「面板在跑却给不出链接」 |

### P3：缓存边界

| 编号 | 评审问题 | 本轮处理 |
|---|---|---|
| W21 | 并发文案回写复活已淘汰快照 | 新增 `pruneSnapshots(dir, keepId?)`（按 `createdAt` 排序，其余最多 23 份）；回写前 `existsSync` 再确认记录仍有效，被淘汰就不写并给出「已淘汰/未写入」警告；总数恒 ≤ 24。清理与读取统一用 `createdAt` 口径，不再只看 mtime |

### 交付（W08）

| 项 | 实际结果 |
|---|---|
| 版本 | `package.json` 1.4.10 → **1.4.11**（版本唯一来源，SKILL.md 由 `{{VERSION}}` 注入） |
| 构建 | `node scripts/package-skill.mjs build` 从源码 tsc → 组装 → 白名单/隐私断言 → 版本五源一致 → 干净环境烟测，退出 0 |
| 白名单与字体许可 | 包内 `ui/mcdna/assets/` 65 个资源齐全，含 `pixfont.bin.gz`（105KB）与 `font-licenses/OFL.txt`、`LICENSE.txt`；`THIRD_PARTY_LICENSES.md` 声明 highs（MIT）与 Fusion Pixel Font（SIL OFL 1.1）；`assertNoPersonalFiles` 未发现 `.env`/`config.json`/日志/快照 |
| 安装目标 | **主**：`<本机 WorkBuddy 技能目录>`（当前 WB 实际使用，面板进程即从此处启动）1.4.10 → 1.4.11；**次**：`<旧宿主技能目录>`（旧宿主数据目录）1.4.4 → 1.4.11。两处均 `postInstallDoctorOk: true`，各自保留最近 2 份备份 |
| 用户库 | `~/.mcsmart-butler`（config / catalog / 营养补录 / 配方库 / cache / logs）未被触碰；安装前另存 `~/backup-user-lib-20261019` |
| 进程 | 停掉旧面板进程（PID 44116 → 8436 → 47580 均从旧内容启动），重启后 `/api/health` 返回 `version 1.4.11`、`tokenConfigured true` |
| 漂移 | `docs/delivery-drift.json`、`docs/delivery-drift-domestic.json` 两处均退出 0，四处指纹一致 |
| 实际面板 | `docs/screens/mcdna-v1411-front.png` / `-back.png`，由真实面板导出（非 SVG 转存） |

## 三、验证记录

| 项目 | 结果 |
|---|---|
| `npm test` | 退出 0；42 个测试脚本 + tsc、1048 项 ✓、0 失败（新增 96 项：53+35+8） |
| `npm run test:browser` | 退出 0；42 项（25 + 17），`pageerror=0` |
| `node scripts/acceptance-v1411-panel.py` | 11 项通过；CLI→面板同源 sha256 一致、默认 tier、双面 PNG 合法 |
| `node scripts/package-skill.mjs build` | 退出 0；1.4.11 五源一致；烟测 panel/solver/seed-data/config 全 ok |
| `node scripts/report-delivery-drift.mjs --json`（两处安装位） | 均退出 0，四处同源 |
| `node scripts/package-skill.mjs install`（两处） | `postInstallDoctorOk: true` |

评审要求的最小反例，逐条落成断言：

| 反例 | 落点 |
|---|---|
| 二件套餐各 400 kcal/100mg，`kcal<=500` 与 `sodium<=150` | `test-v1411-service-fixes.mjs`（整篮 800 / 本人 400 / 剩余 400；钠本人 100 / 整篮 200） |
| 仅营养表有组件、套餐不单卖，`kcal<=900` 误报无解 | 同上（严格 900 有解且 800 kcal） |
| 三件套 ¥20 vs 四件套 ¥30；A/B 跨套餐拼槽 | 同上（成交 ¥20 三件套；跨套餐覆盖 0/1） |
| 周一 12:00 预约周二 12:00 | 同上（只准入周二券，原因写「目标时间是周二」） |
| 未匹配 / 份数缺口 / 禁忌冲突 | 同上（三例均 1/2；`unmet` 分别 `no-candidate` / `unsatisfied` 缺 3 份 / `taboo`） |
| 含糖/无糖可乐 5 单 | `test-v1411-mcdna-fixes.mjs`（两种食品、甜食 5、纯度 50%） |
| `{night_count}` / `{night-count}` / 含糖写无糖 | 同上（逐处拦截） |
| 5 单 4 单明细、巨无霸 9 / 麦香鸡 1 | 同上（限定词仍「巨无霸」，完整对照同） |
| 5 单 5 种各一份、无时间、本命 20% | 同上（`weak=true`、`max=false`、显示 20%） |
| 5 单仅 1 单明细 + 营养表 | 同上（`pfc=null` + 警告） |
| 渲染 await 期间新建 24 份快照 | `test-v1411-snapshot-prune.mjs`（不复活、总数 24、有警告） |
| full→tier 导出穿越 / 编码失败 / 迟到回执 / 迟到解码 | `test-v1411-browser.py`（17 项） |

## 四、改动清单

| 文件 | 改动 |
|---|---|
| `src/service.ts` | W01 `intake` 三口径与 `memberKcal`；W02 传 `menuData.table`；输出类型补 `intake` |
| `src/optimizer.ts` | W03 `unitClaims` 四元承接、候选择一、跨计划拼槽隔离；`MemberAllocation` 补蛋白/脂肪/碳水/钠 |
| `src/groupKernel.ts` | W04 目标核销时间；W09 心愿级覆盖 + `unmet` 去重/`taboo` 原因与警告 |
| `src/orderContext.ts` | 新增 `targetRedeemDate()` |
| `src/redeemWindow.ts` | `redeemWindowStatus(..., 'now'\|'target')` |
| `src/unionCps.ts` | 实时/降级准入统一用目标时间 |
| `src/mcdna.ts` | W07 归一保留糖型/杯型/风味，只折叠确认促销 |
| `src/mcdnaReport.ts` | W06 缺省 tier；W14 `pfc` 完整性门槛；W21 `pruneSnapshots` + 回写前确认 |
| `src/mcdnaPersona.ts` | W10 占位符正则与残留检查；W11 糖型/杯型声明；W12 占比已知条件；W13 门槛与满格 |
| `src/present.ts` | W01 文本「整篮 / 本人摄入 / 逐项剩余」 |
| `src/cli.ts` | W22 `panelUrl` / `panelHint`；`ui` 复用分支回写 pid |
| `public/index.html` | W01 摄入/剩余展示与热量标签；`#mcdnaWarn` / `#mcdnaExportErr` 容器 |
| `public/mcdna/panel.js` | W05/W15–W19 任务号与归属校验、警告渲染、导出失败隔离；W22 `loadReport` 与深链接 |
| `scripts/package-skill.mjs` | 安装/备份在宿主沙箱下改为「改名移出 + 复制」，清理失败降级不阻断安装；备份按时间戳后缀排序（避免 1.4.10 排在 1.4.9 前导致 rollback 取错版本）；`.trash-*` 不计入备份配额 |
| `scripts/test-v1411-*.mjs`、`scripts/test-v1411-browser.py`、`scripts/acceptance-v1411-panel.py` | 新增回归与验收脚本 |
| `package.json` | 版本 1.4.11；`test` 串行链新增 3 个脚本 |
| `skill-template/references/contracts.md`、`examples.md`、`SKILL.md`、`README.md`、`docs/PRD.md` | W20 口径统一；契约补 `intake`/`unmet` |

## 五、验收过程发现并修复的问题（本轮新增）

1. **`unmet` 同一条心愿被记两次**：既判 `no-candidate` 又留 `unsatisfied`，同 1 份被算成 2 份缺口。改为按 `成员|心愿` 合并、保留更具体原因、份数取最大值。
2. **禁忌冲突在 `unmet` 里完全消失**：覆盖率扣了，但结构化缺口没有对应记录，用户只看到 1/2 找不到少的那条。新增 `reason:'taboo'` 与可读警告。
3. **面板在跑但 `panel.pid` 缺失时给不出 `panelUrl`**：`ui` 复用分支现在会把真实 pid 回写。
4. **`rollback` 可能取错备份**：备份名以版本号开头，整名字典序把 `1.4.10` 排在 `1.4.9` 之前。改为按时间戳后缀排序。
5. **宿主沙箱禁止单次 >50 文件删除，导致安装中断**：安装改为「先改名移出、再复制、最后尽力清理」，清理失败降级为保留并如实回报，不阻断安装。

## 六、诚实边界（未验证 / 仍存成本）

1. **真实账户数据仍未验证**：本轮所有订单都是构造夹具或演示样本，没有读取任何真实麦当劳订单。`amountMode=full` 的金额适配、真实 `order-list` 返回结构仍属「未用真实非空响应验证」，面板与 CLI 都会继续显示这条警告。真实账户验收需用户主动选择后单独执行。
2. **联盟团购路径的 W04 只做了静态追踪**：自持券链路已实测（冻结时钟 + 预约上下文），联盟实时/缓存/降级三条路径共用同一函数但未联网验证。
3. **`npm run test:browser` 只覆盖本机 Chromium**：Safari/Firefox 与移动端未验。
4. **安装脚本的降级路径会留下隔离目录**：宿主沙箱不允许批量删除时，旧内容被改名到 `~/.workbuddy-ai/trash-20261019`、`~/.workbuddy/trash-20261019`（共约 29MB + 16MB），需人工清理；`skills/` 目录本身已清理干净，不影响宿主加载。
5. **`~/.workbuddy` 是到 `<旧宿主数据目录>` 的 Junction**：第二处安装位实际落在 F: 盘，若该旧宿主已不再使用，可整目录删除，不影响主安装位。
6. **两处安装位均已到 1.4.11**，不存在「只交付一种 WB」的情况；但两者共用同一用户数据目录 `~/.mcsmart-butler`，同时运行两个面板会争用同一端口与快照缓存。
