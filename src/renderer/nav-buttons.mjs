// 渲染进程侧的「右侧定位按钮」子系统（注入体片段，字符串形态）。
//
// 这是注入体里最独立的一块：与皮肤逻辑的耦合面只有 3 个符号——
//   logError（片段内调用，由前置片段提供）
//   scheduleNavUpdate（被 layoutObserver 回调调用，前向引用靠回调异步成立）
//   teardown 里的 5 行解绑（cancelNavAnim / 两个 scroll-resize 监听 / navRoot.remove）
// 它本就是外来的——原注释写明「参考 .workbuddy-themes 运行时的滚动按钮实现移植」。
//
// 形态与拼接顺序约束同 color-utils.mjs：字符串片段、单一作用域、顺序由
// skin-menu 的 RENDERER_FRAGMENTS 固化并有测试断言。
// 本片段必须排在 teardown 注册之前（teardown 要引用 navRoot / cancelNavAnim），
// 且排在 layoutObserver 之后无妨（那是异步回调里的前向引用）。

export const NAV_BUTTONS_SNIPPET = String.raw`  // ---- 右侧定位按钮：回到顶部 / 上一个提问 / 下一个提问 / 回到底部 ----
  // 参考 .workbuddy-themes 运行时的滚动按钮实现移植：WorkBuddy 未暴露稳定的会话
  // DOM 锚点，滚动容器与提问锚点都走启发式探测。容器按「可滚动 + 宽度≥40% 视口 +
  // 高度≥200 + 面积最大」挑选并缓存 500ms；提问锚点优先 data-role/class 启发式
  // （剔除嵌套命中、排除 assistant/bot 类名），兜底取容器最高子节点的直接子项
  const navRoot = document.createElement("div");
  // 位置锚定对话框（见 updateNavPlacement），right/bottom 初始值为探测失败时的兜底
  navRoot.style.cssText = "position:fixed;right:14px;bottom:96px;z-index:2147483000;display:none;flex-direction:column;align-items:center;gap:8px;user-select:none;-webkit-app-region:no-drag;app-region:no-drag;";

  let scrollBox = null;
  let scrollBoxProbedAt = 0;
  const preferredScrollBox = () => {
    const preferred = document.querySelector(".messages-container");
    return preferred && preferred.scrollHeight > preferred.clientHeight + 20 ? preferred : null;
  };
  const findScrollBox = () => {
    const now = Date.now();
    // 缓存有效期内直接复用。注意 TTL 必须同时覆盖「找到了」与「确实没有」两种结果：
    // 旧实现的守卫是 scrollBox && ...，而兜底扫描无果时 scrollBox 保持 null，
    // 于是每次调用都 miss、重新扫一遍全文档——在无可滚容器的页面（设置页、空的
    // 新建任务页）配合 layoutObserver + scroll 捕获的双路驱动，就是「每帧一次
    // querySelectorAll('*') 全文档扫描」，比注释声称的「每 500ms 一次」糟约 30 倍。
    // 改为用独立的探测时间戳做门控，负结果同样享受 TTL。
    if (now - scrollBoxProbedAt < 500) {
      if (!scrollBox) return null;                       // 近期探测过且确实没有
      if (scrollBox.isConnected) return scrollBox;
    }
    const preferred = preferredScrollBox();
    // 过期先做 O(1) 重验证：旧容器仍在文档、仍可滚、且未被更优先的 .messages-container
    // 取代时直接续期——避免无谓的全文档扫描
    if (scrollBox && scrollBox.isConnected && (!preferred || scrollBox === preferred)
        && scrollBox.scrollHeight > scrollBox.clientHeight + 20) {
      scrollBoxProbedAt = now;
      return scrollBox;
    }
    scrollBoxProbedAt = now;
    scrollBox = preferred;
    if (scrollBox) return scrollBox;
    let best = null;
    let bestArea = 0;
    const viewportWidth = window.innerWidth || 1200;
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollHeight <= el.clientHeight + 20) continue;
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 0.4 * viewportWidth || rect.height < 200) continue;
      const area = rect.width * rect.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    // 无条件写回（含 null）：让下一轮的 TTL 门控对「确实没有」同样生效
    scrollBox = best;
    return scrollBox;
  };

  const USER_ANCHOR_SELECTOR = "[data-role=user],[data-author=user],[data-message-role=user],[data-from=user],[class*=user-message],[class*=message-user],[class*=message--user],[class*=is-user],[class*=--user],[class*=_user],[class*=human],[class*=-self],[class*=sender]";
  const findAnchors = (box) => {
    let anchors = Array.from(box.querySelectorAll(USER_ANCHOR_SELECTOR))
      .filter((el) => !/assistant|agent|\bai\b|bot|robot|menu|avatar|trigger|reply|answer|response/i.test(el.getAttribute("class") || ""));
    // 只留最外层命中：嵌套命中时丢弃被包含者，避免定位到同一条提问的内部碎片
    anchors = anchors.filter((el) => !anchors.some((other) => other !== el && other.contains(el)));
    anchors = anchors.filter((el) => el.getBoundingClientRect().height >= 8);
    if (anchors.length === 0) {
      // 兜底：容器最高子节点的直接子项（>=2 条才有定位意义），再退到通用消息类
      let tallest = null;
      let maxHeight = 0;
      for (const child of box.children) {
        if (child.scrollHeight > maxHeight) { maxHeight = child.scrollHeight; tallest = child; }
      }
      let candidates = tallest && tallest.children.length >= 2 ? Array.from(tallest.children) : [];
      if (candidates.length < 2) {
        const generic = box.querySelectorAll("[class*=message],[class*=msg],[class*=chat-item]");
        if (generic.length >= 2) candidates = Array.from(generic);
      }
      anchors = candidates.filter((el) => el.getBoundingClientRect().height >= 8);
    }
    return anchors.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  };

  // 元素在滚动容器坐标系里的纵向偏移（含当前滚动量）
  const offsetInBox = (box, el) => Math.round(el.getBoundingClientRect().top - (box.getBoundingClientRect().top - box.scrollTop));

  // rAF 三次缓出 420ms 平滑滚动；用户滚轮/触摸介入立即让出控制权（捕获阶段取消动画）
  let navAnim = 0;
  const cancelNavAnim = () => {
    if (!navAnim) return;
    cancelAnimationFrame(navAnim);
    navAnim = 0;
  };
  const smoothScrollTo = (box, targetTop) => {
    cancelNavAnim();
    const startTop = box.scrollTop;
    const startAt = performance.now();
    const easeOut = (t) => 1 - Math.pow(1 - t, 3);
    const step = () => {
      navAnim = 0;
      if (!box.isConnected) return;
      // 目标每帧重新夹取：流式输出使 scrollHeight 增长时，回到底部能跟随到底
      const max = Math.max(0, box.scrollHeight - box.clientHeight);
      const target = Math.max(0, Math.min(targetTop, max));
      const progress = Math.min(1, (performance.now() - startAt) / 420);
      box.scrollTop = startTop + (target - startTop) * easeOut(progress);
      if (progress < 1) navAnim = requestAnimationFrame(step);
      else box.scrollTop = target;
    };
    navAnim = requestAnimationFrame(step);
  };

  const NAV_TOLERANCE = 4;
  const scrollToEdge = (direction) => {
    const box = findScrollBox();
    if (!box) return;
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    smoothScrollTo(box, direction < 0 ? 0 : max);
  };
  const scrollToQuestion = (direction) => {
    const box = findScrollBox();
    if (!box) return;
    const anchors = findAnchors(box);
    const current = box.scrollTop;
    let target = null;
    if (direction < 0) {
      for (let i = anchors.length - 1; i >= 0; i -= 1) {
        if (offsetInBox(box, anchors[i]) < current - NAV_TOLERANCE) { target = anchors[i]; break; }
      }
    } else {
      for (const el of anchors) {
        if (offsetInBox(box, el) > current + NAV_TOLERANCE) { target = el; break; }
      }
    }
    if (target) smoothScrollTo(box, offsetInBox(box, target));
  };

  const navButton = (label, svgBody, onClick) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.style.cssText = "width:32px;height:32px;border-radius:50%;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.85);backdrop-filter:blur(10px);box-shadow:0 2px 8px rgba(0,0,0,.12);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;color:#17344f;";
    // svgBody 为下方静态字面量，无用户输入，innerHTML 安全
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + svgBody + "</svg>";
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      try { onClick(); } catch (error) { logError("定位按钮点击处理失败", label, error); }
    });
    return btn;
  };

  navRoot.append(
    navButton("\u56de\u5230\u9876\u90e8", '<line x1="6" y1="4.5" x2="18" y2="4.5"></line><polyline points="7 12 12 7 17 12"></polyline><line x1="12" y1="7" x2="12" y2="19"></line>', () => scrollToEdge(-1)),
    navButton("\u4e0a\u4e00\u4e2a\u63d0\u95ee", '<polyline points="6 14 12 8 18 14"></polyline>', () => scrollToQuestion(-1)),
    navButton("\u4e0b\u4e00\u4e2a\u63d0\u95ee", '<polyline points="6 10 12 16 18 10"></polyline>', () => scrollToQuestion(1)),
    navButton("\u56de\u5230\u5e95\u90e8", '<line x1="12" y1="5" x2="12" y2="17"></line><polyline points="7 12 12 17 17 12"></polyline><line x1="6" y1="19.5" x2="18" y2="19.5"></line>', () => scrollToEdge(1)),
  );
  document.body.appendChild(navRoot);

  // 边界灰化：已在顶部时「回到顶部/上一个提问」无意义（上方没有更早的提问），
  // 底部同理；用 disabled 置灰（同时阻断点击），随滚动实时刷新
  const [navBtnTop, navBtnPrev, navBtnNext, navBtnBottom] = navRoot.children;
  const setNavEnabled = (btn, enabled) => {
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? "1" : ".38";
    btn.style.cursor = enabled ? "pointer" : "default";
  };
  const updateNavEdges = (box) => {
    const max = Math.max(0, box.scrollHeight - box.clientHeight);
    const atTop = box.scrollTop <= NAV_TOLERANCE;
    const atBottom = box.scrollTop >= max - NAV_TOLERANCE;
    setNavEnabled(navBtnTop, !atTop);
    setNavEnabled(navBtnPrev, !atTop);
    setNavEnabled(navBtnNext, !atBottom);
    setNavEnabled(navBtnBottom, !atBottom);
  };

  // 显隐与定位：容器可滚才显示；scroll 捕获监听 + layoutObserver（见上）双路驱动，均按
  // rAF 合帧。位置锚定对话框（输入框）上方右侧——内容列会随消息布局漂移，输入框是
  // 会话页最稳定的地标；底边固定在输入框顶上方 12px，右缘与输入框右缘外侧 6px 对齐
  const findComposer = () => {
    let best = null;
    let bestWidth = 0;
    const viewportHeight = window.innerHeight || 800;
    for (const el of document.querySelectorAll("textarea,[contenteditable=true],[contenteditable=''],[class*=composer],[class*=chat-input],[class*=input-area]")) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 20) continue;
      if (r.top < viewportHeight * 0.4) continue; // 输入框应在视口下半部
      if (r.width > bestWidth) { bestWidth = r.width; best = r; }
    }
    return best;
  };
  const updateNavPlacement = () => {
    const composer = findComposer();
    if (!composer) {
      navRoot.style.right = "14px";
      navRoot.style.bottom = "96px";
      return;
    }
    navRoot.style.right = Math.max(-6, Math.round(window.innerWidth - composer.right - 6)) + "px";
    const bottom = Math.round(window.innerHeight - composer.top + 12);
    // 上下限：不低于 8px（输入框贴底时），不高于视口高减菜单高（异常布局时防出顶）
    navRoot.style.bottom = Math.min(Math.max(8, bottom), window.innerHeight - 160) + "px";
  };
  let navUpdateQueued = false;
  const updateNavVisibility = () => {
    // 主页（欢迎页）不显示：欢迎区内容列可滚，会被 findScrollBox 兜底扫描误命中。
    // 反向门控——按主页地标（标题头/主页容器/空会话占位）判定，进入会话后这些节点消失
    if (document.querySelector(".wb-home-page,.wb-home-header,.colleague-chat-empty-profile")) {
      navRoot.style.display = "none";
      return;
    }
    const box = findScrollBox();
    const show = !!box && box.scrollHeight > box.clientHeight + 20;
    if (show) {
      // 顺序要紧：updateNavEdges 读 box.scrollHeight/scrollTop（布局读），
      // updateNavPlacement 写 navRoot.style.right/bottom（布局写）。
      // 先写后读会让那次读变成强制同步布局，而本函数每帧都跑——读在前、写在后，
      // 把一帧内的布局访问收敛成「全读 → 全写」。两者无数据依赖，可自由排序。
      updateNavEdges(box);
      updateNavPlacement();
    }
    navRoot.style.display = show ? "flex" : "none";
  };
  const scheduleNavUpdate = () => {
    if (navUpdateQueued) return;
    navUpdateQueued = true;
    requestAnimationFrame(() => { navUpdateQueued = false; updateNavVisibility(); });
  };
  document.addEventListener("scroll", scheduleNavUpdate, true);
  window.addEventListener("resize", scheduleNavUpdate);
  // 用户滚轮/触摸滚动时取消进行中的定位动画，避免与动画抢滚动条
  document.addEventListener("wheel", cancelNavAnim, true);
  document.addEventListener("touchstart", cancelNavAnim, true);
  scheduleNavUpdate();
`;
