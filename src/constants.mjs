import { homedir } from "node:os";
import { join } from "node:path";

export const PRODUCT_ID = "workbuddy-skins";
export const PRODUCT_NAME = "WorkBuddy Skins";
export const STATE_SCHEMA_VERSION = 1;
export const THEME_SCHEMA_VERSION = 1;
export const DEFAULT_THEME_ID = "miku-light";
export const DEFAULT_CDP_PORT = 9223;
// 内置视频主题（hero 为 MP4）的体积上限；与皮肤菜单里自定义视频上传的 30MB 上限保持一致
export const MAX_THEME_VIDEO_BYTES = 30 * 1024 * 1024;
// 主题选择弹窗缩略图（theme.json thumbnail）体积上限：以 data URL 随注入脚本下发，
// 每个主题都会进 payload，需卡小（建议 640×400 WebP，几十 KB）
export const MAX_THEME_THUMBNAIL_BYTES = 512 * 1024;
// 首页/会话页输入框上方「成长伙伴」替换形象（theme.json mascot）体积上限：
// 以 data URL 内联进该主题的 CSS 条目随菜单脚本下发，原生槽位仅 140px 见方，卡得更小
// （建议 256×256 透明底 WebP，几十 KB）
export const MAX_THEME_MASCOT_BYTES = 256 * 1024;
export const EXPECTED_BUNDLE_ID = "com.workbuddy.workbuddy";

// 主题素材：hero/poster 允许的图片扩展名（theme-schema 校验、theme-store 创建共用）
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".avifs"]);
// 动图不经压缩直接注入，需单独卡分辨率上限（Node 端 create 与渲染进程菜单上传共用）
export const MAX_ANIMATED_DIMENSION = 1920;

// 渲染进程 IndexedDB：视频皮肤原始文件存储（Node 端预置与菜单脚本共用同一个库）
export const VIDEO_DB_NAME = "workbuddy-skins";
export const VIDEO_DB_STORE = "videos";

// WorkBuddy renderer target 的 URL 特征：app.asar/renderer/index.html
export const RENDERER_URL_HINT = "renderer/index.html";

// 注入到渲染进程的两个节点 id：皮肤 <style> 与菜单根节点。
// 放在 constants 而非 injector：compat-probe 的探测表达式要按 id 临时禁用皮肤
// <style>（否则注入的 --cb-* 覆盖会伪装成原生支持），skinStatus 也要按 id 判在位。
// 两处都不该为了一个字符串去反向依赖注入编排层。
export const STYLE_ID = "workbuddy-skin-style";
export const MENU_ID = "workbuddy-skin-menu";

// 菜单注入体的 Runtime.evaluate 超时预算。注入体把全部主题的 hero/thumbnail/mascot
// 以 data URL 内联，实测 65 个主题 ≈ 6MB 素材 → base64 后约 8MB 表达式；渲染进程要在
// 主线程同步完成解析与编译。CDP 默认命令超时 5s（cdp-client DEFAULT_COMMAND_TIMEOUT_MS）
// 对这个量级不够，慢机必超时；且超时只 reject Promise、不会中断已在 renderer 里执行的
// 脚本（见 cdp-client 的 send），表现为「报超时但皮肤其实生效了」。
// 注入是主流程（失败即整体抛错），单独给足预算而不是抬高全局默认值。
export const MENU_INJECT_TIMEOUT_MS = 30_000;

export function resolveStudioPaths({ home = homedir() } = {}) {
  const isWin = process.platform === "win32";
  const installRoot = join(home, ".workbuddy", PRODUCT_ID);
  const stateRoot = isWin
    ? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "WorkBuddySkins")
    : join(home, "Library", "Application Support", "WorkBuddySkins");

  return {
    installRoot,
    stateRoot,
    statePath: join(stateRoot, "state.json"),
    logPath: join(stateRoot, "injector.log"),
    userThemesRoot: join(stateRoot, "themes"),
  };
}
