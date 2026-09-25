# 本地文件快照工具

基于 **File System Access API + IndexedDB + Web Worker** 的纯前端本地目录快照工具：授权目录后定时增量扫描，支持查看、对比、回滚。

## 运行

需要通过 HTTP(S) 或 localhost 访问（File System Access API 要求安全上下文），且使用 Chrome / Edge 等 Chromium 浏览器：

```bash
cd 本目录
python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 功能与验收对照

| 验收标准 | 实现 |
| --- | --- |
| 修改文件后生成新快照 | Worker 按 mtime+size 快速比对，仅对变化文件重新分块哈希，生成增量快照 |
| 回滚能精确恢复 | 回滚按内容哈希写回/删除/清理空目录，写入用 `createWritable`（浏览器内部先写交换文件、close 时原子提交），每个文件写后重新哈希校验，结束后全量校验目录与快照清单一致 |
| 权限被撤销有降级提示 | 每次操作前 `queryPermission` 检查；撤销后显示黄色降级横幅（数据仍可查看），自动扫描暂停，可一键 `requestPermission` 恢复 |
| 快照中断可续 | 扫描进度定期持久化到 IndexedDB `scanState`，刷新/崩溃后自动从未完成处续扫；回滚同样有 `rollbackState` 日志可续传 |
| 配额不足有提示 | 写入前用 `navigator.storage.estimate()` 预检并保留余量，同时捕获 `QuotaExceededError`，提示删除旧快照释放空间 |
| 对比结果准确 | 以 SHA-256 内容哈希逐路径比对，输出新增/删除/修改三类 |
| 主线程不卡 | 遍历、分块、哈希、IndexedDB 读写全部在 Web Worker 中执行，主线程只渲染 |

## 关键设计

- **目录句柄持久化**：`FileSystemDirectoryHandle` 结构化克隆存入 IndexedDB，刷新后免重新选择目录（权限需重新确认）。
- **大文件分块**：文件按 1MB 分块，逐块 SHA-256，块级去重存储（`chunks` 表），文件哈希 = 块哈希序列的哈希（`files` 表），相同内容跨快照零冗余。
- **快照记录**：`snapshots` 表存路径 → `{哈希, 大小, mtime}` 清单，增量快照只新增变化的块。
- **删除回收**：删除快照后自动 GC 未被任何快照引用的文件与块。

## 文件结构

- `index.html` / `styles.css` — 页面与样式
- `app.js` — 主线程：UI、权限交互、定时调度
- `worker.js` — Worker：扫描、分块哈希、快照、对比、回滚、GC
- `db.js` — IndexedDB 封装（页面与 Worker 共用）
