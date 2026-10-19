# 整页移植清单（full-page port）

把第三方皮肤项目的整套界面风格移植为 WorkBuddy 主题时的覆盖清单与踩坑记录。
参考实例：内置的 **QQ 2008**（`themes/qq2008`，1169 行）、**腾讯云 TDP**（`themes/tdp-pro`，
1320 行）、**Sky Clock**（`themes/sky-clock`，CSS 仅 11 个选择器、以伴随 js 驱动明暗）。

## 为什么不抽运行时基座

QQ 2008 与 TDP 的选择器高度重合（242/281 个中 205 个相同）——整页移植覆盖的是同一套
DOM 组件；但**声明几乎条条不同**（逐字节相同的只有个位数），两者是独立设计。抽共享
基座会把两个主题耦合进同一文件（改 QQ 的重置误伤 TDP），Sky Clock 与两者近乎零重合
也证明没有稳定公共层。因此公共知识沉淀为本文档（静态参考，不进运行时），而非共享 CSS。

## 主题形态速查

| 形态 | 字段 | 适用 |
| --- | --- | --- |
| 图片主题 | `hero`（+`poster`） | 一张壁纸 + 四色，模板生成全部 CSS |
| 配色主题 | `group:"palette"` + `signature` | 无图纯配色，装饰层数据化（见 README「配色主题签名」） |
| **整页移植** | `css`（+可选 `js`/`dynamicMode`） | 本文档：CSS 即皮肤本体，手写全覆盖 |

整页移植的 `theme.json` 最小形态：`css` 替代 `hero`，`group` 缺省即 `"custom"`；
`colors.accent`/`colors.surface` 仍必填（菜单圆点、明暗模式钉住、CSS 内 `body.dark`
作用域激活都读它）。

## DOM 覆盖清单

按 QQ 2008 ∩ TDP 的 205 个共享选择器归组（数量为该组共享选择器数，括号内为代表锚点；
两边实现细节各异，逐区域对照两份 skin.css 取舍）：

1. **重置层（71）**：`html`/`body`/`textarea`/`select`/`span`/`p` 等原生元素的字体、
   颜色、背景重置。移植源的全局重置通常最脏，逐条评估是否保留
2. **按钮（27）**：`button`、`.conversation-list-tab-button(-box)`（含 `:hover`/`.active`）
3. **壳层/容器（25）**：`#root`、`.teams-container.is-mac/.is-windows`、
   `.teams-main-content`、`[data-view-id]`——决定壁纸/底图如何透出
4. **顶栏/标签（19）**：`.conversation-list-header/-tabs/-tab-row`、`.wb-scene-tabs`
5. **输入框（18）**：`input`、`[contenteditable]`、`.monaco-editor`、`.wb-home-composer`
6. **弹层/菜单（17）**：`.user-menu-trigger--workbuddy` 系列、下拉/气泡卡片
7. **首页头部/字标（12）**：`.wb-home-header__title`、`.conversation-list-logo`、
   `.colleague-chat-empty-profile__title`
8. **侧边栏（6）**：`.teams-container [data-view-id="sidebar"]`、`.conversation-sidebar`
   （含 `body.dark` 变体）
9. **头像/成员（6）**：`.colleague-chat-empty-profile__avatar`、建议列表项
10. **滚动条（4）**：`::-webkit-scrollbar(-track/-thumb)`（含 dark 变体）

两主题各自还有数十个独有选择器（QQ 2008 37 个、TDP 76 个）——吉祥物挂件、音效按钮、
宇航员动效层这类主题个性层，不在清单覆盖义务内。

## 移植流程

1. **建目录**：`themes/<id>/`，`theme.json` 写 `css: "skin.css"`、`colors` 四色、
   `thumbnail`（纯 CSS 主题无 hero 可取，封面靠它；≤512KB 建议 640×400 WebP）
2. **筛源 CSS**：移植源的样式表面向它那个版本的 DOM。本仓已知更名：旧
   `.cb-assistant-message`/`.wb-home-composer` 等类名在当前版本已对不上——先按上面
   清单对当前 DOM 锚点逐区域重写，直注会大面积失配
3. **资源内联**：CSS 里 `url("./asset")` 相对引用注入时自动转 data URL（资源必须在
   主题目录内）；`data:`/绝对 URL 原样保留
4. **明暗策略**：默认由菜单按 `colors.surface` 亮度钉住明暗（CSS 里写 `body.dark`
   作用域适配两套）；若要按时间等外部条件动态切换，配 `js` + `dynamicMode: true`
   （参考 Sky Clock，写法与菜单 `writeMode` 同构）
5. **伴随 js（可选）**：CSS 做不到的 DOM 注入/交互——TDP 的宇航员动效层、QQ 2008 的
   音效（消息/失败/敲门，复用 `WORKBUDDY_THEME_SOUND_ENABLED`/`VOLUME` 设置键，
   1200ms 节流）与企鹅挂件。作为函数体执行，返回值是函数则作拆除回调
6. **mascot（可选）**：替换「成长伙伴」机器人形象（≤256KB 透明底 WebP，
   配 `mascotScale`/`mascotOffset` 微调）
7. **标语（可选）**：`copy.tagline` 由注入器自动追加通用标语块；若 skin.css 自带
   `.wb-home-header::after`（如 TDP 的硬编码渐变标语），注入器检测到后自动跳过

## 坑与护栏（已踩过的雷）

- **body / `body::before` / `body::after` 上禁挂 transition/animation**：一次变更会
  演变成几十帧整屏重绘（Sky Clock 实测抽丝刷屏的根因）。局部元素的动画不受限
- **含 `infinite` 动画必须配 `@media prefers-reduced-motion` 降级**：系统开减弱动效时
  无保护的永久动画不会停（TDP 曾有 7 条 infinite 无任何保护）
- **大 hero 图走 blob**：内置大 hero 背景直注会在 Blink 下丢背景，走 IndexedDB/blob
  链路（见 commit f160e96）
- **`!important` 与层叠顺序**：皮肤 CSS 与基座/原生样式同优先级时靠后书写胜出；
  装饰层、晕染层都依赖这个顺序，插入新规则时确认落点
- **tdp-pro / tdp-pro-dark 孪生**：7 个共享文件逐字节一致由测试钉住，改一份必须
  同步另一份（长期方案是 schema 层的 baseTheme 继承，另行处理）

## 落地后的自动兜底

以下测试对新增主题自动生效，无需为新主题写测试：

- `test/bundled-themes.test.mjs`：全量 `loadTheme` 校验（id 与目录名一致、资源存在、
  体积上限）、上面两条 skin.css lint、孪生主题哈希
- `node --test`（即 `npm test`）全量绿即可交付；`node src/cli.mjs apply --theme <id>`
  实机目测注入效果
