# Agent Note：桌面端载荷品牌微调

状态：已实现

[English](2026-09-12-desktop-payload-brand-tweaks.md) | 中文

## 问题

从源码构建出的载荷自称 "DSH Local Build"。侧边栏品牌行的标签取自 `@deepseek-ai/dsh-client-locale` 的 `brand.localBuild` 词条，而该行有两种互斥的渲染方式：当 `localBuildVersion()` 有值时——源码构建恒为此情形——名称被压进 12px 的 `localBuildTitle` 规则，下方在固定 24px 盒子里叠一个 6px 的 `buildVersion` 徽章；只有发布构建（其 `localBuildVersion()` 编译为 `undefined`）才拿到完整的 17px `fallbackBrandName`。因此每个本地构建的载荷都会呈现一个明显缩水、且标签错误的品牌行。

名称与尺寸都没有配置接缝：文案编译进 locale 包的字典，尺寸则存在于侧边栏包内按构建哈希的 CSS module 规则里（`cguSKG_`、`ViNb6q_`…… 前缀每次构建都会变）。桌面应用是该部署形态下的产品界面，其品牌行必须读作产品名，并达到发布级的可读性。

## 决策

`apps/desktop/src/payload-builder.ts` 中的 `applyBrandTweaks` 在载荷组装完成后改写其中两个客户端包：时机在 deploy 闭包落地之后、启动冒烟之前，从而让冒烟校验的就是最终交付物。它执行两项彼此独立的改写，各自尽力而为：

- **名称。** `retitleBrandName` 把 zh 与 en 两份 `brand.localBuild` 词条的取值改写为 `DeepSeek Harness`。只替换取值，以 `("brand\.localBuild"\s*:\s*")[^"]*(")` 匹配，因此键名、其引号形式以及相邻每一条词条都原样保留。两份字典都要改，因为该键是共享的：除侧边栏外，`@deepseek-ai/dsh-client-ui-layout` 也读取它。
- **字号。** `resizeBrandRow` 把 `localBuildTitle` 从 12px/13px 提到发布路径所用的 17px/18px，并把版本徽章放大到 10px 字号，底色改为 DeepSeek 品牌蓝（`--dsw-static-deepseek-450`）、文字白色，取代原先的中性反色填充。徽章自身的盒子、`border-radius` 与 `padding` 随字号一同增长；承载标题的行（`localBuildBrand`、`brandIdentity`、`brandName`）从 24px 增至 33px，因为 24px 恰好容纳 13 + 1 + 10，否则 `logoRow` 的 `overflow:hidden` 会裁掉变高的标题。

所有模式只匹配类名中的 `_后缀` 部分，从不匹配哈希前缀；每条声明模式都以 `(^|;)` 锚定，使 `height:` 不会命中 `line-height:` 内部。改写是就地替换声明，而非整条规则：属性顺序归上游所有，且上游可能追加更多属性。

徽章按上游的两种变体分别调整。源码构建渲染 6px/10px 的 `buildVersion` 徽章，发布构建渲染 8px/16px 的 `buildRevision` 徽章。两者都放大到 10px 字号，但只有源码构建那一枚的盒子随之变大——发布徽章的 16px 盒子本就容得下 10px 字，把它压到 14px 反而是倒退。行高的增长遵循同一条规则：只有堆叠布局才需要超出原盒子，因为只有那里徽章叠在标题下方，而非并排于其侧。

两项改写在设计上都是纯外观、尽力而为。若上游重构了标记结构或挪走了文案，模式不会命中，载荷保持构建时的原样，并留下一条日志。为字号让一次更新失败是不划算的交易。

## 备选方案

- **通过 `sidebar.brand.name` 插槽组合该行。** 侧边栏包提供了 `renderSlot("sidebar.brand.name", {}, { fallback })`，浏览器侧插件可以占位。但这意味着为改动一个外观默认值而专门编写并向部署中投放一个客户端插件，而它要替换的 fallback 恰恰就是本文讨论的这一行；载荷补丁更小，且无需新增包。对于想要的不止名称与徽章的部署，占位插槽是更好的路线。
- **通过 locale 服务声明标签。** 字典随载荷一同发布，且与 layout 包共享；没有任何机制为单个键暴露部署级覆盖。
- **走上发布分支，把 `localBuildVersion` 定义为 undefined。** 这样能得到全尺寸的 `fallbackBrandName`，但同时丢掉了载荷有意展示的版本徽章，且依赖的是内部符号而非标记结构。
- **保持上游发来的品牌原样。** 否决：产品界面会一直自称本地构建。

## 后果

桌面端载荷现在以发布级字号呈现产品名，并带有清晰、带品牌色的版本徽章；微调在每次更新时自动重新施加——不再需要在每次上游变更后手工重打，而这正是先前的做法。

代价在于：该补丁用正则读写两个第三方包，因此与上游的类名后缀、`brand.localBuild` 键以及徽章的声明清单相耦合。其中任何一项变动都会让微调退化为静默空操作——绝不会导致构建失败——唯一的信号就是那条日志。测试覆盖了当前标记结构的两种徽章变体、哈希前缀无关性、幂等性以及空操作路径；它们无法覆盖未来的上游重构。

## 验证

- `apps/desktop/tests/payload-brand.spec.ts` 覆盖两份字典、两种徽章变体、哈希前缀无关性、幂等性、`fallbackBrandName` 不被误匹配，以及包缺失与模式失配两条空操作路径。
- 测试 fixture 取的是上游自身的输出，读取自本次改写存在之前组装的载荷。已打补丁的载荷呈现的是本补丁的结果，无法用它钉住输入的起点。
- 在真实载荷上复现：对已组装的载荷根目录运行 `applyBrandTweaks`，检查 `runtime/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js` 与 `…/dsh-client-ui-sidebar/lib/client.js`。若要确认运行中的后端真正吐出的内容（而非磁盘上的字节），请求 GUI manifest 里的 `/plugins/??…&rev=` 包，直接从中读取规则。
