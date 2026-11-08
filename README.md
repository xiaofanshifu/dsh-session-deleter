# dsh-session-deleter

DeepSeek Harness（DSH）的**会话彻底删除**插件。Harness 内置的会话管理只有
**归档**（archive，可逆的隐藏），没有真正的删除。本插件在会话右键菜单里补上
红色「删除会话」，把某个会话在磁盘上留下的**所有痕迹**一次性清除（永久、不可恢复）。

- 版本：`0.3.1`（在 DSH `0.2.2-rc.1` 桌面版 / Web GUI 上实测通过）
- 形态：DSH 第三方插件（主机半 + 浏览器半，零构建、零 npm 依赖，唯一 peer 依赖
  `@deepseek-ai/dsh-typert-protocol` 由宿主运行时解析）
- 代码：[src/host.js](src/host.js)（主机端）、[src/client.js](src/client.js)（浏览器端）

---

## 一、日常使用

1. 打开本机 Web GUI（`http://127.0.0.1:<端口>`，端口见桌面应用标题栏或
   `~\.dsh\profiles\desktop` 启动日志）。
2. 在左侧**会话列表**上**右键**某个会话。
3. 菜单底部（footer 区）出现红色「**删除会话**」→ 点击。
4. 弹出确认框（明示"永久删除、不可恢复"）→ 点「**永久删除**」。
5. 该行**立即消失**（主机广播 `api-session/removed`，侧边栏实时刷新，无需 F5）。

### 行为规则

| 场景 | 行为 |
|---|---|
| 右键**当前正在查看**的会话 | 「删除会话」**置灰不可点**（红线，设计如此）。要删它：先点开侧边栏里另一个会话把主视图切走，再回来右键它 |
| 右键**空闲的旧会话**（即使仍驻留宿主内存） | 可直接删除；删除后由复活守护复清宿主写回，退出瞬间的残余由下次启动自清（见「五、安全设计」） |
| 目标会话**正在跑 turn** | 自动先停止该 turn（同你点"停止"）→ 等其空闲 → 排空写屏障 → 再删，不丢在途数据 |
| 找不到任何数据 | 报 `session/not-found`，客户端自动补一次 `purgeSession` 清理孤儿残留 |

### 删除了哪些数据

对目标 `session-<uuid>`，三处全部清除：

1. **物理会话日志目录**（消息正文）
   `%USERPROFILE%\.dsh\sessions\<encoded-cwd>\session-<uuid>\`
   （`<encoded-cwd>` 是工作区路径编码，如 `C:\workspace\dsh` → `--C-workspace-dsh--`）
2. **投影缓存行**（侧边栏标题 / 时间元数据）
   `%USERPROFILE%\.dsh\storages\session_projcache\sessions\session-<uuid>.json`
3. **工作区注册表引用**
   `%USERPROFILE%\.dsh\storages\workspace.json`
   中的 `global.archivedSessionIds`、`global.pinnedSessionIds`、`tables.workspaces[*].sessionIds`

另有 sqlite 全文搜索索引：它是派生缓存，观察到物理日志缺失后**自动剪枝**，无需处理。

> 删除不可恢复。误删前请确认该会话里没有需要保留的内容。

---

## 二、安装

**用 tarball 安装（实体拷贝，推荐）**：pnpm 把包文件真实拷进 profile，
装完后与源文件/源目录再无关联，源码可以随意移动、删除。

先打 tarball（二选一）：
```powershell
# 在有 npm 的机器上，进入源码目录执行：
npm pack            # 生成 dsh-session-deleter-0.x.x.tgz
# 或直接把现成的 zip 换成 tgz：
tar -czf dsh-session-deleter-0.3.1.tgz --transform 's,^dsh-session-deleter,package,' dsh-session-deleter
```
把 `.tgz` 放到一个**长期保留的路径**（如 `~\.dsh\plugins\`）。

### 方式 A：DSH 插件管理器（推荐）

在 DSH 会话里让 agent 执行（`plugin_manager` 工具），**target 指向 .tgz 文件**：

```
plugin_manager.install_bundle target=C:\Users\<你>\.dsh\plugins\dsh-session-deleter-0.3.1.tgz
```

它会：
1. 在 `~\.dsh\profiles\desktop` 下用 pnpm 以 `file:` 方式把包**实体拷贝**进
   `node_modules/.pnpm`（需要本机已装 Node.js 18+ 与 pnpm）；
2. 把 `"dsh-session-deleter"` 写进 `~\.dsh\profiles\desktop\package.json`
   的 `dsh.profile.bundles`；
3. 触发宿主 HMR 热回放（返回 `application: "applied"` 即已生效）。

> ⚠️ 若 target 直接给**源码目录**，插件管理器会用 `link:` 软链安装——
> 此后源码目录被移动/删除，插件立即失效。请务必用 .tgz。

安装/热回放后**重启一次 DSH**（或等 HMR 回放完成），Web GUI 按 F5。

### 方式 B：手动安装（无 agent 时）

在 `~\.dsh\profiles\desktop` 下依次执行：

```powershell
# 1) 实体拷贝进 profile（file: 指向 tgz）
pnpm add "dsh-session-deleter@C:\Users\<你>\.dsh\plugins\dsh-session-deleter-0.3.1.tgz"

# 2) 编辑 package.json：在 dsh.profile.bundles 数组里追加一行 "dsh-session-deleter"

# 3) 重启 DeepSeek Harness，然后 Web GUI 按 F5
```

验证安装成功：
- 宿主插件清单里出现 `dsh-session-deleter` 且 `fiberPhase: "active"`
  （agent 可 `plugin_manager list_plugins` 查）；
- Web GUI 右键任一旧会话，菜单底部有红色「删除会话」；
- `~\.dsh\profiles\desktop\node_modules\dsh-session-deleter\` 是**实体目录**
  （非软链，`Get-Item` 的 LinkType 为空）。

---

## 三、卸载

### 方式 A：插件管理器

```
plugin_manager.remove_bundle target=dsh-session-deleter
```

自动：移除依赖记录（`file:` tarball 或 `link:`）、从 `dsh.profile.bundles`
删除该条、宿主热回放下线插件。
Web GUI 按 F5 后右键菜单里「删除会话」消失即卸载完成。

### 方式 B：手动卸载

```powershell
# 在 ~\.dsh\profiles\desktop 下：
pnpm remove dsh-session-deleter
```

再编辑 `package.json` 从 `dsh.profile.bundles` 数组里删掉
`"dsh-session-deleter"` 一行，重启 DeepSeek Harness。

> 卸载只移除插件本身，**不会恢复已删除的会话**（删除是永久的）。

---

## 四、排错

| 现象 | 原因 / 处理 |
|---|---|
| 右键菜单没有「删除会话」 | 1) 页面未加载新客户端：F5 一次；2) 插件未激活：宿主重启（退出并重开 DeepSeek Harness）；3) 确认 `package.json` 的 `dsh.profile.bundles` 与 `node_modules/dsh-session-deleter` 都在 |
| 「删除会话」置灰 | 该会话是**当前正在查看**的——切到别的会话再删（设计如此） |
| 提示"找不到会话的任何数据" | 该会话三处痕迹都不在了（可能已被删）；客户端会自动尝试 `purgeSession`，仍失败则无残留可清 |
| 提示 `gateway/definition-unavailable` 或 `invocation-unavailable` | 宿主没加载到插件（宿主半失效）：重启 DeepSeek Harness 后 F5 |
| 删除后侧边栏行没消失 | F5 一次（正常情况主机广播会实时移除） |
| pnpm 安装报 peer 依赖 WARN | 可忽略：`link:` 安装的包不从目标目录解析 peer，宿主运行时用内置版本 |

---

## 五、安全设计

- **红线（当前对话保护）**：客户端按主面板查看状态（`uiWorkspace.selection`）把
  菜单项**置灰**，点击时二次校验；这是"当前对话"的准确判定。
- **运行中数据安全**：主机端删除前若目标正在 running，先
  `agent.cancel({kind:'user'})` + 等待 `whenIdle()` + `sessions.flush()` 排空写屏障、
  释放文件句柄，再删——与内置"归档时停止会话"同款语义。
- **确认框**：永久操作必须先确认。
- **sid 严格白名单**：只接受 `session-<uuid>`，非法 id → `gateway/bad-request`。
- **越界防护**：物理目录删除前校验 `basename === sid` 且路径必须位于 `sessions/` 之下。
- **原子写回**：兜底路径改写 `workspace.json` 用临时文件 + rename。
- **复活守护与启动自清**：宿主对仍驻留内存的会话有写回机制——退出时
  `session/disposed` 会重写投影缓存行，后续新事件会重建物理日志。删除驻留会话后，
  主机端装一个有界守护（每 20s 复清一次，最多 15 轮；连续 3 轮干净且会话已不再驻留
  则提前结束），fiber 卸载（HMR 热换）时随插件生命周期一并停止；退出瞬间的写回则由
  **下次启动的 startupSelfClean** 自动清掉孤儿投影行——仅清「无物理日志 + 无工作区
  引用 + 本进程未驻留」的投影缓存（可再生派生数据），用户无感。

## 六、架构（开发者）

- `src/host.js`：纯 ESM，`SessionDeleter` 继承 `TypertRemoteService`（service key
  `sessionDeleter`）；手工以 TC39 等价方式打 `@Remote` marker，并注册 typert manifest
  （`src-json` codec，face `host`）。网关走**严格本地**描述符，不解析方法源码。
  所有宿主服务（`agents` / `sessions` / `sessionProjectionCache` /
  `workspaceRegistry` / `sessionPersistence`）用 `ctx.get(...)` **调用时**获取，
  缺失即安全降级——插件加载永不失败。
- `src/client.js`：`window.__ModuleLoader__.load` CJS-factory（零构建，只
  `require('react')`）；注册 `session.delete` 右键菜单项（danger、footer），经
  `connection.rpc.call("/api", "sessionDeleter/...", { args: { request } })` 调主机端。
- `package.json`：`dsh.bundle.patch` → `cordis.patch.yml`（insert 一行
  `id: session-deleter, name: dsh-session-deleter`，id 须等于 host 的 `export const name`）；
  `dsh.client` 声明浏览器半（`platform: web, immediately: true`）。
- 测试：与本包同级的 `test-sandbox/` 目录下——`v2-test.cjs`（宿主四用例）、
  `client-test.cjs`（客户端红线五用例）、`e2e.cjs`（真实数据端到端：植入一次性会话再删）。
