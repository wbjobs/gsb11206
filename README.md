# 本地文件快照工具

基于 **File System Access API + IndexedDB + Web Worker** 的纯前端本地目录快照工具：授权目录后定时增量扫描，支持查看、对比、精确回滚。

## 运行

需要通过 HTTP(S) 或 localhost 访问（File System Access API 要求安全上下文，且模块 Worker 不能用 `file://`）：

```bash
cd 本目录
python3 -m http.server 8000
# 打开 Chrome / Edge 访问 http://localhost:8000
```

## 功能与设计

| 需求 | 实现 |
| --- | --- |
| 目录句柄持久化 | `FileSystemDirectoryHandle` 结构化克隆存入 IndexedDB `handles` 表，刷新后自动恢复 |
| 定时扫描 | 主线程定时器（30s/1min/5min/30min 可配），无变化时不生成新快照 |
| 增量快照 | 文件 size+mtime 未变则复用上次的哈希与块引用；内容按 4MiB 分块、内容寻址（hash 去重）存 IndexedDB `chunks` 表 |
| 大文件分块 | `file.slice()` 分块读取 + 自研增量 SHA-256，内存占用恒定 |
| 权限被撤销 | 扫描/回滚中捕获 `NotAllowedError` → 降级横幅 + 禁用操作 + 「重新授权」按钮（用户手势内 `requestPermission`） |
| 快照中断可续 | 条目随扫随写库；页面关闭时 `running` 快照启动时标记 `interrupted`；下次扫描自动合并复用中断快照已完成的条目 |
| 存储配额 | 写块前 `navigator.storage.estimate()` 预检 + 捕获 `QuotaExceededError`，配额条实时显示，超限明确提示 |
| 回滚一致性 | 计划（恢复/删除/建删目录）→ 执行 → 全量重新哈希校验，校验失败明确报告缺失/不一致/残留文件 |
| 对比准确 | 基于清单（路径 + 内容哈希）的 added/removed/modified 三路对比 |
| 主线程不卡 | 遍历、哈希、读写全部在模块 Worker，主线程只收发进度消息 |

## 测试

```bash
node test/run-tests.mjs   # SHA-256 对照 node:crypto、对比/回滚计划/校验纯逻辑，共 21 项
```

## 目录结构

- `index.html` / `css/style.css` — 页面与样式
- `js/main.js` — UI、权限生命周期、定时调度、配额条
- `js/worker.js` — 扫描/哈希/回滚/GC（Worker）
- `js/db.js` — IndexedDB 封装（handles / snapshots / entries / chunks / meta）
- `js/sha256.js` — 增量 SHA-256
- `js/diff.js` — 对比、回滚计划、回滚校验（纯函数，浏览器/Node 共用）
- `test/run-tests.mjs` — Node 单测
