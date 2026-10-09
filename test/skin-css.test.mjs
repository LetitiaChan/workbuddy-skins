import assert from "node:assert/strict";
import test from "node:test";

import { buildMascotCss, buildPaletteCss, buildSkinCss, buildTaglineCss } from "../src/skin-css.mjs";

const HERO = "data:image/webp;base64,aGVsbG8=";
const baseTheme = {
  id: "demo",
  name: "Demo",
  colors: { accent: "#5141F2", secondary: "#7C3AED", surface: "#F5F6F8", text: "#111827" },
  copy: null,
};

test("标题样式：主标题走 accent→secondary 渐变文字，自适应反差光晕保证繁忙壁纸可读性", () => {
  const css = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  assert.ok(css.includes(".wb-home-header__title"));
  assert.ok(css.includes(".colleague-chat-empty-profile__title"));
  assert.ok(css.includes("linear-gradient(135deg, var(--wb-accent), var(--wb-secondary))"));
  assert.ok(css.includes("-webkit-text-fill-color: transparent"));
  // 贴纸式实心轮廓：4 正方向 0 模糊 drop-shadow 勾出 1px 实边（级联自动补齐对角，
  // 8 方向会级联膨胀到 3 倍半径）+ 低透明软晕托底；清掉原生 text-shadow 防重影——
  // 透明渐变填充上唯一不透字形发脏的勾边方案（text-shadow 透字形、text-stroke 吃边缘、
  // 纯模糊光晕无边界在繁忙壁纸上糊成一片，六主题实测）；轮廓色 --wb-halo 随渐变亮度
  // 自适应黑/白，全 var() 引用，自定义皮肤哨兵替换后仍按真实取色计算
  const titleBlock = css.slice(css.indexOf(".wb-home-header__title"), css.indexOf("}", css.indexOf(".wb-home-header__title")));
  assert.ok(titleBlock.includes("drop-shadow(1px 0 0 var(--wb-halo))"));
  assert.ok(titleBlock.includes("drop-shadow(0 -1px 0 var(--wb-halo))"));
  assert.ok(titleBlock.includes("text-shadow: none !important"));
  assert.ok(titleBlock.includes("color-mix(in srgb, var(--wb-halo) 35%, transparent)"));
  assert.ok(!titleBlock.includes("-webkit-text-stroke"), "描边方案已废弃，不应再含 text-stroke");
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(titleBlock), "轮廓色不应硬编码色值");
  // --wb-halo 定义：oklch 相对色语法取渐变中点亮度自适应黑/白
  assert.ok(css.includes("--wb-halo: oklch(from color-mix(in oklch, var(--wb-accent), var(--wb-secondary))"));
});

test("主题标语：copy.tagline 配置时输出渐变标语，未配置时不注入文案", () => {
  const withTagline = buildSkinCss({
    theme: { ...baseTheme, copy: { tagline: "与开发者共鸣" } },
    heroDataUrl: HERO,
  });
  assert.ok(withTagline.includes(".wb-home-header::after"));
  assert.ok(withTagline.includes('content: "与开发者共鸣" !important'));

  const without = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  assert.ok(!without.includes(".wb-home-header::after"));
});

test("主题标语：buildTaglineCss 独立可渲染，无 --wb-* 变量时回退 colors 字面色值", () => {
  const css = buildTaglineCss({ ...baseTheme, copy: { tagline: "极光漫卷" } });
  assert.ok(css.includes(".wb-home-header::after"));
  assert.ok(css.includes('content: "极光漫卷" !important'));
  // 渐变与轮廓均带字面色值回退：风景/定制 CSS 主题不经 --wb-* 变量基座也能独立渲染
  assert.ok(css.includes("var(--wb-accent, #5141F2)"));
  assert.ok(css.includes("var(--wb-secondary, #7C3AED)"));
  assert.ok(css.includes("var(--wb-halo, oklch(from color-mix(in oklch, #5141F2, #7C3AED)"));
  // 未配置 tagline 返回空串
  assert.equal(buildTaglineCss(baseTheme), "");
});

test("标题渐变引用 CSS 变量而非字面色值：自定义皮肤哨兵替换后自动适配取色", () => {
  const css = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  const titleBlock = css.slice(css.indexOf(".wb-home-header__title"));
  assert.ok(!titleBlock.includes("#5141F2"), "标题渐变不应硬编码色值");
});

test("左上角字标：硬切渐变双色字标（Work 文本色 / Buddy accent），全 var() 引用", () => {
  const css = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  assert.ok(css.includes(".conversation-list-logo .logo-workbuddy-title"));
  assert.ok(css.includes("linear-gradient(90deg, var(--wb-text) 0 44%, var(--wb-accent) 44% 100%)"));
  const logoBlock = css.slice(css.indexOf(".conversation-list-logo .logo-workbuddy-title"));
  assert.ok(!/#[0-9a-f]{6}/i.test(logoBlock), "字标不应硬编码色值（哨兵替换覆盖不到 data URL 编码色值）");
});

test("会话/详情页壁纸降噪：chat 页标记时 #root 叠 50% 表面色纱罩，home/无标记不受影响", () => {
  const css = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  // hero 全 CSS 只内联一次（--wb-hero 声明），普通/chat 规则均经 var() 引用——
  // hero 普遍数百 KB，重复内联会让每条主题 CSS（65+ 主题合入菜单 payload）体积翻倍
  assert.equal(css.split(HERO).length - 1, 1, "hero data URL 应只出现一次");
  assert.ok(css.includes(`--wb-hero: url(${JSON.stringify(HERO)});`));
  // chat 页规则存在且含纱罩层（首层在最上），hero 经 var(--wb-hero) 在底层保留
  const marker = 'body[data-wb-skin-page="chat"] #root {';
  assert.ok(css.includes(marker));
  const chatBlock = css.slice(css.indexOf(marker), css.indexOf("}", css.indexOf(marker)));
  assert.ok(chatBlock.includes("color-mix(in srgb, var(--wb-surface) 50%, transparent)"));
  assert.ok(chatBlock.includes("var(--wb-hero)"), "纱罩下应保留 hero 底图（透出隐约底色）");
  // 全 var() 引用：自定义皮肤哨兵替换后自动适配取色
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(chatBlock), "纱罩不应硬编码色值");
  // 规则带页面属性限定，默认（home/无标记）不匹配——buildPaletteCss 无壁纸不应携带
  const palette = buildPaletteCss({ theme: baseTheme });
  assert.ok(!palette.includes("data-wb-skin-page"), "配色主题无壁纸，不应输出 chat 降噪规则");
});

test("详情面板内部透化：文件预览/Monaco 编辑器白底透明，由壳层磨砂托底", () => {
  const css = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  // 壳层磨砂同时覆盖 detail-panel 与自动化产物面板（artifact-panel 复用 detail-* 同族组件）
  assert.ok(css.includes("[data-view-id=detail-panel],\n[class*=artifact-panel] {"));
  // 内层组件、整版包裹层 .detail-layout（读 --cb-bg-primary 成主题表面色实底）、
  // 代码预览容器（哈希类子串匹配）、块编辑器与 Monaco 各背景层全部透化
  // （CDP 实测原生均为不透明 rgb(255,255,255)），作用域为 :is(双宿主)
  const host = ":is([data-view-id=detail-panel], [class*=artifact-panel])";
  assert.ok(css.includes(host + " .detail-panel,"));
  assert.ok(css.includes(host + " .detail-panel-container,"));
  assert.ok(css.includes(host + " .detail-layout {"), ".detail-layout 整版包裹层应透化，否则主题表面色实底盖住壁纸");
  assert.ok(css.includes(host + " .detail-main__body,"));
  assert.ok(css.includes(host + " [class*=codePreviewContainer],"));
  assert.ok(css.includes(host + " .sc-editor,"));
  assert.ok(css.includes(host + " .monaco-editor,"));
  assert.ok(css.includes(host + " .monaco-editor .margin,"));
  assert.ok(css.includes(host + " .monaco-editor .minimap"));
  // md/文件预览：容器透化，代码块/表格 40% 表面色浮层（保边界辨识度）
  assert.ok(css.includes(host + " .file-viewer,"));
  assert.ok(css.includes(host + " .detail-new-tab-landing"));
  assert.ok(css.includes(host + " .cb-markdown-pre,"));
  assert.ok(css.includes(host + " .file-viewer table"));
  // 配色主题同块生效：根层实底 surface，透明后颜色一致（不回归）
  const palette = buildPaletteCss({ theme: baseTheme });
  assert.ok(palette.includes(host + " .monaco-editor-background,"));
  assert.ok(palette.includes(host + " .detail-layout {"), "共享块同源，配色主题 .detail-layout 同步透化");
});

test("「为你推荐」技能推荐条：原生不透明白条改为磨砂半透明，全 var() 引用", () => {
  const css = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  // 条本体 + 上方 32px 渐变托底（::before）必须覆盖，否则壁纸上呈整块白版
  assert.ok(css.includes(".wb-skill-rec-bar {"));
  assert.ok(css.includes(".wb-skill-rec-bar::before"));
  assert.ok(css.includes(".wb-skill-rec-bar__label"));
  assert.ok(css.includes(".wb-skill-rec-chip"));
  const barBlock = css.slice(css.indexOf(".wb-skill-rec-bar {"), css.indexOf("/* 首页快捷 chips"));
  assert.ok(barBlock.includes("color-mix(in srgb, var(--wb-surface) 55%, transparent) !important"));
  assert.ok(barBlock.includes("backdrop-filter: blur(14px)"));
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(barBlock), "推荐条规则不应硬编码色值");
});

test("首页快捷 chips 与滚动渐隐：白底/白色渐变改为皮肤表面色磨砂", () => {
  const css = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  assert.ok(css.includes(".wb-home-composer__chips .quick-actions__item"));
  assert.ok(css.includes(".wb-home-composer__chip"));
  assert.ok(css.includes(".quick-actions--fade-right::after"));
  assert.ok(css.includes(".quick-actions--fade-left::before"));
  assert.ok(css.includes(".quick-actions__arrow"));
  // 渐隐不再用硬编码 #fff，改走 surface 半透明渐变
  const fadeBlock = css.slice(css.indexOf(".quick-actions--fade-right::after"));
  assert.ok(!fadeBlock.includes("#fff"), "滚动渐隐不应硬编码白色");
});

test("侧栏一级树行：透化常驻实底块、悬停走文字色洗底，图片/配色主题共用", () => {
  for (const css of [buildSkinCss({ theme: baseTheme, heroDataUrl: HERO }), buildPaletteCss({ theme: baseTheme })]) {
    const header = 'body[data-application-name=workbuddy] .conversation-section-content [class*="collapsibleSection"] > [class*="header"] {\n  background: transparent !important;';
    const hover = 'body[data-application-name=workbuddy] .conversation-section-content [class*="collapsibleSection"] > [class*="headerClickable"]:hover {\n  background: var(--wb-todo-menu-bg-hover) !important;';
    assert.ok(css.includes(header), "一级树行常态应透明（原生钉 --wb-sidebar-bg 实底，磨砂侧栏上成浅色块）");
    assert.ok(css.includes(hover), "一级树行悬停应为文字色洗底");
  }
});

test("助理页工作区与列表抽屉：claw-workspace 透化，claw-sidebar-drawer 随主题类型磨砂/浮层", () => {
  const block = (css, selector) => css.slice(css.indexOf(selector + " {"), css.indexOf("}", css.indexOf(selector + " {")) + 1);
  // 图片主题：.claw-workspace 原生 rgb(31,31,31) 实底整版盖住 #root 壁纸，透化即可——
  // 底部可读性渐变由外层 main-content 提供，chat 页文字可读性由 50% 纱罩托底
  const image = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  assert.ok(image.includes(".claw-workspace {\n  background: transparent !important;\n}"));
  // aside.claw-sidebar-drawer 原生 rgb(41,41,41) 实底块：与主侧栏同一磨砂语言，
  // 强度/模糊参数须与 [data-view-id=sidebar] 逐行对齐（78% surface + blur(20px) saturate(1.12)）
  const imageDrawer = block(image, ".claw-sidebar-drawer");
  const imageSidebar = block(image, "[data-view-id=sidebar]");
  for (const line of ["background: color-mix(in srgb, var(--wb-surface) 78%, transparent) !important", "backdrop-filter: blur(20px) saturate(1.12)"]) {
    assert.ok(imageDrawer.includes(line), `抽屉应与主侧栏参数对齐：${line}`);
    assert.ok(imageSidebar.includes(line), `主侧栏基准行应存在：${line}`);
  }
  // 配色主题：无壁纸，抽屉与配色侧栏同一浮层配方（surface 92% 混文字色 5%，明暗自适应），实底不磨砂
  const palette = buildPaletteCss({ theme: baseTheme });
  assert.ok(palette.includes(".claw-workspace {\n  background: transparent !important;\n}"));
  const paletteDrawer = block(palette, ".claw-sidebar-drawer");
  const paletteSidebar = block(palette, "[data-view-id=sidebar]");
  assert.ok(paletteDrawer.includes("background: color-mix(in srgb, var(--wb-surface) 92%, var(--wb-text) 5%) !important"));
  assert.ok(paletteSidebar.includes("color-mix(in srgb, var(--wb-surface) 92%, var(--wb-text) 5%)"), "抽屉浮层应与配色侧栏同配方");
  assert.ok(!paletteDrawer.includes("backdrop-filter"), "配色主题无壁纸可透，抽屉不应磨砂");
});

test("已发出对话气泡：--cr-user-bubble-bg 钉为文字色洗底（.cr-theme 作用域），图片/配色主题共用", () => {
  for (const css of [buildSkinCss({ theme: baseTheme, heroDataUrl: HERO }), buildPaletteCss({ theme: baseTheme })]) {
    // 原生暗色 #ffffff1a / 亮色近实底白卡会糊住壁纸；变量声明在 :root/.cr-theme 上，
    // 气泡祖先链带 .cr-theme.conversation-timeline，body 级覆盖会被更近继承层截胡
    assert.ok(css.includes(".cr-theme {\n  --cr-user-bubble-bg: color-mix(in srgb, var(--wb-text) 16%, transparent) !important;\n}"), "气泡底色应为 .cr-theme 作用域的文字色 16% 洗底");
  }
});

test("主题切换过渡：四色驱动变量 @property 注册为 <color>，body 450ms 变量过渡，图片/配色主题同源", () => {
  for (const css of [buildSkinCss({ theme: baseTheme, heroDataUrl: HERO }), buildPaletteCss({ theme: baseTheme })]) {
    // 注册后变量才可插值：切换时 var() 引用处（60+ --cb-* 派生）随插值每帧重算
    for (const name of ["--wb-accent", "--wb-secondary", "--wb-surface", "--wb-text"]) {
      assert.ok(css.includes(`@property ${name} { syntax: "<color>"; inherits: true;`), name);
    }
    assert.ok(css.includes("transition: --wb-accent .45s ease, --wb-secondary .45s ease, --wb-surface .45s ease, --wb-text .45s ease;"));
    // 淡出层/视频层（z-index:-1 挂 #root 内）需独立层叠上下文才能盖在 #root 背景之上
    const rootBlock = css.slice(css.indexOf("#root {"), css.indexOf("}", css.indexOf("#root {")));
    assert.ok(rootBlock.includes("isolation: isolate !important"), "#root 应 isolation:isolate");
  }
});

// ---- buildPaletteCss：配色主题（无图纯配色）换色基座 ----

test("配色主题基座：与图片主题共享同一 --cb-* 变量覆盖块（防模板漂移）", () => {
  const palette = buildPaletteCss({ theme: baseTheme });
  const image = buildSkinCss({ theme: baseTheme, heroDataUrl: HERO });
  // 变量块逐字节一致：两者同源于 buildVariableOverrides
  const extractBlock = (css) => css.slice(css.indexOf("body[data-application-name=workbuddy]"), css.indexOf("--cb-markdown-hr-border-color"));
  assert.equal(extractBlock(palette), extractBlock(image));
  // 四色落到 --wb-* 变量
  assert.ok(palette.includes("--wb-accent: #5141F2"));
  assert.ok(palette.includes("--wb-surface: #F5F6F8"));
  assert.ok(palette.includes("--cb-bg-primary: var(--wb-surface) !important"));
  assert.ok(palette.includes("--cb-text-link: var(--wb-accent) !important"));
  // 悬停洗底钉为文字色自适应（原生 #fff 8% 白洗底在浅色皮肤侧栏上隐形，一级树行 hover 不可见）
  assert.ok(palette.includes("--wb-todo-menu-bg-hover: color-mix(in srgb, var(--wb-text) 10%, transparent) !important"));
  assert.ok(palette.includes("--cb-hover-bg: color-mix(in srgb, var(--wb-text) 8%, transparent) !important"));
});

test("配色主题基座：无 hero 实底表面，容器透化透出根层，侧边栏文字色微浮层", () => {
  const css = buildPaletteCss({ theme: baseTheme });
  assert.ok(css.includes("/* WORKBUDDY_PALETTE:demo */"));
  // 不需要 hero：#root 与 teams-container 实底表面色（无 url() 背景图）
  assert.ok(css.includes("#root {\n  background: var(--wb-surface) !important;"));
  assert.ok(!css.includes("url("), "配色基座不应含任何背景图引用");
  const containerBlock = css.slice(css.indexOf(".teams-container,"), css.indexOf(".teams-grid-scroll-content,"));
  assert.ok(containerBlock.includes("background: var(--wb-surface) !important"));
  // grid 容器与 [data-view-id] 透化
  assert.ok(css.includes("[class*=gridView] {\n  background: transparent !important;"));
  assert.ok(css.includes("[data-view-id] {\n  background: transparent !important;"));
  // 侧边栏：surface 混文字色的双向明暗自适应浮层 + accent 选中微光
  assert.ok(css.includes("color-mix(in srgb, var(--wb-surface) 92%, var(--wb-text) 5%)"));
  assert.ok(css.includes('[data-view-id=sidebar] [aria-selected="true"]'));
  // 首页路由钉为表面色
  assert.ok(css.includes(".wb-home-route {\n  background: var(--wb-surface) !important;"));
});

test("配色主题基座：复用组件点缀块（主标题渐变/字标/推荐条），无 brand/headline 伪元素", () => {
  const css = buildPaletteCss({ theme: baseTheme });
  assert.ok(css.includes(".wb-home-header__title"));
  assert.ok(css.includes(".conversation-list-logo .logo-workbuddy-title"));
  assert.ok(css.includes(".wb-skill-rec-bar {"));
  // 配色主题无 copy 文案概念：不注入 #root 伪元素
  assert.ok(!css.includes("#root::before"));
  assert.ok(!css.includes("#root::after"));
});

test("配色主题基座：非法色值拒绝，id 消毒与图片主题同规则", () => {
  assert.throws(() => buildPaletteCss({ theme: { ...baseTheme, colors: { accent: "red" } } }), /无效主题颜色/);
  const css = buildPaletteCss({ theme: { ...baseTheme, id: "Focus Night!!" } });
  assert.ok(css.includes("WORKBUDDY_PALETTE:FocusNight"));
});

test("成长伙伴形象替换：content:url 换图 + contain 入框 + 隐藏悬停动图，首页/会话页双槽位", () => {
  const MASCOT = "data:image/webp;base64,bWFzY290";
  // 未配置 mascot 时返回空串（未配置主题不输出本块，原生机器人保留）
  assert.equal(buildMascotCss(null), "");
  assert.equal(buildMascotCss(undefined), "");
  const css = buildMascotCss(MASCOT);
  assert.ok(css.includes(".wb-home-route__growth-buddy"));
  assert.ok(css.includes(".conversation-input__growth-buddy"));
  assert.ok(css.includes(`content: url(${JSON.stringify(MASCOT)}) !important`));
  assert.ok(css.includes("object-fit: contain !important"));
  assert.ok(css.includes("video"), "悬停动图 video 应被隐藏，避免盖回原生动画");
  // 默认参数不输出 transform（历史快照字节级一致）
  assert.ok(!css.includes("transform"));
  assert.throws(() => buildMascotCss("https://evil.example/x.png"), /mascot 必须是/);
});

test("成长伙伴形象替换：mascotScale/mascotOffset 输出底部居中锚点的 transform", () => {
  const MASCOT = "data:image/webp;base64,bWFzY290";
  const css = buildMascotCss(MASCOT, { scale: 1.05, offset: { x: 2, y: -6 } });
  assert.ok(css.includes("transform: translate(2px, -6px) scale(1.05) !important"));
  assert.ok(css.includes("transform-origin: 50% 100% !important"));
  // 默认值等价于不输出（scale=1 / offset=0）
  assert.equal(buildMascotCss(MASCOT, { scale: 1, offset: { x: 0, y: 0 } }), buildMascotCss(MASCOT));
  // offset 缺省键按 0 处理
  assert.ok(buildMascotCss(MASCOT, { scale: 1.2 }).includes("translate(0px, 0px) scale(1.2)"));
});
