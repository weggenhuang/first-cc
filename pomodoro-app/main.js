/**
 * ───────────────────────────────────────────────────────────
 *  🍅 番茄钟 — Electron 主进程
 *  ───────────────────────────────────────────────────────────
 *  这个文件是桌面应用的 "后台"，负责：
 *  1. 创建窗口（无边框、自绘标题栏）
 *  2. 系统托盘（最小化到托盘、托盘菜单）
 *  3. 数据持久化（读写 JSON 文件）
 *  4. IPC 通信（主进程 ↔ 渲染进程的桥梁）
 *  5. 桌面通知（阶段切换时弹窗）
 *  6. 应用生命周期管理（启动、关闭、退出）
 *
 *  ⚠️ 主进程 vs 渲染进程：
 *     - main.js = 主进程（Node.js 环境，可以操作文件系统）
 *     - index.html = 渲染进程（浏览器环境，负责 UI）
 *     - preload.js = 安全桥接层（暴露有限的 API 给渲染进程）
 * ───────────────────────────────────────────────────────────
 */

// ===================================================================
//  模块导入
//  ===================================================================
//  app: 控制应用生命周期（启动、退出等）
//  BrowserWindow: 创建和管理窗口
//  Tray: 系统托盘图标
//  Menu: 创建菜单
//  Notification: 系统桌面通知
//  ipcMain: 主进程端 IPC（进程间通信），接收渲染进程的请求
//  nativeImage: 创建原生图片（给托盘和通知用）
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage } = require('electron');
const path = require('path');   // 路径处理
const fs = require('fs');       // 文件系统（读写状态文件）

// ===================================================================
//  常量
// ===================================================================
// app.getPath('userData') → 获取当前用户的 AppData 目录
// 例如: C:\Users\用户名\AppData\Roaming\pomodoro-app\
// 状态文件存在这里，不同电脑/用户互不干扰
const DATA_FILE = path.join(app.getPath('userData'), 'pomodoro-state.json');

// ===================================================================
//  全局状态
// ===================================================================
let mainWindow = null;   // 主窗口引用
let tray = null;         // 系统托盘引用

// 番茄钟的核心状态数据
// 注意：这仅是主进程的备份数据，渲染进程（前端）维护着当前活跃状态
// 主进程主要负责「持久化保存」和「主进程特有的功能（托盘、通知）」
let state = {
  mode: 'focus',          // 当前模式: 'focus' 专注 | 'break' 短休 | 'longBreak' 长休
  status: 'idle',         // 当前状态: 'idle' 空闲 | 'running' 运行中 | 'paused' 已暂停
  seconds: 25 * 60,       // 当前显示的剩余秒数（25 分钟 × 60 秒）
  focusMinutes: 25,       // 专注时长（分钟，用户可调）
  breakMinutes: 5,        // 短休时长（分钟，用户可调）
  longBreakMinutes: 15,   // 长休时长（分钟，用户可调）
  focusCountInBlock: 0,   // 当前「番茄块」中已完成几个专注了（满 4 个就触发长休）
  totalPomos: 0,          // 总共完成了多少个番茄（历史累计）
  totalFocusSeconds: 0,   // 总共专注了多少秒（历史累计）
  tasks: [],              // 任务列表 [{ text: "任务名", done: false, pomos: 0 }]
  soundEnabled: true,     // 是否启用提示音
  autoStart: false,       // 是否自动开始下一个阶段
};

// ===================================================================
//  loadState()  — 从硬盘加载上次保存的状态
//  ===================================================================
//  应用启动时调用，读取 JSON 文件并合并到 state 对象
//  这样用户关闭应用再打开，任务列表、统计数据都还在
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {               // 检查文件是否存在
      const raw = fs.readFileSync(DATA_FILE, 'utf-8'); // 读取文件内容
      const data = JSON.parse(raw);               // 解析 JSON
      Object.assign(state, data);                  // 合并到 state
    }
  } catch (_) {
    // 文件损坏或格式错误时静默忽略，使用默认值
  }
}

// ===================================================================
//  persistState()  — 将状态保存到硬盘
// ===================================================================
// 每次状态变化时调用（专注完成、任务增减、设置修改等）
// state 序列化为 JSON 写入文件，缩进 2 个空格方便调试查看
function persistState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (_) {
    // 写入失败时静默忽略（如磁盘满、权限不足）
  }
}

// ===================================================================
//  createWindow()  — 创建主窗口
// ===================================================================
//  配置一个无边框窗口（frame: false），自绘标题栏
//  窗口大小固定（420×640），只允许在 380~520 宽、580~780 高之间微调
//  使用 preload.js 做安全隔离：渲染进程不能直接访问 Node.js
function createWindow() {
  mainWindow = new BrowserWindow({
    // ── 窗口尺寸 ──
    width: 420,
    height: 640,
    resizable: false,       // 用户不能自由调整大小
    maximizable: false,     // 禁用最大化按钮
    fullscreenable: false,  // 不能全屏

    // ── 窗口样式 ──
    frame: false,            // 无边框窗口（我们用 HTML 画标题栏）
    transparent: false,      // 不透明（设为 true 可实现圆角玻璃效果）
    backgroundColor: '#f5f0eb', // 背景色，防止加载时白闪

    // ── 标题栏（macOS） ──
    titleBarStyle: 'hidden', // 隐藏原生标题栏

    // ── 安全配置 ──
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),  // 预加载脚本路径
      nodeIntegration: false,   // ❌ 禁止渲染进程直接使用 Node.js API
      contextIsolation: true,   // ✅ 启用上下文隔离（安全最佳实践）
    },

    // ── 延迟显示 ──
    show: false,   // 先不显示，等页面加载完成再显示（避免白屏）
  });

  // ── 加载页面 ──
  mainWindow.loadFile('index.html');

  // ── 限制窗口大小范围 ──
  mainWindow.setMinimumSize(380, 580);
  mainWindow.setMaximumSize(520, 780);

  // ── 页面就绪后显示窗口 ──
  // 用 once 而不是 on，只触发一次
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // ── 关闭行为的特殊处理 ──
  // 点击关闭按钮时，默认行为是「隐藏到系统托盘」而不是真的退出
  // 只有用户通过托盘菜单的「退出」才会真正关闭
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {       // 如果不是「真的想退出」
      e.preventDefault();         // 阻止默认关闭行为
      mainWindow.hide();          // 隐藏窗口，回到托盘
    }
  });
}

// ===================================================================
//  createTray()  — 创建系统托盘
// ===================================================================
//  在 Windows 任务栏通知区域显示一个图标
//  提供右键菜单：「显示番茄钟」和「退出」
//  左键点击：切换窗口的显示/隐藏
function createTray() {
  // ── 创建托盘图标 ──
  // 用一段 Base64 编码的 PNG 数据（16×16 像素的纯色红点）
  // 避免依赖外部图标文件，让应用更便携
  const icon = nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAARklEQVQ4y2Ng+M9AAWBigAL4TwFmYKAEMJFrABMDA8N/Ch3AQE0XMFJqAAMDFRiQiwFkA8g2gFwDqGoAuQZQ1QByDaCqAQBUlQ0RFqHfqQAAAABJRU5ErkJggg==',
      'base64'
    )
  );

  tray = new Tray(icon);
  tray.setToolTip('🍅 番茄钟');   // 鼠标悬停时的提示文字

  // ── 右键菜单 ──
  const ctxMenu = Menu.buildFromTemplate([
    {
      label: '显示番茄钟',
      click: () => {
        // 点击后显示窗口并聚焦
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },       // 分隔线
    {
      label: '退出',
      click: () => {
        // 设置退出标记 → 关闭窗口时就不会隐藏而是真正退出
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(ctxMenu);

  // ── 左键点击托盘图标 ──
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();       // 如果已显示，只是聚焦
      } else {
        mainWindow.show();        // 如果隐藏了，显示出来
      }
    }
  });
}

// ===================================================================
//  setupIPC()  — 设置进程间通信（IPC）处理器
// ===================================================================
//  IPC 是 Electron 中「主进程 ↔ 渲染进程」的通信机制
//  渲染进程（index.html）通过 preload.js 暴露的 API 来调用这些处理器
//
//  处理器的命名规则：使用动词开头（get/save/show/update）
//  表示这个操作是「获取」「保存」「显示」「更新」
//
//  每个处理器的第一个参数是事件对象（用 _ 忽略），第二个参数是渲染进程传来的数据
function setupIPC() {
  // ── get-state: 返回当前状态数据 ──
  // 渲染进程启动时调用，用于恢复上次的状态
  ipcMain.handle('get-state', () => state);

  // ── get-data-path: 返回状态文件的路径（调试用） ──
  ipcMain.handle('get-data-path', () => DATA_FILE);

  // ── save-state: 接收渲染进程发来的状态数据并保存 ──
  // 渲染进程传回完整的 state 对象，主进程合并且写入文件
  ipcMain.handle('save-state', (_, data) => {
    Object.assign(state, data);   // 用传来的数据更新主进程的 state
    persistState();               // 写入硬盘
  });

  // ── show-notification: 显示系统桌面通知 ──
  // 专注结束、休息结束时调用，在 Windows 右下角弹出通知
  // Notification.isSupported() 检查当前系统是否支持通知
  ipcMain.handle('show-notification', (_, { title, body }) => {
    if (Notification.isSupported()) {
      new Notification({
        title,        // 通知标题，例如 "🍅 专注结束！"
        body,         // 通知正文，例如 "休息 5 分钟，放松一下吧～"
        icon: nativeImage.createEmpty(),  // 通知图标（暂用空图标）
      }).show();
    }
  });

  // ── update-tray-timer: 更新托盘图标的提示文字 ──
  // 每秒调用一次，让托盘 tooltip 显示当前倒计时 "🍅 番茄钟 - 24:35"
  ipcMain.handle('update-tray-timer', (_, timeStr) => {
    if (tray) {
      tray.setToolTip(`🍅 番茄钟 - ${timeStr}`);
    }
  });

  // ── 窗口控制 ──
  ipcMain.handle('minimize-window', () => mainWindow?.minimize());
  ipcMain.handle('close-window', () => mainWindow?.close());
  // 这里 close 会触发上面注册的 close 事件处理器，所以实际是隐藏到托盘
}

// ===================================================================
//  应用生命周期
// ===================================================================

// ── app.whenReady() ── 应用就绪后执行 ──
// Electron 应用启动后，需要等待 Chromium 和 Node.js 环境准备好
// then() 里的代码才是真正的入口
app.whenReady().then(() => {
  // 1. 从硬盘加载上次保存的状态
  loadState();

  // 2. 注册 IPC 通信处理器（让渲染进程能调用主进程功能）
  setupIPC();

  // 3. 创建系统托盘图标（先于窗口创建，确保体验一致）
  createTray();

  // 4. 创建主窗口（加载 index.html 页面）
  createWindow();

  // ── macOS 特殊处理 ──
  // 在 macOS 上，点击 Dock 图标应重新显示窗口
  app.on('activate', () => {
    if (mainWindow) mainWindow.show();
  });
});

// ── window-all-closed ── 所有窗口关闭时 ──
// 在 Windows/Linux 上，我们不退出应用（保持托盘运行）
// 在 macOS 上，通常遵循系统习惯，不退出（但这里也保持运行）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Windows/Linux: 不退出（让托盘继续运行）
    // 留空 = 不做任何操作 = 应用继续运行
  }
});

// ── before-quit ── 应用即将退出时 ──
// 在真正退出前保存状态，防止数据丢失
app.on('before-quit', () => {
  app.isQuitting = true;    // 标记为「主动退出」
  persistState();            // 保存最终状态
});

// ===================================================================
//  总结：数据流
// ===================================================================
//  ┌─────────────────────────────────────────────────────────┐
//  │  主进程 (main.js)                                        │
//  │  ┌──────────┐  ┌───────────┐  ┌──────────────────────┐  │
//  │  │ 加载状态  │  │ IPC 处理器 │  │ 托盘 & 通知          │  │
//  │  │ loadState │←┤ setupIPC  │←┤ createTray / notify  │  │
//  │  └────┬─────┘  └─────┬─────┘  └──────────────────────┘  │
//  │       │              │                                   │
//  │  ┌────▼─────┐  ┌─────▼─────┐                            │
//  │  │ 持久化    │  │ 读写      │                            │
//  │  │ persist  │  │ 状态文件   │                            │
//  │  └──────────┘  └───────────┘                            │
//  └───────────────────┬─────────────────────────────────────┘
//                      │ IPC (进程间通信)
//  ┌───────────────────▼─────────────────────────────────────┐
//  │  预加载脚本 (preload.js)                                  │
//  │  contextBridge.exposeInMainWorld('electronAPI', {...})  │
//  └───────────────────┬─────────────────────────────────────┘
//                      │ window.electronAPI
//  ┌───────────────────▼─────────────────────────────────────┐
//  │  渲染进程 (index.html)                                    │
//  │  - 番茄钟计时器                                           │
//  │  - 任务列表                                               │
//  │  - 设置面板                                               │
//  │  - 统计显示                                               │
//  └─────────────────────────────────────────────────────────┘
