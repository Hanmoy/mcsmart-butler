# 第三方组件、字体与来源说明

根目录 [LICENSE](LICENSE) 适用于项目原创代码。第三方组件、字体、品牌标识和来源数据各自遵循原权利人的许可或使用条件，不因本项目 MIT 声明而改变。

## HiGHS／highs-js

项目使用 `highs` 提供的 HiGHS WASM 优化器。源码依赖记录见 [package.json](package.json)，发布包由打包脚本复制运行所需文件。

以下为当前安装依赖中保留的许可原文：

~~~text
MIT License

Copyright (c) 2023 highs-js
Copyright (c) 2026 HiGHS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
~~~

## 像素字体

McDNA 使用随包像素字库，相关声明及上游许可文本保留在：

- [font-licenses/LICENSE.txt](public/mcdna/assets/font-licenses/LICENSE.txt)
- [font-licenses/OFL.txt](public/mcdna/assets/font-licenses/OFL.txt)

其中包含 SIL Open Font License 1.1 及上游组成字体的许可说明。派生字形数据随原许可文本一并保留；不得把全部字体重新概括为 MIT。具体作者、版权与条件以这两份原始文本为准。

## 视觉素材与品牌

McDNA 纸板场景、像素食品角色与道具为本项目使用的生成素材，由程序组合和排版；文字、统计数值和事实占位符由程序绘制。素材本身不构成真实餐品或真实消费记录的证明。

麦当劳名称、商标、产品名称及标识的相关权利归其权利人。本项目为独立参赛作品，不代表官方授权经营或官方产品。

## 数据与独立接入

- 官方菜单、套餐结构及订单通过用户授权的麦当劳 MCP 读取。
- 随包官网营养资料、城市字典及目录种子来源见 [data/README.md](data/README.md)，不按原创代码许可宣称取得来源数据所有权。
- 美团联盟客户端为项目独立接入。当前保留随包联盟凭据，来源记录为公开发布的 `meituan-assistant` 内置来源；该来源说明不等同于已经核实第三方授权或比赛资格。文档不列出其具体值，也不将其纳入 MIT 代码授权声明。
