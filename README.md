# dsh-session-cleanup

给 DSH 侧栏的会话「⋯」菜单加一条 **删除对话…**，把对话从列表和磁盘上一起清掉。

DSH 自带的「归档」只是把对话藏起来，日志还躺在 `~/.dsh/sessions` 里；这个插件补的就是那一刀。

## 功能

- 会话行「⋯」菜单里新增 **删除对话…**（在「复制 Session ID」下面，用分隔线单独成组）
- 点开后先显示这条对话占多少磁盘空间
- 必须勾选「我已知晓，删除后无法恢复」才能点「永久删除」
- 删除范围：
  - `~/.dsh/sessions/<工作区>/session-<id>/`（会话日志本体）
  - `~/.dsh/storages/session_projcache/sessions/session-<id>.json`（列表用的投影缓存）
  - 工作区登记里的这条会话席位（`workspaceRegistry.detachSession`，让侧栏彻底不再列它）
- 删除成功后页面自动刷新一次，侧栏那一行消失

## 安装

1. 打开 **设置 → 插件**，点 **安装**
2. 填仓库地址：

   ```
   https://github.com/huabenwuxiang/dsh-session-cleanup
   ```

   也可以从本地目录安装：选 **从本地目录 / 本地路径**，填这个仓库在本机的绝对路径。

3. 安装完 **重启 DSH**（host 半侧要重启才会加载）

> 从本地目录安装时，源码目录不要删、不要挪：pnpm 是以链接方式装进 profile 的，目录没了插件就坏了。要搬家先卸载，再从新位置装。

## 使用

1. 鼠标移到侧栏的对话行，点 **⋯**
2. 点 **删除对话…**
3. 看清占用空间，勾选确认，点 **永久删除**
4. 页面自动刷新，这行没了

## 边界与已知限制

- **不可恢复**：不进回收站，没有撤销。
- **正在用的对话删不掉**：当前打开的、或还有回合在跑的会话会被 Host 拒绝（`agents.get(sessionId)` 还活着）。先切到别的对话，等它停下来再删。
- **只删这一条**：subagent 派生的子会话、以及其他对话共用的附件不会跟着删。附件是内容寻址共享的，删了会连带影响别的对话，所以有意不动。
- **删除后整页刷新**：侧栏列表来自 Host 投影，刷新一次最稳；如果当时别的对话正在生成，刷新不会中断它（生成在 host 进程里）。
- **只接受同源请求**：路由会检查 `Origin`，别的网页发过来的跨源请求直接 403。

## 实现

| 文件 | 作用 |
|---|---|
| `lib/index.js` | host 半侧：`ctx.webServer` 注册 `/dsh-session-cleanup` 路由（`/stat`、`/delete`），删文件 + `detachSession` |
| `lib/client.js` | client 半侧：Module Loader 工厂，往 `sidebar.workspaces.session.menu.item` 注册菜单项，往 `shell.overlay` 注册确认弹窗 |
| `cordis.patch.yml` | bundle patch，把插件挂进配置树 |
| `scripts/test-host.mjs` | 用临时 `DSH_HOME` 跑删除逻辑 + HTTP 路由自测 |
| `scripts/test-client.mjs` | 不启动 DSH，验证 client 装配形状与菜单渲染 |

自测：

```powershell
cd dsh-session-cleanup
node scripts/test-host.mjs
node scripts/test-client.mjs
```

两个脚本都只碰系统临时目录，不动真实会话数据。

## 卸载

设置 → 插件 → 找到 `dsh-session-cleanup` → 移除，然后重启 DSH。
