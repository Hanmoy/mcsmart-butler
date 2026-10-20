# 参与贡献

感谢反馈和提交改进。提交 Issue 或 PR 前，请先确认：

1. 使用当前 `main` 复现，附 Node.js 版本、系统、运行命令和最小复现。**不要粘贴 Token、券码、订单、手机号、收货信息或完整本机路径。**
2. 先运行 `npm ci`、`npm run build`、`npm test`；涉及页面时再运行 `npm run test:browser`（需要 Python Playwright）。
3. 业务逻辑改动先改 `src/service.ts` 或其调用的确定性内核，不要在 `server.ts`、`cli.ts` 或 `SKILL.md` 里复制编排。
4. 新增或修改行为要有可重复的测试；测试数据放在隔离目录，不写入用户数据目录。
5. 不要提交新的 Token、密钥或账号配置。`data/union-credentials.json` 是项目所有者决定的随包第三方凭据，改动前请先开 Issue 讨论。
6. 提交信息用简洁的祈使句；PR 描述写清“改了什么、为什么、怎么验证、未验证什么”。

## 开发命令

~~~powershell
npm.cmd ci
npm.cmd run build
npm.cmd test
npm.cmd run test:browser
npm.cmd run package -- --zip
~~~

浏览器回归会明确报告“跳过”还是“通过”；跳过不等于通过。CI 中设置 `MCSMART_REQUIRE_BROWSER=1` 时，找不到 Playwright 会直接失败。

## 代码与数据边界

- 面板只监听本机，不新增公网服务、代下单或代付能力。
- 缺失营养不当作 0；估算与未知字段必须保留标记。
- 团购券内容核验、价格候选和最终推荐是三种状态，不能互相冒充。
- 新增数据文件时说明来源、抓取日期和适用范围；不要把个人订单或账号数据带进仓库。

## 许可证

提交的原创代码按 [MIT License](LICENSE) 授权；第三方组件和字体遵循各自许可，见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。
