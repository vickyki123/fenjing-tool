# 脚本分镜工具

门店短视频脚本的批量处理工具（网页版，**口令访问**）。

**网址**：https://vickyki123.github.io/fenjing-tool/

功能：加分镜 / 去出镜 / 加挂载 / 去分镜 / 替换表 / 红线检测，另带规则库编辑与「待补清单」反馈闭环。

- 工具本体加密存放在 `payload.js`，**没有口令看不到任何内容**
- 使用者的脚本只在各自浏览器里处理，**不上传任何服务器**

## 维护说明（仅维护者）

源码与构建目录在本地 `~/Desktop/分镜工具/`：

1. 改 `rules.json` / `app.js` / `index.html`
2. `node tools/build_locked.js '<口令>'` 重新打包 → `dist-locked/`
3. 只上传 `dist-locked/index.html` 与 `dist-locked/payload.js`（链接不变，使用者刷新即最新）

⚠️ 明文 `app.js` / `rules.js` / `rules.json` / `lib/` **不要上传**，否则加密失效。
