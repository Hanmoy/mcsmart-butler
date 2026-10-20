# 文档索引

本目录只保留 README 使用的演示资源与 GitHub Pages 静态 Demo；完整开发过程、历史修复报告和本地工作目录不随仓库分发。

- `demo/`：静态只读演示，入口 `demo/index.html`。复用真实面板，只替换 `/api` 为内置模拟回执；不连接账户、不查实时价格、不下单。
- `screens/`：README 使用的截图、GIF 与 McDNA 演示图；均为演示数据或未配置 Token 的界面。
- `../scripts/demo-fixtures.mjs`：用真实 service + 离线菜单生成演示回执（输出到 `docs/demo/fixtures/`，该中间目录不随公开仓库分发）。
- `../scripts/build-static-demo.mjs`：从 `public/index.html` 生成 `docs/demo/index.html`。
- `../scripts/test-static-demo.py`：不启动后端的静态 Demo 冒烟测试。
- `../scripts/demo-gif.py`：录制 README GIF，输出到 `docs/screens/`。

静态 Demo 的页面内容由脚本生成，不要手改 `docs/demo/index.html`；修改 `public/index.html` 或演示回执后重新运行构建脚本。
