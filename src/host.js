/**
 * dsh-session-deleter — 主机侧（Host half）。纯 ESM，零构建。
 *
 * 功能：在 DeepSeek Harness 中"彻底删除会话"。Harness 内置会话管理只有
 * 归档（archive，可逆隐藏），没有真正的删除；本插件把某个会话在三处留下的
 * 痕迹全部清除（永久、不可恢复）：
 *
 *   1. 物理会话日志目录   <DSH home>/sessions/<encoded-cwd>/<session-uuid>/
 *   2. 投影缓存行         <DSH home>/storages/session_projcache/sessions/<session-uuid>.json
 *   3. 工作区注册表引用   <DSH home>/storages/workspace.json
 *        - global.archivedSessionIds / global.pinnedSessionIds
 *        - tables.workspaces[*].sessionIds
 *
 * 实现要点（对齐已发布第三方插件 dsh-cosplay 的 0.2.x 约定）：
 *   - SessionDeleter 继承 TypertRemoteService（cordis Service），以 service key
 *     `sessionDeleter` 注册进插件 fiber。
 *   - 同时：(a) 以 TC39 等价方式给原型打 @Remote marker；(b) 注册一份 typert
 *     manifest（face: host，invocations 用 src-json codec）。网关走**严格本地**
 *     描述符路径（this.ctx.typert.local.get(endpoint)），不解析方法源码——因为
 *     src 回退会用 lastIndexOf(')') 解析参数，复杂方法体会失败。cosplay 同款。
 *   - 服务用 ctx.get(...) 在**调用时**获取（inject 只声明硬依赖 typert），缺失时
 *     对应步骤安全降级，插件加载永不失败。
 *   - 红线（当前对话保护）由客户端按主面板查看状态判定；宿主侧只保证数据安全：
 *     目标若正在 running，先 cancel + whenIdle + flush 释放锁再删；空闲/驻留会话可删。
 *   - 复活守护（v0.3.1）：宿主对驻留会话有写回机制（session/disposed 时投影缓存
 *     无条件 flushSoft 重建；新事件触发 materialize 重建物理目录，Windows 上 rm
 *     不报错故静默）。插件无公共 API 处置其它 fiber 的会话，故对删除后仍驻留的
 *     会话装有界定时复清守护（20s x <=15 轮）；退出瞬间的写回由下次启动的
 *     startupSelfClean 自动清掉孤儿投影行（用户无感）。
 */
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export const name = 'session-deleter'
export const inject = ['typert']

const SERVICE_KEY = 'sessionDeleter'
const NAMESPACE = SERVICE_KEY
const PKG = 'dsh-session-deleter'
const SID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 以纯 JS 应用 TC39 现代装饰器 @Remote（0.2.x 形态）。`Remote(method, context)`
 * 是标准方法装饰器；这里手工传入等价 context 直接调用，并立即以**伪实例**为 this
 * 跑一次 initializer。真实 Remote 的 initializer 体是
 * `Object.getPrototypeOf(this)` → 必须让 this 的原型链命中目标类原型，
 * 因此用 `Object.create(proto)`（原型 === proto）。
 * 注意：不能用 `fn.call({})`——那会把 marker 写到 Object.prototype（全局污染，
 * 且 SessionDeleter.prototype 上无 marker，SRC 回退发现失效）。
 */
function markRemoteMethod(proto, methodName) {
  const method = proto[methodName]
  if (typeof method !== 'function') return
  const marker = {
    kind: 'method',
    name: methodName,
    static: false,
    private: false,
    addInitializer(fn) {
      fn.call(Object.create(proto))
    },
  }
  try {
    Remote(method, marker)
  } catch (error) {
    console.warn(`[dsh-session-deleter] Remote marker 失败（${methodName}）: ${error && error.message ? error.message : error}`)
  }
}

function log(ctx, level, msg) {
  try { if (ctx.logger && typeof ctx.logger[level] === 'function') ctx.logger[level](msg) } catch { /* ignore */ }
}

/** Promise 超时兜底：超时后继续等待原 Promise 但不阻断（返回的 Promise 在超时即 settle）。 */
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
}

class SessionDeleter extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, SERVICE_KEY)
    this.ctx = ctx
  }

  dshHome() {
    return process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
  }

  /**
   * 彻底删除一个会话（物理日志 + 投影缓存 + 工作区注册表引用）。
   * @param request - { sessionId }
   * @returns { deleted, sessionId, stopped, resident, physical, projection, registry, warnings?, errors? }
   *   - warnings：软提示（某处本就没有痕迹 / 已装复活守护）
   *   - errors：硬失败（某处删除出错，数据可能残留）
   * @throws RemoteError gateway/bad-request（非法 id）、
   *   session/not-found（三处都无痕迹且无错误）。
   */
  async deleteSession(request) {
    const raw = request && request.sessionId
    if (!raw || !SID_RE.test(String(raw))) {
      throw new RemoteError('gateway/bad-request', 'invalid sessionId', { sessionId: String(raw || '') })
    }
    const sid = String(raw)

    // 删除前判定是否驻留（宿主对驻留会话有写回复活机制，见 installResurrectionGuard）
    const resident = this.isResident(sid)

    // 数据安全护栏（非"当前对话"红线——红线由客户端按查看状态判定）：
    // 目标会话若正在 running（agent 有活跃 turn / 文件写句柄），先停止并等待写
    // 屏障 flush 释放锁，再删；空闲会话直接删。与内置"归档时停止会话"同款语义。
    const stopped = await this.stopIfRunning(sid)

    const { removed, warnings, errors } = await this.removeTraces(sid)

    if (!removed.physical && !removed.projection && !removed.registry && errors.length === 0) {
      throw new RemoteError('session/not-found', `找不到会话 ${sid} 的任何数据（物理日志 / 投影缓存 / 工作区注册表均无痕迹）。`, { sessionId: sid })
    }

    // 实时刷新：内置 session-controller 把 api-session/removed 转发给客户端，侧边栏随即移除该行。
    try { this.ctx.emit('api-session/removed', sid) } catch { /* best-effort */ }

    // 复活守护：目标仍驻留本进程时，宿主的 session/disposed（应用退出 / fiber 解绕）
    // 会无条件 flushSoft 重写投影行，后续新事件会重建物理日志。插件没有公共 API 处置
    // 其它 fiber 的会话（detachEntered 私有），故装一个有界定时复清。
    if (resident && (removed.physical || removed.projection || removed.registry)) {
      this.installResurrectionGuard(sid)
      warnings.push('residue-guard:active')
    }

    log(this.ctx, 'info', `[dsh-session-deleter] deleted ${sid}: stopped=${stopped} resident=${resident} physical=${removed.physical} projection=${removed.projection} registry=${removed.registry}${errors.length ? ' errors=' + JSON.stringify(errors) : ''}`)
    return {
      deleted: true, sessionId: sid, stopped, resident,
      physical: removed.physical, projection: removed.projection, registry: removed.registry,
      ...warnings.length ? { warnings } : {},
      ...errors.length ? { errors } : {},
    }
  }

  /** 删除会话的三处痕迹。返回 { removed, warnings, errors }（软提示与硬失败分离）。 */
  async removeTraces(sid) {
    const removed = { physical: false, projection: false, registry: false }
    const warnings = []
    const errors = []
    try {
      const dir = await this.locatePhysicalDir(sid)
      if (dir) removed.physical = await this.removeDirSafe(dir, join(this.dshHome(), 'sessions'), sid)
      else warnings.push('physical:not-found')
    } catch (e) { errors.push('physical:' + (e && e.code ? e.code : 'error')) }

    try { removed.projection = await this.removeProjectionRow(sid) }
    catch (e) { errors.push('projection:' + (e && e.code ? e.code : 'error')) }

    try { removed.registry = await this.detachFromWorkspace(sid) }
    catch (e) { errors.push('registry:' + (e && e.code ? e.code : 'error')) }

    return { removed, warnings, errors }
  }

  /** 会话是否仍驻留本进程的 session store（未 dispose）。缺失服务视为不驻留。 */
  isResident(sid) {
    const sessions = this.ctx.get('sessions')
    if (!sessions || typeof sessions.get !== 'function') return false
    try { return sessions.get(sid) !== undefined } catch { return false }
  }

  /** 守护状态表（sid → { rounds, cleanStreak, busy, timer }）。 */
  guardState = new Map()

  /**
   * 驻留会话的复活守护（有界）：每 20s 复扫三处痕迹，发现宿主写回即再删。
   * 连续 3 轮干净且会话已不再驻留 → 提前结束。最多 15 轮（5 分钟）兜底。
   *
   * 注意：不做 beforeExit 终扫。ref'd setInterval 使事件循环永不为空，Node 不会
   * 触发 beforeExit；且桌面端退出走 app.quit()/process.exit()，本就不发 beforeExit
   * ——该路径是死代码。退出瞬间的 session/disposed 写回复活，改由**下次启动的
   * startupSelfClean** 兜底（见 apply），更可靠。
   */
  installResurrectionGuard(sid) {
    // 重装前先停掉已有守护：否则旧 st 被覆盖但其 setInterval 不会 clear——
    // 旧计时器闭包仍按 sid 查表驱动新 st（扫描频率翻倍）且永久泄漏（review 确认）。
    if (this.guardState.has(sid)) this.stopGuard(sid)
    const st = { rounds: 0, cleanStreak: 0, busy: false, timer: null }
    this.guardState.set(sid, st)
    st.timer = setInterval(() => { void this.guardSweep(sid) }, 20_000)
    log(this.ctx, 'info', `[dsh-session-deleter] residue guard armed for ${sid} (20s x <=15)`)
  }

  async guardSweep(sid) {
    const st = this.guardState.get(sid)
    if (!st || st.busy) return // busy 标志防止上一轮 I/O 未结束时重叠跑（review #3）
    st.busy = true
    st.rounds += 1
    try {
      const before = await this.traceExists(sid)
      const revived = before.physical || before.projection || before.registry
      if (revived) {
        const { removed } = await this.removeTraces(sid)
        log(this.ctx, 'warn', `[dsh-session-deleter] ${sid} traces reappeared (round ${st.rounds}: physical=${before.physical} projection=${before.projection} registry=${before.registry}; re-removed: ${removed.physical}/${removed.projection}/${removed.registry})`)
        try { this.ctx.emit('api-session/removed', sid) } catch { /* best-effort */ }
        st.cleanStreak = 0
      } else {
        st.cleanStreak += 1
      }
    } catch (e) {
      log(this.ctx, 'warn', `[dsh-session-deleter] guard sweep failed for ${sid}: ${e && e.message ? e.message : e}`)
    } finally {
      st.busy = false
    }
    const resident = this.isResident(sid)
    // 身份校验：若本轮 I/O 期间守护被重装，st 已脱离 guardState，不能停掉新守护。
    if (this.guardState.get(sid) === st && (st.rounds >= 15 || (st.cleanStreak >= 3 && !resident))) this.stopGuard(sid)
  }

  /** 三处痕迹当前是否存在（守护复扫用）。 */
  async traceExists(sid) {
    const exists = { physical: false, projection: false, registry: false }
    try { exists.physical = !!(await this.locatePhysicalDir(sid)) } catch { /* ignore */ }
    try {
      const cache = this.ctx.get('sessionProjectionCache')
      if (cache && cache.table && typeof cache.table.get === 'function' && cache.table.get(sid) !== undefined) {
        exists.projection = true
      } else {
        const projFile = join(this.dshHome(), 'storages', 'session_projcache', 'sessions', sid + '.json')
        const s = await stat(projFile).catch(() => null)
        exists.projection = !!(s && s.isFile())
      }
    } catch { /* ignore */ }
    try {
      const ws = this.ctx.get('workspaceRegistry')
      if (ws) {
        for (const entity of ws.list()) {
          const raw = entity && entity.record && Array.isArray(entity.record.sessionIds) ? entity.record.sessionIds : []
          if (raw.includes(sid)) { exists.registry = true; break }
        }
        if (!exists.registry && Array.isArray(ws.archivedSessionIds) && ws.archivedSessionIds.includes(sid)) exists.registry = true
        if (!exists.registry && Array.isArray(ws.pinnedSessionIds) && ws.pinnedSessionIds.includes(sid)) exists.registry = true
      } else {
        const file = join(this.dshHome(), 'storages', 'workspace.json')
        const doc = JSON.parse(await readFile(file, 'utf8'))
        const g = doc.global || {}
        if ((Array.isArray(g.archivedSessionIds) && g.archivedSessionIds.includes(sid)) ||
            (Array.isArray(g.pinnedSessionIds) && g.pinnedSessionIds.includes(sid))) exists.registry = true
        if (!exists.registry) {
          for (const rec of Object.values((doc.tables || {}).workspaces || {})) {
            if (rec && Array.isArray(rec.sessionIds) && rec.sessionIds.includes(sid)) { exists.registry = true; break }
          }
        }
      }
    } catch { /* ignore */ }
    return exists
  }

  stopGuard(sid) {
    const st = this.guardState.get(sid)
    if (!st) return
    if (st.timer) try { clearInterval(st.timer) } catch { /* ignore */ }
    this.guardState.delete(sid)
    log(this.ctx, 'info', `[dsh-session-deleter] residue guard released for ${sid} after ${st.rounds} sweeps`)
  }

  /**
   * 启动自清理：宿主在**应用退出**时会无条件把驻留会话的投影缓存行重写回磁盘
   * （session/disposed → flushSoft），这是运行期守护（仅 ~5 分钟窗口）覆盖不到的
   * 唯一残留。本方法在插件加载后延迟扫一次投影目录，把"物理日志已无 + 工作区
   * 引用已无 + 本进程未驻留"的孤儿投影行删掉——用户无需任何操作，下次启动自动清。
   * 只删投影孤儿，不碰物理目录 / 工作区（那两处若复活会触发守护或本就可见）。
   */
  async startupSelfClean() {
    // 等其它服务初始化完成（投影缓存 table、workspace registry、sessions 都要就绪）。
    // 1500ms 是经验值而非精确同步：若某服务尚未就绪，isResident 可能误判为 false，
    // 但删除前有"无物理日志 + 无工作区引用"双重检查兜底，且投影是可再生派生缓存，
    // 误删一个孤儿投影行的代价极低（下次冷读会从物理日志重建），故可接受。
    await new Promise((r) => setTimeout(r, 1500))
    const projDir = join(this.dshHome(), 'storages', 'session_projcache', 'sessions')
    let entries
    try { entries = await readdir(projDir, { withFileTypes: true }) } catch { return 0 }
    // 把两个昂贵判断（物理目录存在性 / 工作区引用）提出循环、各只算一次建集合，
    // 避免逐行 traceExists→persistence.list() 全量 stat 造成的 O(投影行数×会话数) I/O 尖峰。
    const physSids = await this.listPhysicalSids()
    const regSids = await this.registrySidSet()
    let cleaned = 0
    for (const e of entries) {
      const m = e.name.match(/^(session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i)
      if (!m) continue
      const sid = m[1]
      try {
        // 仅当"只有投影残留"（无物理日志 + 无工作区引用）且本进程未驻留时才清
        if (!physSids.has(sid) && !regSids.has(sid) && !this.isResident(sid)) {
          const removed = await this.removeProjectionRow(sid)
          if (removed) { cleaned += 1; log(this.ctx, 'info', `[dsh-session-deleter] startup clean: removed orphan projection row ${sid}`) }
        }
      } catch { /* 单个失败不影响其它 */ }
    }
    if (cleaned) log(this.ctx, 'info', `[dsh-session-deleter] startup clean done: ${cleaned} orphan projection row(s)`)
    return cleaned
  }

  /** 所有"物理日志目录仍存在"的会话 id 集合（仅 readdir，不逐日志 stat，不依赖 persistence.list）。 */
  async listPhysicalSids() {
    const set = new Set()
    const sessionsRoot = join(this.dshHome(), 'sessions')
    try {
      if (!(await stat(sessionsRoot)).isDirectory()) return set
      for (const group of await readdir(sessionsRoot, { withFileTypes: true })) {
        if (!group.isDirectory()) continue
        const groupDir = join(sessionsRoot, group.name)
        for (const s of await readdir(groupDir, { withFileTypes: true })) {
          if (s.isDirectory() && SID_RE.test(s.name)) set.add(s.name)
        }
      }
    } catch { /* ignore */ }
    return set
  }

  /** 所有"仍被工作区注册表引用"的会话 id 集合（分组 / 归档 / 固定三处）。 */
  async registrySidSet() {
    const set = new Set()
    const ws = this.ctx.get('workspaceRegistry')
    if (ws) {
      try {
        for (const entity of ws.list()) {
          const raw = entity && entity.record && Array.isArray(entity.record.sessionIds) ? entity.record.sessionIds : []
          for (const id of raw) set.add(id)
        }
      } catch { /* ignore */ }
      try { for (const id of ws.archivedSessionIds || []) set.add(id) } catch { /* ignore */ }
      try { for (const id of ws.pinnedSessionIds || []) set.add(id) } catch { /* ignore */ }
      return set
    }
    // 兜底（无活服务）：直接读 workspace.json
    try {
      const doc = JSON.parse(await readFile(join(this.dshHome(), 'storages', 'workspace.json'), 'utf8'))
      const g = doc.global || {}
      for (const id of g.archivedSessionIds || []) set.add(id)
      for (const id of g.pinnedSessionIds || []) set.add(id)
      for (const rec of Object.values((doc.tables || {}).workspaces || {})) {
        if (rec && Array.isArray(rec.sessionIds)) for (const id of rec.sessionIds) set.add(id)
      }
    } catch { /* ignore */ }
    return set
  }

  /**
   * 若目标会话当前正在 running（agent 有活跃 turn），停止它并等待写屏障 flush，
   * 以释放物理日志句柄，保证随后的 rm 不失败、也不丢在途数据。空闲会话不处理。
   * 返回是否执行了停止。任何缺失服务都安全降级（返回 false）。
   */
  async stopIfRunning(sid) {
    const agents = this.ctx.get('agents')
    if (!agents || typeof agents.get !== 'function') return false
    let agent
    try { agent = agents.get(sid) } catch { return false }
    if (!agent || agent.status !== 'running') return false
    // 停止该 turn（与用户点"停止"同款，丢弃排队输入）
    if (agent.cancel) { try { agent.cancel({ kind: 'user' }) } catch { /* best-effort */ } }
    // 等待其空闲（turn 结算 + 写屏障排空），带超时兜底
    if (agent.whenIdle) {
      try { await withTimeout(agent.whenIdle(), 15000) } catch { /* best-effort */ }
    }
    // 再 flush 一次，确保落盘、释放句柄
    const sessions = this.ctx.get('sessions')
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sid) : undefined
    if (session && typeof sessions.flush === 'function') {
      try { await withTimeout(sessions.flush(session), 10000) } catch { /* best-effort */ }
    }
    return true
  }

  /** 仅清理"孤儿"残留：物理日志已不在、但投影缓存 / 工作区注册表仍有引用。 */
  async purgeSession(request) {
    const raw = request && request.sessionId
    if (!raw || !SID_RE.test(String(raw))) {
      throw new RemoteError('gateway/bad-request', 'invalid sessionId', { sessionId: String(raw || '') })
    }
    const sid = String(raw)
    let projection = false
    let registry = false
    try { projection = await this.removeProjectionRow(sid) } catch { projection = false }
    try { registry = await this.detachFromWorkspace(sid) } catch { registry = false }
    if (!projection && !registry) {
      throw new RemoteError('session/not-found', `没有可清理的残留（投影缓存 / 工作区注册表均无 ${sid}）。`, { sessionId: sid })
    }
    try { this.ctx.emit('api-session/removed', sid) } catch { /* best-effort */ }
    log(this.ctx, 'info', `[dsh-session-deleter] purged ${sid}: projection=${projection} registry=${registry}`)
    return { deleted: true, sessionId: sid, physical: false, projection, registry }
  }

  /** 通过 sessionPersistence 清单定位物理日志目录；找不到时扫描 sessions 根。 */
  async locatePhysicalDir(sid) {
    const sessionsRoot = join(this.dshHome(), 'sessions')
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence && typeof persistence.list === 'function') {
      try {
        const list = await persistence.list()
        for (const snap of list || []) {
          if (snap && snap.header && snap.header.id === sid && snap.location && snap.location.path) {
            return dirname(snap.location.path)
          }
        }
      } catch { /* fall through */ }
    }
    try {
      if (!(await stat(sessionsRoot)).isDirectory()) return null
      for (const group of await readdir(sessionsRoot, { withFileTypes: true })) {
        if (!group.isDirectory()) continue
        const candidate = join(sessionsRoot, group.name, sid)
        const st = await lstat(candidate).catch(() => null)
        if (st && st.isDirectory()) return candidate
      }
    } catch { /* ignore */ }
    return null
  }

  /** 删除一个会话目录：basename 必须是该 sid、且必须位于 sessions 根之下（越界防护）。 */
  async removeDirSafe(target, sessionsRoot, sid) {
    const t = resolve(target)
    const root = resolve(sessionsRoot)
    if (basename(t) !== sid) return false
    if (t === root) return false
    if (!t.startsWith(root + sep)) return false
    const st = await lstat(t)
    if (!st.isDirectory()) return false
    await rm(t, { recursive: true, force: true })
    return true
  }

  /**
   * 删除投影缓存行：优先走服务内部 domain table（内存 + 磁盘一致）。
   * 若活 table 里没有该行（可能尚未载入 / 纯磁盘孤儿），回退删 per-record 文档，
   * 保证"内存表无、磁盘文件有"的异常态也能清掉（否则守护会空转）。
   */
  async removeProjectionRow(sid) {
    const cache = this.ctx.get('sessionProjectionCache')
    if (cache && cache.table && typeof cache.table.get === 'function') {
      if (cache.table.get(sid) !== undefined) {
        if (typeof cache.table.delete === 'function') { await cache.table.delete(sid); return true }
        // 无 delete 能力 → 落到文件兜底
      }
    }
    const projFile = join(this.dshHome(), 'storages', 'session_projcache', 'sessions', sid + '.json')
    const st = await stat(projFile).catch(() => null)
    if (st && st.isFile()) { await rm(projFile, { force: true }); return true }
    return false
  }

  /**
   * 从工作区注册表移除该会话：优先走活注册表公开方法（生产环境，触发 follow 帧实时刷新）。
   * 注意：成员判断必须用**原始记录** `entity.record.sessionIds`，不能用公开 getter
   * `entity.sessionIds`——后者按 header 索引过滤（candidateMatches），日志已删的孤儿
   * 引用会被滤掉导致判断为 false，从而永远清不掉（v0.2 的 bug）。
   * `detachSession` 本身操作未过滤的原始记录，缺席时是 no-op，可安全调用。
   */
  async detachFromWorkspace(sid) {
    const ws = this.ctx.get('workspaceRegistry')
    if (ws) {
      let inGroup = false
      let inArchived = false
      let inPinned = false
      try {
        for (const entity of ws.list()) {
          const raw = entity && entity.record && Array.isArray(entity.record.sessionIds)
            ? entity.record.sessionIds
            : (Array.isArray(entity.sessionIds) ? entity.sessionIds : [])
          if (raw.includes(sid)) inGroup = true
        }
      } catch { /* ignore */ }
      try { inArchived = Array.isArray(ws.archivedSessionIds) && ws.archivedSessionIds.includes(sid) } catch { /* ignore */ }
      try { inPinned = Array.isArray(ws.pinnedSessionIds) && ws.pinnedSessionIds.includes(sid) } catch { /* ignore */ }
      if (!inGroup && !inArchived && !inPinned) return false
      if (inGroup) {
        try {
          for (const entity of ws.list()) {
            const raw = entity && entity.record && Array.isArray(entity.record.sessionIds) ? entity.record.sessionIds : []
            if (raw.includes(sid) && typeof entity.detachSession === 'function') {
              await entity.detachSession(sid)
            }
          }
        } catch { /* ignore */ }
      }
      if (inArchived && typeof ws.unarchiveSession === 'function') await ws.unarchiveSession(sid)
      if (inPinned && typeof ws.unpinSession === 'function') await ws.unpinSession(sid)
      return true
    }
    // 兜底（无活服务时，如隔离测试）：直接改写 workspace.json（原子写回）。
    return await this.detachWorkspaceFile(sid)
  }

  async detachWorkspaceFile(sid) {
    const file = join(this.dshHome(), 'storages', 'workspace.json')
    let raw
    try { raw = await readFile(file, 'utf8') } catch { return false }
    let doc
    try { doc = JSON.parse(raw) } catch { return false }
    let changed = false
    const g = doc.global || (doc.global = {})
    if (Array.isArray(g.archivedSessionIds) && g.archivedSessionIds.includes(sid)) {
      g.archivedSessionIds = g.archivedSessionIds.filter((x) => x !== sid); changed = true
    }
    if (Array.isArray(g.pinnedSessionIds) && g.pinnedSessionIds.includes(sid)) {
      g.pinnedSessionIds = g.pinnedSessionIds.filter((x) => x !== sid); changed = true
    }
    const tables = doc.tables || {}
    for (const rec of Object.values(tables.workspaces || {})) {
      if (rec && Array.isArray(rec.sessionIds) && rec.sessionIds.includes(sid)) {
        rec.sessionIds = rec.sessionIds.filter((x) => x !== sid)
        rec.updatedAt = new Date().toISOString()
        changed = true
      }
    }
    if (!changed) return false
    const tmp = file + '.dsh-del.' + process.pid + '.tmp'
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8')
    await rename(tmp, file)
    return true
  }
}

for (const method of ['deleteSession', 'purgeSession']) {
  markRemoteMethod(SessionDeleter.prototype, method)
}

// ── typert manifest（严格本地描述符；src-json codec 不需要 create() 工厂） ──
const srcJson = (typeSymbol) => ({ mode: 'src-json', typeSymbol })

const INVOCATIONS = [
  {
    id: PKG + '#' + NAMESPACE + '/deleteSession',
    service: SERVICE_KEY,
    namespace: NAMESPACE,
    method: 'deleteSession',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: srcJson(PKG + '#DeleteRequest') }],
    result: srcJson(PKG + '#DeleteResult'),
  },
  {
    id: PKG + '#' + NAMESPACE + '/purgeSession',
    service: SERVICE_KEY,
    namespace: NAMESPACE,
    method: 'purgeSession',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: srcJson(PKG + '#PurgeRequest') }],
    result: srcJson(PKG + '#DeleteResult'),
  },
]

const MANIFEST = {
  package: PKG,
  face: 'host',
  schemas: [],
  model: {
    services: [
      {
        key: SERVICE_KEY,
        exportName: 'SessionDeleter',
        description: '彻底删除会话：清理物理日志、投影缓存行、工作区注册表引用。',
        tags: [],
        members: [
          { kind: 'method', name: 'deleteSession', signature: 'deleteSession(request: DeleteRequest): Promise<DeleteResult>' },
          { kind: 'method', name: 'purgeSession', signature: 'purgeSession(request: PurgeRequest): Promise<DeleteResult>' },
        ],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: INVOCATIONS,
}

export { SessionDeleter }

export function apply(ctx) {
  const svc = new SessionDeleter(ctx)
  ctx.effect(() => {
    const dispose = ctx.typert.register(MANIFEST)
    return () => { dispose() }
  }, 'dsh-session-deleter: typert manifest')
  // 启动自清理：把上次运行退出时宿主重写的孤儿投影行清掉（用户无感）。
  // 幂等且只删孤儿，fiber 卸载（HMR 热换）时让旧扫描自行跑完即可，无需取消。
  ctx.effect(() => {
    svc.startupSelfClean().catch((e) => {
      log(ctx, 'warn', '[dsh-session-deleter] startup clean failed: ' + (e && e.message ? e.message : e))
    })
  }, 'dsh-session-deleter: startup self-clean')
  // 守护绑定 fiber 生命周期：本插件热卸载时停掉所有残留守护，避免旧实例的
  // setInterval 对已 dispose 的 stale ctx 持续复清 + 泄漏（review #2）。
  ctx.effect(() => {
    return () => { for (const sid of [...svc.guardState.keys()]) svc.stopGuard(sid) }
  }, 'dsh-session-deleter: guard lifecycle')
  log(ctx, 'info', '[dsh-session-deleter] host ready — remote: sessionDeleter/deleteSession, sessionDeleter/purgeSession')
}

export default { name, inject, apply }
