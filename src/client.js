/**
 * dsh-session-deleter — 浏览器侧（Client half，__ModuleLoader__ CJS-factory 形式，
 * 零构建、零依赖，只 require('react')）。
 *
 * 职责：在会话列表行的右键菜单里追加「删除会话」项（danger，置底）。点击后弹出
 * 确认框，确认后通过 connection.rpc 直连主机端 Remote 端点
 * `sessionDeleter/deleteSession` 执行彻底删除；主机删完后会广播
 * api-session/removed，侧边栏实时移除该行（无需 F5）。
 *
 * 保护：
 *   - "当前对话"红线由本端按主面板正在查看的会话（uiWorkspace.selection）判定：
 *     正在查看的会话不显示删除项，点击时二次校验；
 *   - 空闲的旧会话（即使仍驻留宿主内存）可以删除——宿主端只负责在删除前把
 *     running 的 turn 停掉并等写屏障 flush，保证数据安全；
 *   - 删除是不可恢复的永久操作，必须经过确认框。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-deleter',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var NS = 'sessionDelete'
    var zh = {
      'menu.delete': '删除会话',
      'confirm.title': '删除会话',
      'confirm.desc': '将永久删除该会话的全部内容（消息、附件、工作区记录）。此操作不可恢复。',
      'confirm.ok': '永久删除',
      'confirm.cancel': '取消',
      'success.deleted': '会话已删除',
      'success.purged': '会话残留已清理',
      'error.failed': '删除失败',
      'error.partial': '以下位置删除失败：%s。请重启应用后再次右键「删除会话」清理残留。',
      'error.current': '不能删除当前正在查看的会话，请切换到别的会话后再删。',
    }
    var en = {
      'menu.delete': 'Delete session',
      'confirm.title': 'Delete session',
      'confirm.desc': 'This permanently deletes all session data (messages, attachments, workspace record). It cannot be undone.',
      'confirm.ok': 'Delete forever',
      'confirm.cancel': 'Cancel',
      'success.deleted': 'Session deleted',
      'success.purged': 'Session residue purged',
      'error.failed': 'Delete failed',
      'error.partial': 'These locations failed to delete: %s. Restart the app and use Delete session again to clean the residue.',
      'error.current': 'You cannot delete the session you are currently viewing. Switch to another first.',
    }

    /** 极简内置 toast（不依赖任何 UI 服务）。限宽 + 自动换行，显示时长随文案伸缩。 */
    function toast(text, ok) {
      try {
        var el = document.createElement('div')
        el.textContent = text
        el.style.cssText =
          'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;' +
          'max-width:min(80vw,720px);white-space:pre-wrap;word-break:break-word;text-align:center;' +
          'padding:10px 18px;border-radius:10px;font-size:13px;line-height:1.5;color:#fff;' +
          'background:' + (ok ? 'rgba(46,110,46,.97)' : 'rgba(168,56,56,.97)') + ';' +
          'box-shadow:0 6px 20px rgba(0,0,0,.3);'
        document.body.appendChild(el)
        var show = Math.min(2600 + String(text).length * 40, 9000)
        setTimeout(function () {
          el.style.transition = 'opacity .3s'
          el.style.opacity = '0'
          setTimeout(function () { el.remove() }, 320)
        }, show)
      } catch (e) {
        console.warn('[dsh-session-deleter] toast failed', e)
      }
    }

    /** 主面板正在查看的会话 id（当前对话红线）；子 agent 视图返回其宿主会话；未知返回 null。 */
    function viewedSessionId(ctx) {
      try {
        var uw = ctx.get('uiWorkspace')
        var snap = uw && uw.selection && typeof uw.selection.getSnapshot === 'function' ? uw.selection.getSnapshot() : null
        if (!snap) return null
        if (typeof snap.sessionId === 'string' && snap.sessionId) return snap.sessionId
        if (typeof snap.subagentAddress === 'string' && snap.subagentAddress) {
          var m = snap.subagentAddress.match(/^session-[0-9a-f-]+/i)
          if (m) return m[0]
        }
      } catch (e) { /* 未知：返回 null，交由确认框兜底 */ }
      return null
    }

    function apply(ctx) {
      // 1) 字典
      ctx.effect(
        () => ctx.locale.register(NS, { zh: zh, en: en }),
        'session-deleter: dictionaries',
      )
      var t = ctx.locale.bind(NS)

      // 2) 右键菜单项
      ctx.effect(() =>
        ctx.contextMenus.register({
          id: 'session.delete',
          target: 'session',
          order: 700, // 在内置 archive(600) 之后
          observe: function () {
            return [ctx.locale]
          },
          resolve: function (target) {
            var sessionId = target.sessionId
            // "当前对话"红线：主面板正在查看的会话 → 置灰（不可点）
            var isViewed = viewedSessionId(ctx) === sessionId
            return [
              {
                id: 'delete',
                label: t('menu.delete'),
                danger: true,
                disabled: isViewed,
                separatorBefore: true,
                afterContent: true,
                run: function () {
                  return deleteSession(target)
                },
              },
            ]
          },
        }),
        'session-deleter: context menu',
      )

      async function deleteSession(target) {
        var sessionId = target.sessionId
        var title = (target.displayTitle || sessionId).slice(0, 40)
        // 红线兜底：当前正在查看的会话不可删（菜单已置灰，这里防竞态）
        if (viewedSessionId(ctx) === sessionId) {
          toast(t('error.current'), false)
          return
        }
        var confirmed = window.confirm(
          t('confirm.title') + '\n\n' + t('confirm.desc') + '\n\n「' + title + '」',
        )
        if (!confirmed) return
        var result = await call('deleteSession', { sessionId: sessionId })
        if (result === null) return
        if (result.ok) {
          // 主机端 v0.3.0 起把"软提示"(warnings) 与"硬失败"(errors) 分开返回。
          // 部分失败必须明示，不能报"已删除"误导用户。
          var v = result.value || {}
          if (Array.isArray(v.errors) && v.errors.length) {
            toast(t('error.partial').replace('%s', v.errors.join('、')), false)
            return
          }
          // 成功即"已删除"。宿主会在下次启动自动清掉退出时可能重写的孤儿投影行，
          // 用户无需任何后续操作（不要再提示"重启再删一遍"——会话已不可见，无从右键）。
          toast(t('success.deleted') + '：' + title, true)
          return
        }
        // 未找到任何痕迹时，尝试清理可能的运行中 GUI 写回残留
        if (result.error && result.error.code === 'session/not-found') {
          var purged = await call('purgeSession', { sessionId: sessionId })
          if (purged && purged.ok) {
            toast(t('success.purged') + '：' + title, true)
            return
          }
        }
        toast(t('error.failed') + '：' + (result.error && result.error.message ? result.error.message : 'unknown'), false)
      }

      function call(method, payload) {
        var connection = ctx.get('connection')
        if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
          toast('RPC 通道不可用（连接未就绪）', false)
          return Promise.resolve(null)
        }
        // 主机端参数 wire 字段是 request（见 manifest），故按 { args: { request: ... } } 发送。
        return connection.rpc
          .call('/api', 'sessionDeleter/' + method, { args: { request: payload } })
          .catch(function (error) {
            toast('RPC 调用失败：' + (error && error.message ? error.message : String(error)), false)
            return null
          })
      }
    }

    exports.apply = apply
    exports.name = 'dsh-session-deleter-client'
    exports.inject = ['contextMenus', 'locale', 'connection']
    return module.exports
  },
})
