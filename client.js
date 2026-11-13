/**
 * dsh-session-save (Client half)
 *
 * A header utility button next to the Session title. First press asks where to
 * save, later presses overwrite the same `.dsproj` file without a dialog.
 * Shift-click forces the picker again.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-save',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;

    const SLOT = 'conversation.session.header.utilities';
    const SLOT_HERO = 'conversation.hero.options';
    const ROUTE = 'api/session.save';
    const SAVE_ROUTE = ROUTE;
    const OPEN_ROUTE = 'api/session.open';
    const AUTOSAVE_ROUTE = 'api/session.autosave';
    const WORKSPACES_ROUTE = 'api/session.workspaces';

    // 跳到一个刚导入的会话。DSH 的 sessions 服务只提供 refresh() / retain()，
// 没有「这个 id 在不在」的查询方法（sessions.get 不存在），所以不能先问再跳：
// 直接试一次，retain() 不认识它就抛 `sessions.retain: unknown session`，
// 这时刷新一次索引、稍等一下再试。其它错误不重试，原样交回。
async function jumpWhenReady(host, sessionId, options = {}) {
  const ui = host?.uiWorkspace;
  if (ui === undefined || ui === null || typeof ui.openSession !== 'function') {
    return { jumped: false, error: new Error('uiWorkspace.openSession 不可用') };
  }
  const attempts = Number.isFinite(options.attempts) ? options.attempts : 12;
  const delay = Number.isFinite(options.delay) ? options.delay : 150;
  const wait = typeof options.wait === 'function'
    ? options.wait
    : (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  let lastUnknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      ui.openSession(sessionId);
      return { jumped: true };
    } catch (error) {
      const text = String(error && error.message ? error.message : error);
      if (!/unknown session/i.test(text)) return { jumped: false, error };
      lastUnknown = error;
    }
    try { await host?.sessions?.refresh?.(); } catch { /* 刷新失败就再等一轮 */ }
    await wait(delay);
  }
  return { jumped: false, unknown: lastUnknown };
}

const ZH = {
      button: '保存会话',
      buttonHint: '保存',
      saving: '正在保存…',
      ask: '另存为',
      askHint: '选择保存位置',
      confirm: '保存',
      cancel: '取消',
      saved: '已保存',
      savedMemory: '个记忆文件',
      cancelled: '已取消',
      remoteDownload: '已交给浏览器下载',
      remoteNoInput: '浏览器没有给出文件选择框，请刷新页面再试',
      remoteSaveTitle: '下载这个会话到本机',
      failed: '保存失败',
      openButton: '打开会话',
      openButtonHint: '打开',
      opening: '正在打开…',
      opened: '已打开',
      openFailed: '打开失败',
      listRefreshHint: '，会话索引还没跟上，稍等片刻它就会出现在左侧列表里',
      archiveRestored: '已从归档里恢复',
      openPath: '打开会话工程',
      openPathHint: '输入 .dsproj 的完整路径',
      openConfirm: '打开',
      conflictTitle: '该会话在本机已存在',
      conflictHint: '包内会话与本机同 id 的会话不是同一段对话，请选择处理方式。',
      conflictLocal: '本机现有',
      conflictIncoming: '包内',
      conflictTitleField: '标题',
      conflictCreated: '创建时间',
      conflictSize: '体积',
      conflictCwd: '工作区',
      conflictFrom: '导出机器',
      conflictId: '两次保存的 id 相同，同一 id 仅保留一份会话；「另存为副本」会为包内会话分配新 id。',
      conflictReuse: '保留本机',
      conflictOverwrite: '用包内会话覆盖本机',
      conflictCopy: '另存为副本',
      autosave: '自动保存',
      autosaveOn: '自动保存已开启',
      autosaveOff: '自动保存已关闭',
      autosaveOnHint: '自动保存已开启（点击关闭）',
      autosaveOffHint: '自动保存已关闭（点击开启）',
      autosaveAsk: '请先指定保存位置',
      autosaveAskHint: '自动保存需要一个固定文件，之后每次写入将覆盖该文件',
      locked: '文件被占用',
      saveAs: '另存为',
      saveAsHint: '另存为',
      saveAsSaved: '已另存为',
      wsBadTitle: '原工作区不可用，换一个位置打开',
      wsBadMissing: '包内记录的工作区路径在本机不存在：{path}',
      wsBadNotDir: '包内记录的工作区路径在本机是文件而不是目录：{path}',
      wsReplaceFile: '把那个文件改名备份，在原处建文件夹',
      wsReplaceHint: '{path} 会改名成 {path}.bak-<时间戳>，不删除',
      lockedTitle: '这个文件正被另一个窗口写入',
      lockedHint: '现在保存可能覆盖它刚写的内容。确认那个窗口已经存完，再选「仍然保存」。',
      lockedForce: '仍然保存',
      brokenTitle: '这个包打不开',
      brokenHint: '包内结构校验没过。可以把下面的说明整段复制给任意 AI，让它把包修好；或者丢掉校验不通过的条目直接打开——会话日志以外的内容可能少一部分。',
      brokenCopy: '复制说明',
      brokenCopied: '已复制到剪贴板',
      brokenRepair: '丢掉坏条目后打开',
      brokenCount: '已按校验结果丢掉 {n} 个条目',
      brokenNoPrompt: '（这段说明没能生成，请把报错原文抄给 AI）',
      wsBadCreate: '在这里新建文件夹并继续',
      wsBadCreateHint: '会新建一个空文件夹 {path}，然后把会话放进去。',
      wsBadCreateFailed: '新建文件夹失败：{reason}',
      wsTitle: '打开到哪个工作区',
      wsHint: '本机没有该会话，请指定一个工作区。',
      wsOriginal: '包内原工作区',
      wsPick: '选择其他目录…',
      wsEmpty: '尚无工作区，请选择一个目录。',
      wsMissing: '（本机没有该目录）',
      wsCancel: '取消',
      staleTitle: '目标文件已被外部修改',
      staleHint: '磁盘上的内容已不是本机上次写入的版本（可能由另一台机器、同步盘或手动替换导致）。覆盖将丢失这些改动。',
      staleSince: '本机上次写入',
      staleNow: '当前磁盘内容',
      staleOverwrite: '覆盖磁盘文件',
      staleSaveAs: '另存为新文件',
      cloudWarn: '该目录位于 {name}：多台机器同时启用自动保存会互相覆盖，建议仅在一台机器上写入。',
      cloudTag: '同步盘',
      confirmOverwrite: '该位置已存在文件',
      confirmOverwriteHint: '该文件不是本会话记录的工程文件，覆盖将丢失其原有内容。',
      confirmOverwriteAlt: '选择其他位置另存为',
      notDsproj: '目标文件不是 .dsproj 工程包，无法覆盖',
      missingTarget: '上次保存的文件不存在',
      missingTargetHint: '该位置原有一份工程包，当前无法读取（已被删除、移动，或所在磁盘未挂载）。继续保存将在该位置新建同名文件，原文件内容将丢失。',
      missingTargetRecreate: '在该位置新建',
      missingTargetSaveAs: '另存到其他位置',
      backupKeep: '覆盖前先备份原文件',
      missingAutoOff: '自动保存已停用：目标文件不存在',
      repairHint: '打开前检查：',
      contextTrimmed: '{n} 轮更早的对话没有进入上下文（完整日志仍在工程包里）',
      repairMissing: '{n} 张图片的原始数据不在本机，已替换为文字占位',
      repairPatched: '{n} 张图片缺少尺寸信息，已按文件头补全',
      repairLines: '{n} 行日志无法解析，已跳过',
      repairFrames: '{n} 帧日志无法解码，已原样保留',
      attachRejected: '{n} 个附件因体积或数量超限未写入',
      pathNotAllowed: '仅可保存到已使用的目录，或通过另存为窗口指定位置',
      memoryHint: 'Alt 点击：连同工作区记忆一起打包',
      memoryTag: '含记忆',
      memoryCopiesHint: ' 个记忆文件已作为副本写入（未生效）',
      memoryConflictsHint: ' 个与本机已有记忆重名',
      memoryRestoredHint: ' 个记忆文件已写回原位',
      memoryNoticeTitle: '记忆仅写入副本',
      memoryNoticeBody: '包内工作区记忆已存为带来源后缀的副本，DSH 不会读取。如需生效，请使用「合并记忆」：仅覆盖本机已有的同名文件，覆盖前自动备份。若该包并非本人导出，请直接关闭：包内记忆会被 DSH 当作项目笔记读入上下文。写入位置由包内记录的 cwd 决定，与当前打开的工作区无关。',
      memoryOpenDir: '打开记忆目录',
      memoryDirLabel: '记忆目录',
      memoryMergeTarget: '记忆将写入上方显示的记忆目录，而非当前打开的工作区',
      memoryForeignNote: '这个包记录的是另一个工作区（{slug}）的记忆：下面列出的文件会写进那个工作区的记忆目录，不是当前打开的工作区。',
      memoryMerge: '合并记忆',
      memoryMergeTitle: '将包内记忆合并到本机',
      memoryMergeHint: '合并仅覆盖本机已有的同名文件，覆盖前每个文件将备份为 .bak-<时间>。若该包并非本人导出，请取消：包内记忆会被 DSH 当作项目笔记读入上下文。',
      memoryMergeMore: '还有 {n} 个',
      memoryMergeConfirm: '合并已有',
      memoryMergeOverwrite: '将覆盖',
      memoryMergeCreate: '将新建（本机没有）',
      memoryMergeCreateHint: '以下文件本机不存在，默认不写入：包内记忆可能并非本人所有，新建后 DSH 将直接读取。确认为本人导出的包后，再选择「合并并新建」。',
      memoryMergeWithNew: '合并并新建',
      memoryMergeNoOverwrite: '没有需要覆盖的文件',
      memoryCreatedHint: ' 个新文件未写入',
      memoryNewHint: ' 个已写回原位（含新建）',
    };
    /**
     * 运行时文案表。内置中文兜底，启动后再从 `/api/session.locales` 拉浏览器语言
     * 对应的 `locales/<tag>.json` 就地覆盖——缺的键自然还是中文，所以翻译可以分批发。
     *
     * 就地 `Object.assign` 而不是换引用：`L.xxx` 在几百处被直接读，换引用等于整体重写。
     * 代价是首帧按中文渲染、拿到语言包后下一帧才变——一次同源请求，肉眼看不到。
     */
    const L = { ...ZH };
    /** 当前生效的语言标签，仅用于调试与排错。 */
    let localeTag = 'zh-CN';

    const COLORS = {
      label: 'var(--dsw-alias-label-primary, #16181d)',
      secondary: 'var(--dsw-alias-label-secondary, #6b7280)',
      border: 'var(--dsw-alias-border-secondary, rgba(0,0,0,0.12))',
      elevated: 'var(--dsw-alias-bg-elevated, #ffffff)',
      accent: 'var(--dsw-alias-bg-accent, #3b6cf6)',
      accentLabel: 'var(--dsw-alias-label-on-accent, #ffffff)',
      danger: 'var(--dsw-alias-label-danger, #d92d20)',
      ok: 'var(--dsw-alias-label-success, #067647)',
      radius: 'var(--dsw-alias-radius-md, 8px)',
    };

    function FloppyIcon({ size = 15 }) {
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M2.5 2.5h8L13.5 5.5v8h-11z' }),
        React.createElement('path', { d: 'M5 2.5h5v3.5H5z' }),
        React.createElement('rect', { x: 4.5, y: 9, width: 7, height: 4.5 }),
      );
    }

    /** 软盘 + 铅笔：另存为（Save As）。 */
    function SaveAsIcon({ size = 15 }) {
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M2.5 2.5h8l3 3v3' }),
        React.createElement('path', { d: 'M2.5 2.5v11h4.4' }),
        React.createElement('path', { d: 'M5.1 2.5h4.4V6H5.1z' }),
        React.createElement('path', { d: 'M9.6 13.9l.4-1.9 3.4-3.4 1.5 1.5-3.4 3.4z' }),
      );
    }

    function FolderIcon({ size = 15 }) {
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M2 4.6h4.1L7.5 6.4H14v6.1H2z' }),
        React.createElement('path', { d: 'M2 4.6V3.1h3.3l1.2 1.5' }),
      );
    }

    function SyncIcon({ size = 15, active = false }) {
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M13 6.2A5.2 5.2 0 0 0 3.6 4.4' }),
        React.createElement('path', { d: 'M3 8.4A5.2 5.2 0 0 0 12.4 10.2' }),
        React.createElement('path', { d: 'M13 2.6v3.6h-3.6' }),
        React.createElement('path', { d: 'M3 13.4V9.8h3.6' }),
        active ? React.createElement('circle', { cx: 8, cy: 8, r: 1.6, fill: 'currentColor', stroke: 'none' }) : null,
      );
    }

    function Spinner() {
      return React.createElement(
        'span',
        {
          style: {
            display: 'inline-block',
            width: 12,
            height: 12,
            borderRadius: '50%',
            border: '2px solid currentColor',
            borderTopColor: 'transparent',
            animation: 'dshss-spin 0.8s linear infinite',
          },
          'aria-hidden': 'true',
        },
        null,
      );
    }

    function Toast({ tone, text, onDone }) {
      useEffect(() => {
        const timer = setTimeout(onDone, 3200);
        return () => clearTimeout(timer);
      }, [onDone]);
      const color = tone === 'error' ? COLORS.danger : tone === 'ok' ? COLORS.ok : COLORS.secondary;
      return React.createElement(
        'div',
        {
          role: 'status',
          style: {
            position: 'fixed',
            right: 18,
            bottom: 18,
            zIndex: 9999,
            maxWidth: 420,
            padding: '8px 12px',
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            background: COLORS.elevated,
            color,
            border: `1px solid ${COLORS.border}`,
            borderRadius: COLORS.radius,
            boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
            fontSize: 12.5,
            lineHeight: 1.45,
            wordBreak: 'break-all',
          },
        },
        text,
      );
    }

    function AskPanel({ suggested, busy, title, hint, confirmLabel, onConfirm, onCancel }) {
      const [value, setValue] = useState(suggested || '');
      const inputRef = useRef(null);
      useEffect(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          const dot = value.lastIndexOf('.');
          if (dot > 0) inputRef.current.setSelectionRange(0, dot);
        }
        // 只在首次挂载时聚焦
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      const submit = () => {
        if (!busy && value.trim() !== '') onConfirm(value.trim());
      };
      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 9998,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15,17,22,0.32)',
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel();
          },
        },
        React.createElement(
          'div',
          {
            style: {
              width: 520,
              maxWidth: '90vw',
              padding: 18,
              background: COLORS.elevated,
              border: `1px solid ${COLORS.border}`,
              borderRadius: COLORS.radius,
              boxShadow: '0 24px 60px rgba(0,0,0,0.24)',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              color: COLORS.label,
            },
          },
          React.createElement('div', { style: { fontSize: 13.5, fontWeight: 600 } }, title || L.ask),
          React.createElement('div', { style: { fontSize: 12, color: COLORS.secondary } }, hint || L.askHint),
          React.createElement('input', {
            ref: inputRef,
            value,
            spellCheck: false,
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit();
              if (event.key === 'Escape' && !busy) onCancel();
            },
            style: {
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 10px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: COLORS.label,
              background: COLORS.elevated,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 6,
              outline: 'none',
            },
          }),
          React.createElement(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: onCancel,
                style: {
                  padding: '6px 12px',
                  fontSize: 12.5,
                  fontFamily: 'inherit',
                  color: COLORS.secondary,
                  background: 'transparent',
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 6,
                  cursor: busy ? 'default' : 'pointer',
                },
              },
              L.cancel,
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: submit,
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 14px',
                  fontSize: 12.5,
                  fontFamily: 'inherit',
                  color: COLORS.accentLabel,
                  background: COLORS.accent,
                  border: 'none',
                  borderRadius: 6,
                  cursor: busy ? 'default' : 'pointer',
                },
              },
              busy ? React.createElement(Spinner, null) : null,
              confirmLabel || L.confirm,
            ),
          ),
        ),
      );
    }

    function SaveButton(props) {
      const sessionId = props.sessionId;
      const alwaysAsk = Boolean(props && props.alwaysAsk);
      const [busy, setBusy] = useState(false);
      const [ask, setAsk] = useState(null); // { suggested }
      const [stale, setStale] = useState(null); // { path, stale, cloud }
      const [refuse, setRefuse] = useState(null); // { status, path, message }
      const [missing, setMissing] = useState(null); // { path, name, dir }
      const [lockedTo, setLockedTo] = useState(null); // 别的窗口正在写这个文件
      const [toast, setToast] = useState(null); // { tone, text }
      const [lastPath, setLastPath] = useState('');
      const mounted = useRef(true);

      useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      const call = useCallback(
        async (params) => {
          const search = new URLSearchParams({ sessionId: String(sessionId), ...params });
          const response = await fetch(`${ROUTE}?${search.toString()}`, {
            method: 'GET',
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          });
          const text = await response.text();
          let payload;
          try {
            payload = JSON.parse(text);
          } catch {
            throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
          }
          return payload;
        },
        [sessionId],
      );

      const save = useCallback(
        async (extra = {}, keepPanel = false) => {
          if (isRemoteHost() === true) {
            // 远程访问：服务端只打包、不落盘，文件由浏览器收下。
            // 用 window.open 而不是 fetch——这条响应是二进制附件，不该进 JSON 解析。
            const search = new URLSearchParams({
              sessionId: String(sessionId),
              mode: 'auto',
              deliver: 'download',
              ...extra,
            });
            window.open(`${ROUTE}?${search.toString()}`, '_blank');
            setToast({ tone: 'info', text: L.remoteDownload });
            return;
          }
          setBusy(true);
          try {
            const payload = await call({ mode: 'auto', ...extra });
            if (!mounted.current) return;
            if (payload.status === 'saved') {
              setAsk(null);
              setStale(null);
              setLastPath(payload.path || '');
              const cloud = payload.cloud === undefined || payload.cloud === null
                ? ''
                : ` · ${String(L.cloudWarn).replace('{name}', payload.cloud)}`;
              setToast({
                tone: payload.cloud === undefined || payload.cloud === null ? 'ok' : 'info',
                text: `${alwaysAsk ? L.saveAsSaved : L.saved} · ${payload.name || payload.path}${cloud}`,
              });
              return;
            }
            if (payload.status === 'cancelled') {
              setAsk(null);
              setToast({ tone: 'info', text: L.cancelled });
              return;
            }
            if (payload.status === 'need-path') {
              setAsk({ suggested: payload.suggested || '' });
              if (keepPanel) setToast(null);
              return;
            }
            if (payload.status === 'stale') {
              setAsk(null);
              setStale(payload);
              return;
            }
            // 文件正被另一个窗口写着：默认先等；等过还是占用就问用户要不要强行存。
            // 强行存只跳过锁，stale 之类的数据保护一个都不少。
            if (payload.status === 'locked' && payload.canIgnoreLock === true) {
              setAsk(null);
              setLockedTo(payload);
              return;
            }
            // 目标位置已有一个「不是本会话记住的那个」文件，或者它不是工程包：
            // 服务端拒绝直接覆盖，这里给用户一条手动出路（换位置另存为）。
            if (payload.status === 'confirm-overwrite' || payload.status === 'not-dsproj') {
              setAsk(null);
              setRefuse(payload);
              return;
            }
            // 记住的位置上文件没了：不静默落盘，交给用户决定「另存」还是「就在这里新建」。
            if (payload.status === 'missing-target') {
              setAsk(null);
              setMissing(payload);
              return;
            }
            setToast({ tone: 'error', text: `${L.failed} · ${payload.message || 'unknown'}` });
          } catch (error) {
            if (mounted.current) setToast({ tone: 'error', text: `${L.failed} · ${String(error && error.message ? error.message : error)}` });
          } finally {
            if (mounted.current) setBusy(false);
          }
        },
        [call, alwaysAsk],
      );

      const onClick = useCallback(
        (event) => {
          if (busy) return;
          // Shift / Cmd = 另存为；Alt = 连同工作区记忆一起打包（都弹窗口，位置由用户定）。
          const ask = Boolean(event && (event.shiftKey || event.metaKey));
          const memory = Boolean(event && event.altKey);
          // 「另存为」按钮本身就是 alwaysAsk；Alt 也要先选位置，所以两者都带 ask=1。
          const wantAsk = alwaysAsk || ask || memory;
          const extra = wantAsk ? { ask: '1', ...(memory ? { memory: '1' } : {}) } : {};
          save(extra);
        },
        [busy, save, alwaysAsk],
      );

      const children = [
        React.createElement('style', {
          key: 'style',
          children: '@keyframes dshss-spin{to{transform:rotate(360deg)}}',
        }),
      ];

      children.push(
        React.createElement(
          'button',
          {
            key: 'button',
            type: 'button',
            onClick,
            disabled: busy,
            title: isRemoteHost() === true
              ? L.remoteSaveTitle
              : alwaysAsk
                ? L.saveAsHint
                : lastPath === ''
                  ? L.buttonHint
                  : `${L.button} → ${lastPath}`,
            'aria-label': alwaysAsk ? L.saveAs : L.button,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              width: 28,
              height: 28,
              padding: 0,
              color: COLORS.secondary,
              background: 'transparent',
              border: 'none',
              borderRadius: 6,
              cursor: busy ? 'progress' : 'pointer',
              transition: 'color 120ms ease, background-color 120ms ease',
            },
            onMouseEnter: (event) => {
              event.currentTarget.style.color = COLORS.label;
              event.currentTarget.style.backgroundColor = 'var(--dsw-alias-bg-hover, rgba(0,0,0,0.05))';
            },
            onMouseLeave: (event) => {
              event.currentTarget.style.color = COLORS.secondary;
              event.currentTarget.style.backgroundColor = 'transparent';
            },
          },
          busy
            ? React.createElement(Spinner, null)
            : alwaysAsk
              ? React.createElement(SaveAsIcon, null)
              : React.createElement(FloppyIcon, null),
        ),
      );

      if (ask !== null) {
        children.push(
          React.createElement(AskPanel, {
            key: 'ask',
            suggested: ask.suggested,
            busy,
            onConfirm: (value) => save({ path: value }, true),
            onCancel: () => {
              setAsk(null);
              setToast({ tone: 'info', text: L.cancelled });
            },
          }),
        );
      }

      if (stale !== null) {
        children.push(
          React.createElement(StaleModal, {
            key: 'stale',
            payload: stale,
            busy,
            onOverwrite: (keep) => save({ force: '1', backup: keep === false ? '0' : '1' }),
            onSaveAs: () => save({ ask: '1' }),
            onCancel: () => {
              setStale(null);
              setToast({ tone: 'info', text: L.cancelled });
            },
          }),
        );
      }

      if (toast !== null) {
        children.push(
          React.createElement(Toast, {
            key: 'toast',
            tone: toast.tone,
            text: toast.text,
            onDone: () => {
              if (mounted.current) setToast(null);
            },
          }),
        );
      }

      if (lockedTo !== null) {
        children.push(
          React.createElement(LockedModal, {
            key: 'locked',
            payload: lockedTo,
            busy,
            onForce: () => {
              setLockedTo(null);
              save({ ignoreLock: '1' }, true);
            },
            onCancel: () => {
              setLockedTo(null);
              setToast({ tone: 'info', text: L.cancelled });
            },
          }),
        );
      }

      if (missing !== null) {
        children.push(
          React.createElement(MissingModal, {
            key: 'missing',
            payload: missing,
            busy,
            onSaveAs: () => {
              setMissing(null);
              save({ ask: '1' });
            },
            onRecreate: () => {
              setMissing(null);
              save({ mode: 'auto', recreate: '1' }, true);
            },
            onCancel: () => {
              setMissing(null);
              setToast({ tone: 'info', text: L.cancelled });
            },
          }),
        );
      }

      if (refuse !== null) {
        children.push(
          React.createElement(RefuseModal, {
            key: 'refuse',
            payload: refuse,
            busy,
            onSaveAs: () => {
              setRefuse(null);
              save({ ask: '1' });
            },
            onCancel: () => {
              setRefuse(null);
              setToast({ tone: 'info', text: L.cancelled });
            },
          }),
        );
      }

      return React.createElement(React.Fragment, null, ...children);
    }

    /** 「另存为」独立图标按钮：复用同一套保存逻辑，只是每次都强制弹对话框。 */
    function SaveAsButton(props) {
      return React.createElement(SaveButton, {
        sessionId: props && props.sessionId,
        alwaysAsk: true,
      });
    }

    const LOCALES_ROUTE = 'api/session.locales';

    /**
     * 拉一次语言包。浏览器语言先原样丢给 Host，由它决定最终落到哪个
     * `locales/<tag>.json`（Host 只从目录清单里挑，不按字符串拼路径）。
     * 失败就当没这回事：内置中文照常用，功能不受影响。
     */
    async function loadLocale() {
      let wanted = '';
      try {
        if (typeof navigator === 'object' && typeof navigator.language === 'string') wanted = navigator.language;
      } catch {
        wanted = '';
      }
      try {
        const data = await requestJson(LOCALES_ROUTE, { lang: wanted });
        if (data !== null && typeof data === 'object' && data.status === 'ok' && data.messages !== null && typeof data.messages === 'object') {
          Object.assign(L, data.messages);
          if (typeof data.lang === 'string' && data.lang !== '') localeTag = data.lang;
        }
      } catch {
        // 拿不到语言包不是错误：中文兜底已经在 L 里了。
      }
    }

    /* ── 请求层 ── */
    /**
     * 页面是不是从非回环地址打开的（内网 IP、域名、反向代理）。
     * 这种情况服务端拿不到用户机器上的文件路径，原生另存为窗口也弹在服务端那台
     * 机器上——所以保存改成浏览器下载，打开改成浏览器上传。
     */
    function isRemoteHost() {
      try {
        const name = String(window.location.hostname || '').toLowerCase();
        if (name === '') return false;
        if (name === 'localhost' || name === '::1' || name === '[::1]') return false;
        if (name.indexOf('127.') === 0) return false;
        return true;
      } catch {
        return false;
      }
    }

    async function requestJson(route, params, init = undefined) {
      const search = new URLSearchParams(params);
      const extra = init === undefined ? {} : init;
      const response = await fetch(`${route}?${search.toString()}`, {
        method: extra.method === undefined ? 'GET' : extra.method,
        headers: extra.headers === undefined ? { accept: 'application/json' } : extra.headers,
        body: extra.body,
        credentials: 'same-origin',
      });
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
    }

    /* ── 打开流程（标题栏按钮与空会话页面按钮共用一套状态机） ── */

    function useOpenFlow() {
      const [busy, setBusy] = useState(false);
      const [ask, setAsk] = useState(null); // { suggested }
      const [conflict, setConflict] = useState(null); // 冲突详情
      const [workspace, setWorkspace] = useState(null); // 本机没有 → 问落点
      const [broken, setBroken] = useState(null); // 包结构校验没过 → 给可复制的说明
      const [notice, setNotice] = useState(null); // 记忆只落了副本 → 留个面板让人去合并
      const [merge, setMerge] = useState(null); // 合并确认弹窗的载荷
      const [toast, setToast] = useState(null); // { tone, text }
      const mounted = useRef(true);
      // 远程访问时选文件只能用 React 渲染出来的 input：组件里不许碰 document（红线 5）。
      const fileRef = useRef(null);
      // 选文件是异步的（用户可能挑很久），这中间弹窗那边的选择要沿用，所以先存着。
      const pending = useRef({});
      // 远程模式下选中的那个 File。导入要分好几步（选工作区、选冲突策略、修包），
      // 每一步都要「同一个文件的字节」，但服务端的临时包在上传结束时就删了，
      // 路径不能复用——只能把 File 留在内存里，后续步骤重发字节，不再弹一次文件框。
      const remoteFile = useRef(null);

      useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      const jump = useCallback(async (payload) => {
        const label = payload.title ? String(payload.title) : String(payload.sessionId);
        // 打开时就告诉用户两件会引起来回覆盖的事：文件正被别的机器写、或它躺在同步盘里。
        const cloud = payload.cloud === undefined || payload.cloud === null
          ? ''
          : ` · ${String(L.cloudWarn).replace('{name}', payload.cloud)}`;
        const warning = typeof payload.warning === 'string' && payload.warning !== '' ? ` · ${payload.warning}` : '';
        // 记忆落盘结果必须说出来：副本不会生效，用户不点「合并记忆」就一直读不到。
        // 三种模式说法不同——restore 可能还有一批「本机没有、没写」的文件，那是用户
        // 唯一能察觉到「包里还有东西没落地」的地方，不能并进「已写回」里含糊过去。
        const mode = payload.memoryMode;
        const restored = mode === 'restore';
        const created = mode === 'new';
        const written = Number(payload.memoryWritten) || 0;
        const pendingCreated = Array.isArray(payload.memoryCreated) ? payload.memoryCreated.length : 0;
        const clashes = Array.isArray(payload.memoryConflicts) ? payload.memoryConflicts.length : 0;
        const memory = written > 0
          ? ` · ${written}${created ? L.memoryNewHint : restored ? L.memoryRestoredHint : L.memoryCopiesHint}`
          : '';
        const createdText = pendingCreated > 0 ? ` · ${pendingCreated}${L.memoryCreatedHint}` : '';
        const clashText = clashes > 0 ? ` · ${clashes}${L.memoryConflictsHint}` : '';
        // 打开前体检改了什么必须说出来——用户下次打开看到的是一份不同的会话，
        // 不解释就成了「我的图怎么没了」。只报改过的项，没改就一个字不说。
        const repair = payload.repair;
        const repairNotes = [];
        if (repair !== undefined && repair !== null && repair.changed === true) {
          const dropped = Number(repair.parts?.dropped) || 0;
          const patched = Number(repair.parts?.patched) || 0;
          const lostLines = Number(repair.lines?.dropped) || 0;
          const brokenFrames = Number(repair.frames?.broken) || 0;
          if (dropped > 0) repairNotes.push(String(L.repairMissing).replace('{n}', dropped));
          if (patched > 0) repairNotes.push(String(L.repairPatched).replace('{n}', patched));
          if (lostLines > 0) repairNotes.push(String(L.repairLines).replace('{n}', lostLines));
          if (brokenFrames > 0) repairNotes.push(String(L.repairFrames).replace('{n}', brokenFrames));
        }
        const repairText =
          repairNotes.length > 0 ? ` · ${L.repairHint}${repairNotes.join('，')}` : '';
        // 按上下文预算裁过就得说：不说清，用户会以为聊天记录被吃了。
        const contextTrim = payload.context?.trim;
        const contextText =
          contextTrim !== undefined && contextTrim !== null && contextTrim.trimmed === true
            ? ` · ${String(L.contextTrimmed).replace('{n}', Number(contextTrim.droppedTurns) || 0)}`
            : '';
        // 被配额拦下的附件必须说出来：附件对象库没有 GC，不说等于悄悄吞掉用户包里的图。
        // 但「回填了 N 张」是正常路径，天天往 toast 里塞会变成噪音，所以只报被拦的那部分。
        const attachRejected = Number(payload.attachmentsRejected) || 0;
        const attachText =
          attachRejected > 0 ? ` · ${String(L.attachRejected).replace('{n}', attachRejected)}` : '';
        // 会话原先在归档集合里：那不是「打不开」，是被挡在唤醒名单外。说一句，用户才不会
        // 以为这个包本身有问题。
        const archiveText = payload.archive?.unarchived === true ? ` · ${L.archiveRestored}` : '';
        // 只要还有没生效的东西，就把面板留在界面上：copy 是「全是副本」，restore 是
        // 「有文件没写」。new 表示用户已经明确同意全写，不再提示。
        setNotice(!created && (written > 0 || pendingCreated > 0) ? payload : null);
        setToast({
          tone:
            warning !== '' || cloud !== '' || repairNotes.length > 0 || attachRejected > 0 || contextText !== '' || archiveText !== '' || (!created && (written > 0 || pendingCreated > 0))
              ? 'info'
              : 'ok',
          text: `${L.opened} · ${label}${warning}${cloud}${memory}${createdText}${clashText}${repairText}${attachText}${contextText}${archiveText}`,
        });
        try {
          await host?.sessions?.refresh?.();
        } catch {
          /* 索引刷新失败不阻断打开 */
        }
        // refresh() 只是把 session.list 发起一次，索引落进 sessions/summaries 要晚一拍。
        // 立刻 openSession 会撞上 DSH 的 `sessions.retain: unknown session`，文件其实已经导好了。
        // sessions 服务没有 get(id) 这种查询方法，所以只能真跳一次、跳不动再刷新重试。
        const outcome = await jumpWhenReady(host, payload.sessionId);
        if (outcome.jumped === true) return;
        if (outcome.error !== undefined) {
          setToast({ tone: 'error', text: `${L.openFailed} · ${String(outcome.error && outcome.error.message ? outcome.error.message : outcome.error)}` });
          return;
        }
        // 一直卡在「索引不认识」：包已经落盘了，只是这一跳跳不过去。
        setToast({ tone: 'info', text: `${L.opened} · ${label}${L.listRefreshHint}${archiveText}` });
      }, []);

      /** 把服务端结果分发到对应弹窗／提示。本地路径和远程上传两条入口共用。 */
      const applyPayload = useCallback(
        async (payload) => {
          if (!mounted.current) return;

          if (payload.status === 'opened') {
            setAsk(null);
            setConflict(null);
            setWorkspace(null);
            await jump(payload);
            return;
          }
          if (payload.status === 'conflict') {
            setWorkspace(null);
            setConflict(payload);
            return;
          }
          if (payload.status === 'need-workspace') {
            setAsk(null);
            setConflict(null);
            setWorkspace(payload);
            return;
          }
          if (payload.status === 'bad-workspace') {
            // 原工作区在本机不可用（不存在，或是个文件）。只弹一行错误等于把路堵死：
            // 用户既不知道是哪个路径，也没有任何下一步可点。这里复用「打开到哪个工作区」
            // 那个弹窗，列出本机可用工作区，选一个就能继续，并先说明原路径为什么不能用。
            setAsk(null);
            setConflict(null);
            setWorkspace(payload);
            return;
          }
          if (payload.status === 'package-broken') {
            // 包坏了不是「再试一次」能解决的：要么把说明交给 AI 修，要么按宽松模式
            // 丢掉校验不过的条目先打开。两条路都得用户自己选，别替他决定丢数据。
            setAsk(null);
            setWorkspace(null);
            setBroken(payload);
            return;
          }
          if (payload.status === 'cancelled') {
            setAsk(null);
            setWorkspace(null);
            setBroken(null);
            setToast({ tone: 'info', text: L.cancelled });
            return;
          }
          if (payload.status === 'need-path') {
            setAsk({ suggested: payload.suggested || '' });
            return;
          }
          if (payload.status === 'too-large') {
            setToast({ tone: 'error', text: payload.message || L.openFailed });
            return;
          }
          setToast({ tone: 'error', text: `${L.openFailed} · ${payload.message || 'unknown'}` });
        },
        [jump],
      );

      /** 把一份字节上传给 Host，由它落成临时包再走同一套导入流程。 */
      const uploadAndOpen = useCallback(
        async (file, extra = {}) => {
          const bytes = await file.arrayBuffer();
          const payload = await requestJson(
            OPEN_ROUTE,
            { upload: '1', mode: 'auto', ...extra },
            {
              method: 'POST',
              headers: { accept: 'application/json', 'content-type': 'application/octet-stream' },
              body: bytes,
            },
          );
          await applyPayload(payload);
        },
        [applyPayload],
      );

      const open = useCallback(
        async (extra = {}) => {
          if (isRemoteHost() === true) {
            // 远程访问：服务端没有用户机器上的路径可给，原生窗口也弹不到用户面前。
            // 分两种情况——首次点「打开」，必须让用户挑文件；之后的每一步
            // （选落点、选冲突策略、修包）都是同一个包，重发内存里那份字节就行。
            // 早先这里不分辨，每步都去点 input，于是选完工作区又弹一次文件框，
            // 而且第二次拿到的路径是服务端早就删掉的临时包，必然失败。
            const followUp = typeof extra.path === 'string' && remoteFile.current !== null;
            if (followUp === false) {
              remoteFile.current = null;
              pending.current = extra;
              const input = fileRef.current;
              if (input === null || input === undefined) {
                setToast({ tone: 'error', text: L.remoteNoInput });
                return;
              }
              input.value = '';
              input.click();
              return;
            }
            // 服务端那个临时路径已经不存在了，别把它传下去；其余参数（cwd、
            // onConflict、backup、createCwd、replaceFile、repairPackage）照传。
            const { path: _discarded, ...rest } = extra;
            setBusy(true);
            try {
              await uploadAndOpen(remoteFile.current, rest);
            } catch (error) {
              if (mounted.current) {
                setToast({
                  tone: 'error',
                  text: `${L.openFailed} · ${String(error && error.message ? error.message : error)}`,
                });
              }
            } finally {
              if (mounted.current) setBusy(false);
            }
            return;
          }
          setBusy(true);
          try {
            const payload = await requestJson(OPEN_ROUTE, { mode: 'auto', ...extra });
            await applyPayload(payload);
          } catch (error) {
            if (mounted.current) {
              setToast({
                tone: 'error',
                text: `${L.openFailed} · ${String(error && error.message ? error.message : error)}`,
              });
            }
          } finally {
            if (mounted.current) setBusy(false);
          }
        },
        [applyPayload],
      );

      /** 远程上传：把选中文件的字节 POST 给 Host，由它落成临时包再走同一套导入流程。 */
      const onFileChange = useCallback(
        async (event) => {
          const input = event && event.target;
          const file = input && input.files && input.files[0];
          if (!file) return;
          // 留着这份 File：后续「选工作区 / 选冲突策略 / 修包」要重发同一份字节。
          remoteFile.current = file;
          setBusy(true);
          try {
            await uploadAndOpen(file, pending.current || {});
          } catch (error) {
            if (mounted.current) {
              setToast({
                tone: 'error',
                text: `${L.openFailed} · ${String(error && error.message ? error.message : error)}`,
              });
            }
          } finally {
            pending.current = {};
            if (input) input.value = '';
            if (mounted.current) setBusy(false);
          }
        },
        [uploadAndOpen],
      );

      return {
        busy,
        ask,
        conflict,
        workspace,
        broken,
        notice,
        merge,
        toast,
        open,
        fileRef,
        onFileChange,
        setAsk,
        setConflict,
        setWorkspace,
        setBroken,
        setNotice,
        setMerge,
        setToast,
        mounted,
      };
    }

    /** AskPanel + 冲突弹窗 + toast，两个入口共用。 */
    function OpenPanels({ flow }) {
      const children = [];
      // 远程访问时唯一的选文件手段：浏览器给的是 File 对象，服务端拿不到路径。
      // 这个 input 必须由 React 渲染出来，组件里不许碰 document（红线 5）。
      if (flow.fileRef !== undefined) {
        children.push(
          React.createElement('input', {
            key: 'upload',
            type: 'file',
            accept: '.dsproj,application/zip',
            ref: flow.fileRef,
            style: { display: 'none' },
            onChange: flow.onFileChange,
          }),
        );
      }
      if (flow.ask !== null) {
        children.push(
          React.createElement(AskPanel, {
            key: 'ask',
            suggested: flow.ask.suggested,
            busy: flow.busy,
            title: L.openPath,
            hint: L.openPathHint,
            confirmLabel: L.openConfirm,
            onConfirm: (value) => flow.open({ path: value }),
            onCancel: () => {
              flow.setAsk(null);
              flow.setToast({ tone: 'info', text: L.cancelled });
            },
          }),
        );
      }
      if (flow.conflict !== null) {
        children.push(
          React.createElement(ConflictModal, {
            key: 'conflict',
            conflict: flow.conflict,
            busy: flow.busy,
            onChoose: (mode, keep) =>
              flow.open({ path: flow.conflict.sourcePath, onConflict: mode, backup: keep === false ? '0' : '1' }),
            onCancel: () => {
              flow.setConflict(null);
              flow.setToast({ tone: 'info', text: L.cancelled });
            },
          }),
        );
      }
      if (flow.workspace !== null) {
        children.push(
          React.createElement(WorkspaceModal, {
            key: 'workspace',
            payload: flow.workspace,
            busy: flow.busy,
            onPick: (dir) => flow.open({ path: flow.workspace.sourcePath, cwd: dir }),
            // createCwd=1 是「替我建目录」的显式开关，只有这个按钮按下去才带。
            onCreate: (dir) => flow.open({ path: flow.workspace.sourcePath, cwd: dir, createCwd: '1' }),
            // replaceFile=1：「那个位置是个文件」也能代劳——改名备份后建目录，不删用户文件。
            onReplace: (dir) => flow.open({ path: flow.workspace.sourcePath, cwd: dir, replaceFile: '1' }),
            onBrowse: async () => {
              let dir = null;
              try {
                dir = await host?.uiWorkspace?.pickDirectory?.();
              } catch {
                dir = null;
              }
              if (typeof dir === 'string' && dir !== '') {
                flow.open({ path: flow.workspace.sourcePath, cwd: dir });
              }
            },
            onCancel: () => {
              flow.setWorkspace(null);
              flow.setToast({ tone: 'info', text: L.cancelled });
            },
          }),
        );
      }
      if (flow.broken !== null) {
        children.push(
          React.createElement(BrokenModal, {
            key: 'broken',
            payload: flow.broken,
            busy: flow.busy,
            onRepair: () => flow.open({ path: flow.broken.sourcePath, repairPackage: '1' }),
            onCancel: () => {
              flow.setBroken(null);
              flow.setToast({ tone: 'info', text: L.cancelled });
            },
          }),
        );
      }
      if (flow.notice !== null) {
        children.push(
          React.createElement(MemoryNotice, {
            key: 'notice',
            payload: flow.notice,
            busy: flow.busy,
            onMerge: () => flow.setMerge(flow.notice),
            onDismiss: () => flow.setNotice(null),
          }),
        );
      }
      if (flow.merge !== null) {
        children.push(
          React.createElement(MemoryMergeModal, {
            key: 'merge',
            payload: flow.merge,
            busy: flow.busy,
            onConfirm: (keep) => {
              const source = flow.merge.sourcePath;
              flow.setMerge(null);
              flow.open({ path: source, memory: 'restore', backup: keep === false ? '0' : '1' });
            },
            // 「合并并新建」是这一轮新增的第二个按钮：本机没有的文件默认不写，
            // 用户看到「将新建」段之后才有机会明确放行。
            onNew: () => {
              const source = flow.merge.sourcePath;
              flow.setMerge(null);
              flow.open({ path: source, memory: 'new' });
            },
            onCancel: () => {
              flow.setMerge(null);
              flow.setToast({ tone: 'info', text: L.cancelled });
            },
          }),
        );
      }
      if (flow.toast !== null) {
        children.push(
          React.createElement(Toast, {
            key: 'toast',
            tone: flow.toast.tone,
            text: flow.toast.text,
            onDone: () => {
              if (flow.mounted.current) flow.setToast(null);
            },
          }),
        );
      }
      return React.createElement(React.Fragment, null, ...children);
    }

    function MiniStat({ label, value }) {
      return React.createElement(
        'div',
        { style: { display: 'flex', gap: 6, fontSize: 11.5, color: COLORS.secondary } },
        React.createElement('span', null, `${label}：`),
        React.createElement('span', { style: { color: COLORS.label } }, value),
      );
    }

    /** 同 id 不同会话时问用户怎么办。 */
    function ConflictModal({ conflict, busy, onChoose, onCancel }) {
      // 覆盖前要不要留一份原文件，默认留。取消勾选时才真的什么都不留。
      const [keepBackup, setKeepBackup] = React.useState(true);
      const local = conflict.existing || {};
      const incoming = conflict.incoming || {};
      const when = (ms) => {
        const t = Number(ms);
        return Number.isFinite(t) && t > 0 ? new Date(t).toLocaleString() : '未知';
      };
      const button = (label, mode, primary, danger) =>
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick: () => onChoose(mode, keepBackup),
            style: {
              padding: '6px 12px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: primary ? COLORS.accentLabel : danger ? COLORS.danger : COLORS.label,
              background: primary ? COLORS.accent : 'transparent',
              border: primary ? 'none' : `1px solid ${COLORS.border}`,
              borderRadius: 6,
              cursor: busy ? 'default' : 'pointer',
            },
          },
          label,
        );

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 9998,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15,17,22,0.32)',
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel();
          },
        },
        React.createElement(
          'div',
          {
            style: {
              width: 560,
              maxWidth: '92vw',
              padding: 18,
              background: COLORS.elevated,
              border: `1px solid ${COLORS.border}`,
              borderRadius: COLORS.radius,
              boxShadow: '0 24px 60px rgba(0,0,0,0.24)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              color: COLORS.label,
            },
          },
          React.createElement('div', { style: { fontSize: 13.5, fontWeight: 600 } }, L.conflictTitle),
          React.createElement('div', { style: { fontSize: 12, color: COLORS.secondary, lineHeight: 1.5 } }, L.conflictHint),
          React.createElement(
            'div',
            {
              style: {
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 10,
                padding: 10,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 6,
              },
            },
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              React.createElement('div', { style: { fontSize: 12, fontWeight: 600 } }, L.conflictLocal),
              React.createElement(MiniStat, { label: L.conflictTitleField, value: local.title || '（无标题）' }),
              React.createElement(MiniStat, { label: L.conflictCreated, value: when(local.createdAt) }),
              React.createElement(MiniStat, { label: L.conflictSize, value: `${Math.round((Number(local.bytes) || 0) / 1024)} KB` }),
              React.createElement(MiniStat, { label: L.conflictCwd, value: local.cwd || '-' }),
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              React.createElement('div', { style: { fontSize: 12, fontWeight: 600 } }, L.conflictIncoming),
              React.createElement(MiniStat, { label: L.conflictTitleField, value: incoming.title || '（无标题）' }),
              React.createElement(MiniStat, { label: L.conflictCreated, value: when(incoming.createdAt) }),
              React.createElement(MiniStat, { label: L.conflictSize, value: `${Math.round((Number(incoming.bytes) || 0) / 1024)} KB` }),
              React.createElement(MiniStat, { label: L.conflictFrom, value: incoming.exportedBy || '-' }),
            ),
          ),
          React.createElement('div', { style: { fontSize: 11.5, color: COLORS.secondary, lineHeight: 1.5 } }, L.conflictId),
          React.createElement(
            'label',
            {
              style: {
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                fontSize: 12,
                color: COLORS.secondary,
                cursor: busy ? 'default' : 'pointer',
              },
            },
            React.createElement('input', {
              type: 'checkbox',
              checked: keepBackup,
              disabled: busy,
              onChange: (event) => setKeepBackup(event.target.checked),
            }),
            L.backupKeep,
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' } },
            button(L.cancel, '__cancel', false, false),
            button(L.conflictCopy, 'copy', false, false),
            button(L.conflictOverwrite, 'overwrite', false, true),
            button(L.conflictReuse, 'reuse', true, false),
          ),
        ),
      );
    }

    /* ── 文件已被别处改过：覆盖 / 另存为新文件 ── */

    /** 服务端拒绝覆盖时的小面板：给一条「换个位置」的出路，别让用户卡死。 */
    /** 记忆只落了副本时留在界面上的一小块说明：不点合并就永远不生效。 */
    function MemoryNotice({ payload, busy, onMerge, onDismiss }) {
      const written = Number(payload?.memoryWritten) || 0;
      const dir = typeof payload?.memoryDir === 'string' ? payload.memoryDir : '';
      // 在文件管理器里定位这个目录。走 Session Remote 的 openWorkspacePath：
      // uiWorkspace 没有 openPath 这个方法（只有 openSession/pickDirectory/
      // listDirectory 等），以前那行判断恒假，按钮点了什么都不发生。
      // reveal 归文件管理器，open 归默认应用 —— 目录只能 reveal。
      const openDir = () => {
        if (dir === '') return;
        const session = host?.remote?.session;
        if (typeof session?.openWorkspacePath !== 'function') return;
        session.openWorkspacePath({ path: dir, action: 'reveal' }).catch(() => {
          /* Host 不认这个路径就只显示路径，不弹错 */
        });
      };
      const link = (label, onClick) =>
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick,
            style: {
              padding: '5px 10px',
              fontSize: 12,
              fontFamily: 'inherit',
              color: COLORS.secondary,
              background: 'transparent',
              border: `1px solid ${COLORS.border}`,
              borderRadius: 6,
              cursor: busy ? 'default' : 'pointer',
            },
          },
          label,
        );

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            right: 20,
            bottom: 20,
            zIndex: 9996,
            width: 400,
            maxWidth: 'calc(100vw - 40px)',
            padding: 14,
            background: COLORS.elevated,
            border: `1px solid ${COLORS.border}`,
            borderRadius: COLORS.radius,
            boxShadow: '0 18px 44px rgba(0,0,0,0.18)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            color: COLORS.label,
          },
        },
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600 } }, `${L.memoryNoticeTitle} · ${written}`),
        React.createElement('div', { style: { fontSize: 12, color: COLORS.secondary, lineHeight: 1.5 } }, L.memoryNoticeBody),
        dir === '' ? null : React.createElement(MiniStat, { label: L.memoryDirLabel, value: dir }),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 2 } },
          React.createElement(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: onMerge,
              style: {
                padding: '6px 12px',
                fontSize: 12.5,
                fontFamily: 'inherit',
                color: COLORS.accentLabel,
                background: COLORS.accent,
                border: 'none',
                borderRadius: 6,
                cursor: busy ? 'default' : 'pointer',
              },
            },
            L.memoryMerge,
          ),
          dir === '' ? null : link(L.memoryOpenDir, openDir),
          link(L.wsCancel, onDismiss),
        ),
      );
    }

    /** 合并前把要覆盖的文件列出来，避免用户不知道自己在覆盖什么。 */
    function MemoryMergeModal({ payload, busy, onConfirm, onNew, onCancel }) {
      // 覆盖本机记忆文件前要不要先备份，默认备份。
      const [keepBackup, setKeepBackup] = React.useState(true);
      // 清单来自 memoryPlanned（copy 模式也返回），不是 memoryConflicts。后者只记「覆盖了
      // 哪些」，本机没有的文件压根不在里面——上一轮「弹窗列表为空、点确认却落了原名」
      // 就是拿它当清单用出来的。exists 由服务端用 safeJoin 落点判，前端只负责分两段显示。
      const planned = Array.isArray(payload?.memoryPlanned) ? payload.memoryPlanned : [];
      const pick = (wantExists) =>
        planned
          .filter((item) => item !== null && typeof item === 'object' && (item.exists === true) === wantExists)
          .map((item) => String(item.rel ?? ''))
          .filter((name) => name !== '');
      // 落点由包里的 cwd 决定；need-workspace 返回体里没有 memoryDir，所以按空串兜。
      const memoryDir = String(payload?.memoryDir ?? '');
      const overwrite = pick(true);
      const create = pick(false);
      const overwriteShown = overwrite.slice(0, 6);
      const createShown = create.slice(0, 6);
      const overwriteRest = overwrite.length - overwriteShown.length;
      const createRest = create.length - createShown.length;
      const button = (label, onClick, primary, off) =>
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy || off === true,
            onClick,
            style: {
              padding: '6px 12px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: primary ? COLORS.accentLabel : COLORS.label,
              background: primary ? COLORS.accent : 'transparent',
              border: primary ? 'none' : `1px solid ${COLORS.border}`,
              borderRadius: 6,
              opacity: off === true ? 0.45 : 1,
              cursor: busy || off === true ? 'default' : 'pointer',
            },
          },
          label,
        );

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15,17,22,0.32)',
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel();
          },
        },
        React.createElement(
          'div',
          {
            style: {
              width: 480,
              maxWidth: '92vw',
              padding: 18,
              background: COLORS.elevated,
              border: `1px solid ${COLORS.border}`,
              borderRadius: COLORS.radius,
              boxShadow: '0 24px 60px rgba(0,0,0,0.24)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              color: COLORS.label,
            },
          },
          React.createElement('div', { style: { fontSize: 13.5, fontWeight: 600 } }, L.memoryMergeTitle),
          React.createElement('div', { style: { fontSize: 12, color: COLORS.secondary, lineHeight: 1.5 } }, L.memoryMergeHint),
          // 把落点摊在清单之前：不说清楚「这些记忆要落到哪个工作区」，「合并记忆」看起来
          // 就像写进眼前这个项目，而它其实按包里记录的 cwd 落到另一个记忆目录。
          memoryDir === ''
            ? null
            : React.createElement(
                React.Fragment,
                null,
                React.createElement(MiniStat, { label: L.memoryDirLabel, value: memoryDir }),
                React.createElement(
                  'div',
                  { style: { fontSize: 11.5, color: COLORS.secondary, lineHeight: 1.5 } },
                  L.memoryMergeTarget,
                ),
              ),
          // 跨工作区必须直说。slug 不同就是另一个项目的记忆目录：用户以为自己只把
          // 包里的笔记并进眼前这个项目，实际写的是别处 —— 这一句是他唯一能察觉的机会。
          payload?.memoryForeign === true
            ? React.createElement(
                'div',
                { style: { fontSize: 11.5, color: COLORS.danger, lineHeight: 1.5 } },
                String(L.memoryForeignNote).replace('{slug}', String(payload?.memoryForeignSlug ?? '')),
              )
            : null,
          // 两段分开列：「将覆盖」是本机已有、点确认就换成本机版本的；「将新建」是本机没有的，
          // 默认一个都不写。用户看到第二段才知道包里还有东西没落地，才有机会决定要不要放行。
          React.createElement(
            'div',
            { style: { fontSize: 12, fontWeight: 600, color: COLORS.danger } },
            `${L.memoryMergeOverwrite} · ${overwrite.length}`,
          ),
          overwrite.length === 0
            ? React.createElement(
                'div',
                { style: { fontSize: 11.5, color: COLORS.secondary } },
                L.memoryMergeNoOverwrite,
              )
            : React.createElement(
                'div',
                {
                  style: {
                    maxHeight: 132,
                    overflow: 'auto',
                    padding: '8px 10px',
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 6,
                    background: 'rgba(0,0,0,0.02)',
                    fontSize: 11.5,
                    color: COLORS.danger,
                    lineHeight: 1.7,
                  },
                },
                ...overwriteShown.map((name) => React.createElement('div', { key: `o:${name}` }, name)),
                overwriteRest > 0
                  ? React.createElement(
                      'div',
                      { style: { color: COLORS.secondary } },
                      String(L.memoryMergeMore).replace('{n}', String(overwriteRest)),
                    )
                  : null,
              ),
          create.length === 0
            ? null
            : React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  'div',
                  { style: { fontSize: 12, fontWeight: 600, color: COLORS.secondary } },
                  `${L.memoryMergeCreate} · ${create.length}`,
                ),
                React.createElement(
                  'div',
                  { style: { fontSize: 11.5, color: COLORS.secondary, lineHeight: 1.5 } },
                  L.memoryMergeCreateHint,
                ),
                React.createElement(
                  'div',
                  {
                    style: {
                      maxHeight: 132,
                      overflow: 'auto',
                      padding: '8px 10px',
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: 6,
                      background: 'rgba(0,0,0,0.02)',
                      fontSize: 11.5,
                      color: COLORS.label,
                      lineHeight: 1.7,
                    },
                  },
                  ...createShown.map((name) => React.createElement('div', { key: `c:${name}` }, name)),
                  createRest > 0
                    ? React.createElement(
                        'div',
                        { style: { color: COLORS.secondary } },
                        String(L.memoryMergeMore).replace('{n}', String(createRest)),
                      )
                    : null,
                ),
              ),
          React.createElement(
            'label',
            {
              style: {
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                fontSize: 12,
                color: COLORS.secondary,
                cursor: busy ? 'default' : 'pointer',
              },
            },
            React.createElement('input', {
              type: 'checkbox',
              checked: keepBackup,
              disabled: busy,
              onChange: (event) => setKeepBackup(event.target.checked),
            }),
            L.backupKeep,
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 } },
            button(L.wsCancel, onCancel, false),
            // 两个按钮都给：只给「合并已有」的话，用户根本没法在全新机器上恢复记忆；
            // 只给「合并并新建」的话，等于把默认不放行的那一步做成了一键。
            button(L.memoryMergeWithNew, onNew, false, create.length === 0),
            button(L.memoryMergeConfirm, () => onConfirm(keepBackup), true, overwrite.length === 0),
          ),
        ),
      );
    }

    function RefuseModal({ payload, busy, onSaveAs, onCancel }) {
      const notDsproj = payload?.status === 'not-dsproj';
      const button = (label, onClick, primary) =>
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick,
            style: {
              padding: '6px 12px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: primary ? COLORS.accentLabel : COLORS.label,
              background: primary ? COLORS.accent : 'transparent',
              border: primary ? 'none' : `1px solid ${COLORS.border}`,
              borderRadius: 6,
              cursor: busy ? 'default' : 'pointer',
            },
          },
          label,
        );

      return React.createElement(
        'div',
        {
          key: 'refuse',
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 9998,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15,17,22,0.32)',
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel();
          },
        },
        React.createElement(
          'div',
          {
            style: {
              width: 460,
              maxWidth: '92vw',
              padding: 18,
              background: COLORS.elevated,
              border: `1px solid ${COLORS.border}`,
              borderRadius: COLORS.radius,
              boxShadow: '0 24px 60px rgba(0,0,0,0.24)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              color: COLORS.label,
            },
          },
          React.createElement(
            'div',
            { style: { fontSize: 13.5, fontWeight: 600 } },
            notDsproj ? L.notDsproj : L.confirmOverwrite,
          ),
          React.createElement(
            'div',
            { style: { fontSize: 12, color: COLORS.secondary, lineHeight: 1.5 } },
            notDsproj ? payload?.message ?? '' : L.confirmOverwriteHint,
          ),
          payload?.path
            ? React.createElement(MiniStat, { key: 'path', label: L.conflictCwd, value: String(payload.path) })
            : null,
          React.createElement(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 } },
            button(L.cancel, onCancel, false),
            button(L.confirmOverwriteAlt, onSaveAs, true),
          ),
        ),
      );
    }

    /**
     * 记住的保存位置上空了。
     *
     * 这里必须停下来问一句：用户按的是「保存」，预期是更新原来那份；那个文件既然
     * 已经不在了，直接落盘就是在原地造一个新文件，而界面上只会显示「已保存」。
     * 三条出路：另存到别处、明确同意在这里新建、或者取消。
     */
    function MissingModal({ payload, busy, onSaveAs, onRecreate, onCancel }) {
      const button = (label, onClick, primary, danger) =>
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick,
            style: {
              padding: '6px 12px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: primary ? COLORS.accentLabel : danger ? COLORS.danger : COLORS.label,
              background: primary ? COLORS.accent : 'transparent',
              border: primary ? 'none' : `1px solid ${COLORS.border}`,
              borderRadius: 6,
              cursor: busy ? 'default' : 'pointer',
            },
          },
          label,
        );

      return React.createElement(
        'div',
        {
          key: 'missing',
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 9998,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15,17,22,0.32)',
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel();
          },
        },
        React.createElement(
          'div',
          {
            style: {
              width: 460,
              maxWidth: '92vw',
              padding: 18,
              background: COLORS.elevated,
              border: `1px solid ${COLORS.border}`,
              borderRadius: COLORS.radius,
              boxShadow: '0 24px 60px rgba(0,0,0,0.24)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              color: COLORS.label,
            },
          },
          React.createElement('div', { style: { fontSize: 13.5, fontWeight: 600 } }, L.missingTarget),
          React.createElement(
            'div',
            { style: { fontSize: 12, color: COLORS.secondary, lineHeight: 1.5 } },
            L.missingTargetHint,
          ),
          payload?.path
            ? React.createElement(MiniStat, { key: 'path', label: L.conflictCwd, value: String(payload.path) })
            : null,
          React.createElement(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 } },
            button(L.cancel, onCancel, false),
            button(L.missingTargetRecreate, onRecreate, false, true),
            button(L.missingTargetSaveAs, onSaveAs, true),
          ),
        ),
      );
    }

    /**
     * 「这个文件正被另一个窗口写入」：默认等过一轮才走到这里，所以这里只问一句
     * 要不要强行存——文案要把后果说清（可能覆盖对方刚写的内容），不谈技术细节。
     */
    function LockedModal({ payload, busy, onForce, onCancel }) {
      const button = (label, onClick, primary) =>
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick,
            style: {
              padding: '6px 12px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: primary ? COLORS.accentLabel : COLORS.label,
              background: primary ? COLORS.accent : 'transparent',
              border: primary ? 'none' : `1px solid ${COLORS.border}`,
              borderRadius: 6,
              cursor: busy ? 'default' : 'pointer',
            },
          },
          label,
        );

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 9998,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.32)',
          },
        },
        React.createElement(
          'div',
          {
            style: {
              width: 440,
              maxWidth: '92vw',
              padding: 18,
              background: COLORS.elevated,
              border: `1px solid ${COLORS.border}`,
              borderRadius: COLORS.radius,
              boxShadow: '0 24px 60px rgba(0,0,0,0.24)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              color: COLORS.label,
            },
          },
          React.createElement('div', { style: { fontSize: 13.5, fontWeight: 600 } }, L.lockedTitle),
          React.createElement(
            'div',
            { style: { fontSize: 12, color: COLORS.secondary, lineHeight: 1.5 } },
            L.lockedHint,
          ),
          React.createElement(
            'div',
            { style: { fontSize: 11.5, color: COLORS.secondary, wordBreak: 'break-all' } },
            payload?.message ?? '',
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 } },
            button(L.cancel, onCancel, false),
            button(L.lockedForce, onForce, true),
          ),
        ),
      );
    }

    /**
     * 包结构校验没过：这里不猜哪里坏了，只做两件事——
     * 把服务端生成的「给 AI 的修包说明」原样交出去（可复制），或者按宽松模式
     * 丢掉校验不过的条目先打开。两条路都得用户点，插件不替他决定丢数据。
     */
    function BrokenModal({ payload, busy, onRepair, onCancel }) {
      const [copied, setCopied] = useState(false);
      const prompt = typeof payload?.prompt === 'string' && payload.prompt !== '' ? payload.prompt : '';
      const button = (label, onClick, primary) =>
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick,
            style: {
              padding: '6px 12px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: primary ? COLORS.accentLabel : COLORS.label,
              background: primary ? COLORS.accent : 'transparent',
              border: primary ? 'none' : `1px solid ${COLORS.border}`,
              borderRadius: 6,
              cursor: busy ? 'default' : 'pointer',
            },
          },
          label,
        );

      const copy = async () => {
        if (prompt === '') return;
        try {
          await navigator.clipboard.writeText(prompt);
          setCopied(true);
        } catch {
          // 浏览器不给剪贴板权限时别装作复制成功：提示用户自己全选复制。
          setCopied(false);
        }
      };

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 9998,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.32)',
          },
        },
        React.createElement(
          'div',
          {
            style: {
              width: 560,
              maxWidth: '94vw',
              maxHeight: '88vh',
              overflow: 'auto',
              padding: 18,
              background: COLORS.elevated,
              border: `1px solid ${COLORS.border}`,
              borderRadius: COLORS.radius,
              boxShadow: '0 24px 60px rgba(0,0,0,0.24)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              color: COLORS.label,
            },
          },
          React.createElement('div', { style: { fontSize: 13.5, fontWeight: 600 } }, L.brokenTitle),
          React.createElement(
            'div',
            { style: { fontSize: 12, color: COLORS.secondary, lineHeight: 1.5 } },
            prompt === '' ? L.brokenNoPrompt : L.brokenHint,
          ),
          React.createElement(
            'div',
            { style: { fontSize: 11.5, color: COLORS.danger, wordBreak: 'break-all' } },
            payload?.error ?? '',
          ),
          prompt === ''
            ? null
            : React.createElement('textarea', {
              readOnly: true,
              value: prompt,
              rows: 12,
              onFocus: (event) => {
                try {
                  event.target.select();
                } catch {
                  // 选不中也无所谓，用户能手动拖
                }
              },
              style: {
                width: '100%',
                fontFamily: 'ui-monospace, Consolas, monospace',
                fontSize: 11.5,
                lineHeight: 1.5,
                color: COLORS.label,
                background: COLORS.subtle ?? 'transparent',
                border: `1px solid ${COLORS.border}`,
                borderRadius: 6,
                padding: 8,
                resize: 'vertical',
              },
            }),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' } },
            copied === true
              ? React.createElement('span', { style: { fontSize: 11.5, color: COLORS.secondary } }, L.brokenCopied)
              : null,
            button(L.brokenCopy, copy, false),
            button(L.brokenRepair, onRepair, true),
            button(L.cancel, onCancel, false),
          ),
        ),
      );
    }

    function StaleModal({ payload, busy, onOverwrite, onSaveAs, onCancel }) {
      // 覆盖磁盘上那份之前要不要先备份，默认备份。
      const [keepBackup, setKeepBackup] = React.useState(true);
      const since = payload?.stale?.since;
      const when = typeof since === 'string' && since !== '' ? new Date(since).toLocaleString() : '未知';
      const bytes = Number(payload?.stale?.bytes) || 0;
      const button = (label, onClick, primary, danger) =>
        React.createElement(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick,
            style: {
              padding: '6px 12px',
              fontSize: 12.5,
              fontFamily: 'inherit',
              color: primary ? COLORS.accentLabel : danger ? COLORS.danger : COLORS.label,
              background: primary ? COLORS.accent : 'transparent',
              border: primary ? 'none' : `1px solid ${COLORS.border}`,
              borderRadius: 6,
              cursor: busy ? 'default' : 'pointer',
            },
          },
          label,
        );

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 9998,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15,17,22,0.32)',
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel();
          },
        },
        React.createElement(
          'div',
          {
            style: {
              width: 520,
              maxWidth: '92vw',
              padding: 18,
              background: COLORS.elevated,
              border: `1px solid ${COLORS.border}`,
              borderRadius: COLORS.radius,
              boxShadow: '0 24px 60px rgba(0,0,0,0.24)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              color: COLORS.label,
            },
          },
          React.createElement('div', { style: { fontSize: 13.5, fontWeight: 600 } }, L.staleTitle),
          React.createElement('div', { style: { fontSize: 12, color: COLORS.secondary, lineHeight: 1.5 } }, L.staleHint),
          React.createElement(
            'div',
            {
              style: {
                padding: 10,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 6,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              },
            },
            React.createElement(MiniStat, { label: L.staleSince, value: when }),
            React.createElement(MiniStat, {
              label: L.staleNow,
              value: `${Math.round(bytes / 1024)} KB${payload?.cloud ? ` · ${L.cloudTag}: ${payload.cloud}` : ''}`,
            }),
            React.createElement(MiniStat, { label: L.conflictCwd, value: String(payload?.path || '-') }),
          ),
          React.createElement(
            'label',
            {
              style: {
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                fontSize: 12,
                color: COLORS.secondary,
                cursor: busy ? 'default' : 'pointer',
              },
            },
            React.createElement('input', {
              type: 'checkbox',
              checked: keepBackup,
              disabled: busy,
              onChange: (event) => setKeepBackup(event.target.checked),
            }),
            L.backupKeep,
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' } },
            button(L.cancel, onCancel, false, false),
            button(L.staleSaveAs, onSaveAs, true, false),
            button(L.staleOverwrite, () => onOverwrite(keepBackup), false, true),
          ),
        ),
      );
    }

    /* ── 本机没有这个会话：问要打开到哪个工作区 ── */

    function WorkspaceModal({ payload, busy, onPick, onBrowse, onCreate, onReplace, onCancel }) {
      const list = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
      // 同一个弹窗服务两种情形：本机没有这个会话（need-workspace）、原工作区在本机
      // 不可用（bad-workspace）。后者要先把「哪个路径、什么毛病」说清，再让用户挑。
      const bad = payload?.status === 'bad-workspace';
      const badText = bad === true
        ? String(payload?.reason === 'missing' ? L.wsBadMissing : L.wsBadNotDir).replace('{path}', String(payload?.cwd ?? ''))
        : '';
      const row = (item) =>
        React.createElement(
          'button',
          {
            type: 'button',
            key: item.path,
            disabled: busy || item.exists === false,
            onClick: () => onPick(item.path),
            title: item.exists === false ? `${item.path}${L.wsMissing}` : item.path,
            style: {
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 2,
              width: '100%',
              padding: '8px 10px',
              fontFamily: 'inherit',
              textAlign: 'left',
              color: item.exists === false ? COLORS.secondary : COLORS.label,
              background: 'transparent',
              border: `1px solid ${COLORS.border}`,
              borderRadius: 6,
              cursor: busy || item.exists === false ? 'default' : 'pointer',
            },
          },
          React.createElement('span', { style: { fontSize: 12.5, fontWeight: 600 } }, item.title),
          React.createElement(
            'span',
            { style: { fontSize: 11, color: COLORS.secondary, wordBreak: 'break-all' } },
            item.path,
          ),
        );

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 9998,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15,17,22,0.32)',
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel();
          },
        },
        React.createElement(
          'div',
          {
            style: {
              width: 460,
              maxWidth: '92vw',
              maxHeight: '80vh',
              overflow: 'auto',
              padding: 18,
              background: COLORS.elevated,
              border: `1px solid ${COLORS.border}`,
              borderRadius: COLORS.radius,
              boxShadow: '0 24px 60px rgba(0,0,0,0.24)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              color: COLORS.label,
            },
          },
          React.createElement('div', { style: { fontSize: 13.5, fontWeight: 600 } }, bad === true ? L.wsBadTitle : L.wsTitle),
          React.createElement(
            'div',
            { style: { fontSize: 12, color: COLORS.secondary, lineHeight: 1.5, wordBreak: 'break-all' } },
            bad === true ? badText : L.wsHint,
          // 「文件夹不存在」这一种插件自己能解决，就别把活派给用户：点一下就建出来。
          // 建失败时把服务端回来的原因原样放上，不然只剩一个按不动的按钮。
          bad === true && typeof payload?.createError === 'string' && payload.createError !== ''
            ? React.createElement(
              'div',
              { style: { fontSize: 11.5, color: COLORS.danger, wordBreak: 'break-all' } },
              String(L.wsBadCreateFailed).replace('{reason}', payload.createError),
            )
            : null,
          bad === true && payload?.canCreate === true && typeof onCreate === 'function'
            ? React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => onCreate(String(payload.cwd ?? '')),
                title: String(L.wsBadCreateHint).replace('{path}', String(payload?.cwd ?? '')),
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 2,
                  width: '100%',
                  padding: '8px 10px',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  color: COLORS.label,
                  background: COLORS.subtle ?? 'transparent',
                  border: `1px solid ${COLORS.accent ?? COLORS.border}`,
                  borderRadius: 6,
                  cursor: busy ? 'default' : 'pointer',
                },
              },
              React.createElement('span', { style: { fontSize: 12.5, fontWeight: 600 } }, L.wsBadCreate),
              React.createElement(
                'span',
                { style: { fontSize: 11, color: COLORS.secondary, wordBreak: 'break-all' } },
                String(L.wsBadCreateHint).replace('{path}', String(payload?.cwd ?? '')),
              ),
            )
            : null,
          ),
          // 「位置被一个文件占着」：改名备份再建目录。按钮上把备份名写出来，
          // 让用户知道原文件还在，只是换了名字。
          bad === true && payload?.canReplace === true && typeof onReplace === 'function'
            ? React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => onReplace(String(payload.cwd ?? '')),
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 2,
                  width: '100%',
                  padding: '8px 10px',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  color: COLORS.label,
                  background: COLORS.subtle ?? 'transparent',
                  border: `1px solid ${COLORS.accent ?? COLORS.border}`,
                  borderRadius: 6,
                  cursor: busy ? 'default' : 'pointer',
                },
              },
              React.createElement('span', { style: { fontSize: 12.5, fontWeight: 600 } }, L.wsReplaceFile),
              React.createElement(
                'span',
                { style: { fontSize: 11, color: COLORS.secondary, wordBreak: 'break-all' } },
                String(L.wsReplaceHint).split('{path}').join(String(payload?.cwd ?? '')),
              ),
            )
            : null,
          payload?.originalCwd
            ? React.createElement(
                'div',
                { style: { fontSize: 11.5, color: COLORS.secondary, wordBreak: 'break-all' } },
                `${L.wsOriginal}: ${payload.originalCwd}`,
              )
            : null,
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            list.length === 0
              ? React.createElement('div', { style: { fontSize: 12, color: COLORS.secondary } }, L.wsEmpty)
              : list.map(row),
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 2 } },
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: onBrowse,
                style: {
                  padding: '6px 12px',
                  fontSize: 12.5,
                  fontFamily: 'inherit',
                  color: COLORS.label,
                  background: 'transparent',
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 6,
                  cursor: busy ? 'default' : 'pointer',
                },
              },
              L.wsPick,
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: onCancel,
                style: {
                  padding: '6px 12px',
                  fontSize: 12.5,
                  fontFamily: 'inherit',
                  color: COLORS.secondary,
                  background: 'transparent',
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 6,
                  cursor: busy ? 'default' : 'pointer',
                },
              },
              L.wsCancel,
            ),
          ),
        ),
      );
    }

    /* ── header：打开 ── */

    function OpenButton() {
      const flow = useOpenFlow();
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'button',
          {
            key: 'button',
            type: 'button',
            onClick: () => {
              if (!flow.busy) flow.open({});
            },
            disabled: flow.busy,
            title: L.openButtonHint,
            'aria-label': L.openButton,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              padding: 0,
              color: COLORS.secondary,
              background: 'transparent',
              border: 'none',
              borderRadius: 6,
              cursor: flow.busy ? 'progress' : 'pointer',
              transition: 'color 120ms ease, background-color 120ms ease',
            },
            onMouseEnter: (event) => {
              event.currentTarget.style.color = COLORS.label;
              event.currentTarget.style.backgroundColor = 'var(--dsw-alias-bg-hover, rgba(0,0,0,0.05))';
            },
            onMouseLeave: (event) => {
              event.currentTarget.style.color = COLORS.secondary;
              event.currentTarget.style.backgroundColor = 'transparent';
            },
          },
          flow.busy ? React.createElement(Spinner, null) : React.createElement(FolderIcon, null),
        ),
        React.createElement(OpenPanels, { key: 'panels', flow }),
      );
    }

    /* ── 空会话页面：新会话那一排紧凑选项里的「打开」 ── */

    /**
     * 座位是 `conversation.hero.options`（list，渲染在新会话行的右侧，跟在
     * 工作区选择器和预设选择器后面）。空会话页面就是唯一能稳定拿到的地方：
     * 侧栏工作区标题行是硬编码的、没有插槽，改 DOM 会被重渲染抹掉。
     */
    function HeroOpenButton() {
      const flow = useOpenFlow();
      const [hover, setHover] = useState(false);
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'button',
          {
            key: 'button',
            type: 'button',
            onClick: () => {
              if (!flow.busy) flow.open({});
            },
            disabled: flow.busy,
            title: L.openButtonHint,
            'aria-label': L.openButton,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 28,
              padding: '0 10px',
              fontFamily: 'inherit',
              fontSize: 12.5,
              lineHeight: 1,
              color: hover ? COLORS.label : COLORS.secondary,
              background: hover ? 'var(--dsw-alias-bg-hover, rgba(0,0,0,0.05))' : 'transparent',
              border: `1px solid ${COLORS.border}`,
              borderRadius: 6,
              cursor: flow.busy ? 'progress' : 'pointer',
              transition: 'color 120ms ease, background-color 120ms ease',
              whiteSpace: 'nowrap',
            },
          },
          flow.busy ? React.createElement(Spinner, null) : React.createElement(FolderIcon, { size: 13 }),
          React.createElement('span', null, flow.busy ? L.opening : L.openButton),
        ),
        React.createElement(OpenPanels, { key: 'panels', flow }),
      );
    }

    /* ── header：自动保存开关 ── */

    function AutosaveButton(props) {
      const sessionId = props.sessionId;
      const [on, setOn] = useState(false);
      const [path, setPath] = useState('');
      const [busy, setBusy] = useState(false);
      const [ask, setAsk] = useState(null);
      const [toast, setToast] = useState(null);
      const mounted = useRef(true);

      useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      const call = useCallback(
        (params) => requestJson(AUTOSAVE_ROUTE, { sessionId: String(sessionId), ...params }),
        [sessionId],
      );

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const payload = await call({});
            if (!alive || !mounted.current) return;
            setOn(payload.enabled === true);
            setPath(payload.path || '');
            if (payload.stale !== undefined && payload.stale !== null) {
              setToast({
                tone: 'error',
                text: `${L.staleTitle} · ${String(payload.stale.path || payload.path || '')}`,
              });
            }
            // 上次自动保存时目标文件就不在了：服务端已经停掉自动保存，这里把原因说出来，
            // 否则按钮只是悄悄变回「关」，用户会以为是插件坏了。
            if (payload.missing !== undefined && payload.missing !== null) {
              setToast({
                tone: 'error',
                text: `${L.missingAutoOff} · ${String(payload.missing.path || payload.path || '')}`,
              });
            }
          } catch {
            /* 读不到就当关着 */
          }
        })();
        return () => {
          alive = false;
        };
      }, [call]);

      const apply = useCallback(
        async (enabled) => {
          const payload = await call({ enabled: enabled ? '1' : '0' });
          if (!mounted.current) return;
          setOn(payload.enabled === true);
          setPath(payload.path || '');
          const cloud = payload.cloud === undefined || payload.cloud === null
            ? ''
            : ` · ${String(L.cloudWarn).replace('{name}', payload.cloud)}`;
          setToast({
            tone: payload.cloud === undefined || payload.cloud === null ? 'ok' : 'info',
            text: payload.enabled ? `${L.autosaveOn} · ${payload.path || ''}${cloud}` : L.autosaveOff,
          });
        },
        [call],
      );

      /** 开自动保存前必须先有一个记住的文件：没有就走一次保存（可能弹原生另存为）。 */
      const enable = useCallback(
        async (explicitPath) => {
          setBusy(true);
          try {
            if (path === '' || explicitPath !== undefined) {
              const params = { sessionId: String(sessionId), mode: 'auto' };
              if (explicitPath !== undefined) params.path = explicitPath;
              const saved = await requestJson(SAVE_ROUTE, params);
              if (!mounted.current) return;
              if (saved.status === 'need-path') {
                setAsk({ suggested: saved.suggested || '' });
                return;
              }
              if (saved.status === 'cancelled') {
                setAsk(null);
                setToast({ tone: 'info', text: L.cancelled });
                return;
              }
              if (saved.status === 'stale') {
                setAsk(null);
                setToast({ tone: 'error', text: `${L.staleTitle} · ${String(saved.path || '')}` });
                return;
              }
              if (saved.status !== 'saved') {
                setToast({ tone: 'error', text: `${L.failed} · ${saved.message || 'unknown'}` });
                return;
              }
              setAsk(null);
              setPath(saved.path || '');
            }
            await apply(true);
          } catch (error) {
            if (mounted.current) {
              setToast({ tone: 'error', text: `${L.failed} · ${String(error && error.message ? error.message : error)}` });
            }
          } finally {
            if (mounted.current) setBusy(false);
          }
        },
        [apply, path, sessionId],
      );

      const onClick = useCallback(() => {
        if (busy) return;
        if (on) {
          setBusy(true);
          apply(false)
            .catch((error) => {
              if (mounted.current) setToast({ tone: 'error', text: String(error && error.message ? error.message : error) });
            })
            .finally(() => {
              if (mounted.current) setBusy(false);
            });
          return;
        }
        enable();
      }, [apply, busy, enable, on]);

      const children = [
        React.createElement(
          'button',
          {
            key: 'button',
            type: 'button',
            onClick,
            disabled: busy,
            title: on ? `${L.autosaveOnHint}${path ? ` → ${path}` : ''}` : L.autosaveOffHint,
            'aria-label': L.autosave,
            'aria-pressed': on,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              padding: 0,
              color: on ? COLORS.accent : COLORS.secondary,
              background: 'transparent',
              border: 'none',
              borderRadius: 6,
              cursor: busy ? 'progress' : 'pointer',
              transition: 'color 120ms ease, background-color 120ms ease',
            },
            onMouseEnter: (event) => {
              event.currentTarget.style.backgroundColor = 'var(--dsw-alias-bg-hover, rgba(0,0,0,0.05))';
            },
            onMouseLeave: (event) => {
              event.currentTarget.style.backgroundColor = 'transparent';
            },
          },
          busy ? React.createElement(Spinner, null) : React.createElement(SyncIcon, { active: on }),
        ),
      ];

      if (ask !== null) {
        children.push(
          React.createElement(AskPanel, {
            key: 'ask',
            suggested: ask.suggested,
            busy,
            title: L.autosaveAsk,
            hint: L.autosaveAskHint,
            confirmLabel: L.confirm,
            onConfirm: (value) => enable(value),
            onCancel: () => {
              setAsk(null);
              setToast({ tone: 'info', text: L.cancelled });
            },
          }),
        );
      }

      if (toast !== null) {
        children.push(
          React.createElement(Toast, {
            key: 'toast',
            tone: toast.tone,
            text: toast.text,
            onDone: () => {
              if (mounted.current) setToast(null);
            },
          }),
        );
      }

      return React.createElement(React.Fragment, null, ...children);
    }

    let host = null;
    // remote / remote.session 是点路径形式声明的服务依赖（Cordis 按路径取服务）。
    // 少了它们 ctx.remote 是 undefined，"打开记忆目录"就只能静默失败。
    const inject = ['slots', 'sessions', 'uiWorkspace', 'remote', 'remote.session'];

    function apply(ctx) {
      // 不 await：界面先用中文渲染，语言包到了下一帧自然替换，不挡首屏。
      void loadLocale();
      host = ctx;
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: 'session-open',
            order: 39,
          },
          OpenButton,
        ),
      );
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: 'session-save',
            order: 40,
          },
          SaveButton,
        ),
      );
      // 远程访问不显示自动保存：它写的是服务端那台机器上的文件，用户在自己的电脑上
      // 既看不到那个文件，也没法把它带走。开着只会让人以为存好了。
      if (isRemoteHost() === false) {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'session-autosave',
              order: 41,
            },
            AutosaveButton,
          ),
        );
      }
      // 远程访问的「保存」本身就是浏览器下载，「另存为」再给一个入口只会让人以为
      // 它能把文件写到别的地方——写到的是服务端那台机器，与用户无关。
      if (isRemoteHost() === false) {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'session-save-as',
              order: 42,
            },
            SaveAsButton,
          ),
        );
      }
      ctx.slots.inject(SLOT_HERO, () =>
        ctx.slots.register(
          {
            name: SLOT_HERO,
            id: 'session-open-hero',
            order: 41,
          },
          HeroOpenButton,
        ),
      );
    }

    return { inject, apply };
  },
});
