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
      failed: '保存失败',
      openButton: '打开会话',
      openButtonHint: '打开',
      opening: '正在打开…',
      opened: '已打开',
      openFailed: '打开失败',
      openPath: '打开会话工程',
      openPathHint: '输入 .dsproj 的完整路径',
      openConfirm: '打开',
      conflictTitle: '这个会话本机已经有了',
      conflictHint: '文件里的会话与本机同 id 的那条不是同一段对话，选一个处理方式。',
      conflictLocal: '本机现有',
      conflictIncoming: '文件里带来的',
      conflictTitleField: '标题',
      conflictCreated: '创建时间',
      conflictSize: '体积',
      conflictCwd: '工作区',
      conflictFrom: '导出机器',
      conflictId: '两边 id 相同，所以只能留一份同 id 的会话；「另存为副本」会给文件里那份换新 id。',
      conflictReuse: '用本机的',
      conflictOverwrite: '用文件覆盖本机',
      conflictCopy: '另存为副本',
      autosave: '自动保存',
      autosaveOn: '自动保存已开启',
      autosaveOff: '自动保存已关闭',
      autosaveOnHint: '自动保存已开启（点击关闭）',
      autosaveOffHint: '自动保存已关闭（点击开启）',
      autosaveAsk: '先选一个保存位置',
      autosaveAskHint: '自动保存需要一个固定文件，之后每次覆盖它',
      locked: '文件被占用',
      saveAs: '另存为',
      saveAsHint: '另存为',
      saveAsSaved: '已另存为',
      wsTitle: '打开到哪个工作区',
      wsHint: '本机没有这个会话，选一个工作区把对话放进去，然后就能接着聊。',
      wsOriginal: '文件里的原工作区',
      wsPick: '选其他目录…',
      wsEmpty: '还没有工作区，直接选一个目录吧。',
      wsMissing: '（本机没有这个目录）',
      wsCancel: '取消',
      staleTitle: '这个文件已被别处改过',
      staleHint: '磁盘上的内容已经不是本机上次写的那份了（另一台机器、同步盘，或手动替换过）。直接覆盖会丢掉那边的内容。',
      staleSince: '本机上次写入',
      staleNow: '现在磁盘上',
      staleOverwrite: '覆盖磁盘上的',
      staleSaveAs: '另存为新文件',
      cloudWarn: '这个目录在 {name} 里：两台机器同时开着自动保存会互相覆盖，建议只在一台机器上写。',
      cloudTag: '同步盘',
      confirmOverwrite: '这个位置已经有文件了',
      confirmOverwriteHint: '它不是这个会话记住的那个工程文件。覆盖会让原来的内容消失。',
      confirmOverwriteAlt: '换个位置另存为',
      notDsproj: '那个文件不是 .dsproj 工程包，不能覆盖',
      pathNotAllowed: '只能存到用过的目录，或者用另存为窗口挑位置',
      memoryHint: 'Alt 点击：连同工作区记忆一起打包',
      memoryTag: '含记忆',
      memoryCopiesHint: ' 个记忆文件已作为副本落盘（未生效）',
      memoryConflictsHint: ' 个与本地已有记忆重名',
      memoryRestoredHint: ' 个记忆文件已写回原位',
      memoryNoticeTitle: '记忆只落了副本',
      memoryNoticeBody: '包里的工作区记忆已存成带来源后缀的副本，DSH 不会读它们。要让它们生效，点「合并记忆」——只覆盖本机已有的同名文件，覆盖前先备份。这个包如果不是你自己导出的，请直接关掉：包里的记忆会被 DSH 当作项目笔记读进上下文。',
      memoryOpenDir: '打开记忆目录',
      memoryDirLabel: '记忆目录',
      memoryMerge: '合并记忆',
      memoryMergeTitle: '把包里的记忆合并到本机',
      memoryMergeHint: '合并只覆盖本机已有的同名文件，覆盖前每个都会备份成 .bak-<时间>。这个包如果不是你自己导出的，请取消：包里的记忆会被 DSH 当作项目笔记读进上下文。',
      memoryMergeMore: '还有 {n} 个',
      memoryMergeConfirm: '合并已有',
      memoryMergeOverwrite: '将覆盖',
      memoryMergeCreate: '将新建（本机没有）',
      memoryMergeCreateHint: '这些文件本机没有。默认不写入——包里的记忆可能不是你自己的，新建等于让 DSH 直接读它。确认是你自己导出的包，再选「合并并新建」。',
      memoryMergeWithNew: '合并并新建',
      memoryMergeNoOverwrite: '没有要覆盖的文件',
      memoryCreatedHint: ' 个新文件未写入',
      memoryNewHint: ' 个已写回原位（含新建）',
    };
    const EN = {
      button: 'Save session',
      buttonHint: 'Save this session to a .dsproj (Shift+click = Save As)',
      saving: 'Saving…',
      ask: 'Save as',
      askHint: 'Where should this session go?',
      confirm: 'Save',
      cancel: 'Cancel',
      saved: 'Saved',
      savedMemory: 'memory files',
      cancelled: 'Cancelled',
      failed: 'Save failed',
      openButton: 'Open session',
      openButtonHint: 'Open a session from a .dsproj',
      opening: 'Opening…',
      opened: 'Opened',
      openFailed: 'Open failed',
      openPath: 'Open session project',
      openPathHint: 'Full path of a .dsproj file',
      openConfirm: 'Open',
      conflictTitle: 'This session already exists here',
      conflictHint: 'The file carries a different conversation under the same id. Pick how to resolve it.',
      conflictLocal: 'On this machine',
      conflictIncoming: 'From the file',
      conflictTitleField: 'Title',
      conflictCreated: 'Created',
      conflictSize: 'Size',
      conflictCwd: 'Workspace',
      conflictFrom: 'Exported on',
      conflictId: 'Both share one id, so only one session per id can stay; “Save as copy” gives the incoming one a new id.',
      conflictReuse: 'Keep local',
      conflictOverwrite: 'Overwrite with file',
      conflictCopy: 'Save as copy',
      autosave: 'Autosave',
      autosaveOn: 'Autosave on',
      autosaveOff: 'Autosave off',
      autosaveOnHint: 'Writes the project file after every step (click to turn off)',
      autosaveOffHint: 'Turn on to save after every step (pick a location first)',
      autosaveAsk: 'Pick a file first',
      autosaveAskHint: 'Autosave needs a fixed file to overwrite each time',
      locked: 'File is in use',
      saveAs: 'Save As',
      saveAsHint: 'Save as a new .dsproj (new name or location; the original stays)',
      saveAsSaved: 'Saved as',
      wsTitle: 'Open into which workspace',
      wsHint: 'This session is not on this machine yet. Pick a workspace to unpack it into, then keep chatting.',
      wsOriginal: 'Original workspace in the file',
      wsPick: 'Choose another folder…',
      wsEmpty: 'No workspace yet — pick a folder instead.',
      wsMissing: ' (missing on this machine)',
      wsCancel: 'Cancel',
      staleTitle: 'This file changed elsewhere',
      staleHint: 'What is on disk is no longer what this machine wrote last (another machine, a synced folder, or a manual replace). Overwriting would discard that side.',
      staleSince: 'Last written here',
      staleNow: 'On disk now',
      staleOverwrite: 'Overwrite on disk',
      staleSaveAs: 'Save as a new file',
      cloudWarn: 'This folder is inside {name}: autosave on two machines at once will overwrite each other. Keep writing on one machine.',
      cloudTag: 'synced folder',
      confirmOverwrite: 'A file already exists there',
      confirmOverwriteHint: 'It is not the project file this session remembers. Overwriting drops what is in it.',
      confirmOverwriteAlt: 'Save somewhere else',
      notDsproj: 'That file is not a .dsproj project file — refusing to overwrite',
      pathNotAllowed: 'Only folders you have used before, or pick a spot in the Save As dialog',
      memoryHint: 'Alt+click: bundle the workspace memory too',
      memoryTag: 'with memory',
      memoryCopiesHint: ' memory files landed as copies (not active)',
      memoryConflictsHint: ' clash with local memory',
      memoryRestoredHint: ' memory files written back in place',
      memoryNoticeTitle: 'Memory landed as copies',
      memoryNoticeBody: 'The workspace memory from this package was written as copies with a source suffix, which DSH does not read. To make it take effect, choose Merge memory — only files that already exist here are overwritten, and each is backed up first. If this package is not one you exported yourself, close this: packaged memory is read by DSH as project notes and enters the context.',
      memoryOpenDir: 'Open memory folder',
      memoryDirLabel: 'Memory folder',
      memoryMerge: 'Merge memory',
      memoryMergeTitle: 'Merge the packaged memory into this machine',
      memoryMergeHint: 'Merging only overwrites files that already exist here, and backs each one up as .bak-<time> first. If this package is not one you exported yourself, cancel: packaged memory is read by DSH as project notes and enters the context.',
      memoryMergeMore: 'and {n} more',
      memoryMergeConfirm: 'Merge existing',
      memoryMergeOverwrite: 'Will overwrite',
      memoryMergeCreate: 'Will create (not on this machine)',
      memoryMergeCreateHint: 'These files do not exist here. They are not written by default — packaged memory may not be yours, and creating them lets DSH read it directly. Only choose Merge and create when you exported this package yourself.',
      memoryMergeWithNew: 'Merge and create',
      memoryMergeNoOverwrite: 'Nothing to overwrite',
      memoryCreatedHint: ' new files not written',
      memoryNewHint: ' written back in place (incl. new)',
    };
    const L = (typeof navigator === 'object' && /^en\b/i.test(navigator.language || '')) ? EN : ZH;

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
            // 目标位置已有一个「不是本会话记住的那个」文件，或者它不是工程包：
            // 服务端拒绝直接覆盖，这里给用户一条手动出路（换位置另存为）。
            if (payload.status === 'confirm-overwrite' || payload.status === 'not-dsproj') {
              setAsk(null);
              setRefuse(payload);
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
            title: alwaysAsk
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
            onOverwrite: () => save({ force: '1' }),
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

    /* ── 请求层 ── */
    async function requestJson(route, params) {
      const search = new URLSearchParams(params);
      const response = await fetch(`${route}?${search.toString()}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
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
      const [notice, setNotice] = useState(null); // 记忆只落了副本 → 留个面板让人去合并
      const [merge, setMerge] = useState(null); // 合并确认弹窗的载荷
      const [toast, setToast] = useState(null); // { tone, text }
      const mounted = useRef(true);

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
        // 只要还有没生效的东西，就把面板留在界面上：copy 是「全是副本」，restore 是
        // 「有文件没写」。new 表示用户已经明确同意全写，不再提示。
        setNotice(!created && (written > 0 || pendingCreated > 0) ? payload : null);
        setToast({
          tone: warning !== '' || cloud !== '' || (!created && (written > 0 || pendingCreated > 0)) ? 'info' : 'ok',
          text: `${L.opened} · ${label}${warning}${cloud}${memory}${createdText}${clashText}`,
        });
        try {
          await host?.sessions?.refresh?.();
        } catch {
          /* 索引刷新失败不阻断打开 */
        }
        try {
          host?.uiWorkspace?.openSession?.(payload.sessionId);
        } catch (error) {
          setToast({ tone: 'error', text: `${L.openFailed} · ${String(error && error.message ? error.message : error)}` });
        }
      }, []);

      const open = useCallback(
        async (extra = {}) => {
          setBusy(true);
          try {
            const payload = await requestJson(OPEN_ROUTE, { mode: 'auto', ...extra });
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
            if (payload.status === 'cancelled') {
              setAsk(null);
              setWorkspace(null);
              setToast({ tone: 'info', text: L.cancelled });
              return;
            }
            if (payload.status === 'need-path') {
              setAsk({ suggested: payload.suggested || '' });
              return;
            }
            setToast({ tone: 'error', text: `${L.openFailed} · ${payload.message || 'unknown'}` });
          } catch (error) {
            if (mounted.current) {
              setToast({ tone: 'error', text: `${L.openFailed} · ${String(error && error.message ? error.message : error)}` });
            }
          } finally {
            if (mounted.current) setBusy(false);
          }
        },
        [jump],
      );

      return { busy, ask, conflict, workspace, notice, merge, toast, open, setAsk, setConflict, setWorkspace, setNotice, setMerge, setToast, mounted };
    }

    /** AskPanel + 冲突弹窗 + toast，两个入口共用。 */
    function OpenPanels({ flow }) {
      const children = [];
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
            onChoose: (mode) => flow.open({ path: flow.conflict.sourcePath, onConflict: mode }),
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
            onConfirm: () => {
              const source = flow.merge.sourcePath;
              flow.setMerge(null);
              flow.open({ path: source, memory: 'restore' });
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
            onClick: () => onChoose(mode),
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
      const openDir = () => {
        try {
          if (typeof host?.uiWorkspace?.openPath === 'function' && dir !== '') host.uiWorkspace.openPath(dir);
        } catch {
          /* 没有这个入口就只显示路径 */
        }
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
      // 清单来自 memoryPlanned（copy 模式也返回），不是 memoryConflicts。后者只记「覆盖了
      // 哪些」，本机没有的文件压根不在里面——上一轮「弹窗列表为空、点确认却落了原名」
      // 就是拿它当清单用出来的。exists 由服务端用 safeJoin 落点判，前端只负责分两段显示。
      const planned = Array.isArray(payload?.memoryPlanned) ? payload.memoryPlanned : [];
      const pick = (wantExists) =>
        planned
          .filter((item) => item !== null && typeof item === 'object' && (item.exists === true) === wantExists)
          .map((item) => String(item.rel ?? ''))
          .filter((name) => name !== '');
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
            'div',
            { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 } },
            button(L.wsCancel, onCancel, false),
            // 两个按钮都给：只给「合并已有」的话，用户根本没法在全新机器上恢复记忆；
            // 只给「合并并新建」的话，等于把默认不放行的那一步做成了一键。
            button(L.memoryMergeWithNew, onNew, false, create.length === 0),
            button(L.memoryMergeConfirm, onConfirm, true, overwrite.length === 0),
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

    function StaleModal({ payload, busy, onOverwrite, onSaveAs, onCancel }) {
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
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' } },
            button(L.cancel, onCancel, false, false),
            button(L.staleSaveAs, onSaveAs, true, false),
            button(L.staleOverwrite, onOverwrite, false, true),
          ),
        ),
      );
    }

    /* ── 本机没有这个会话：问要打开到哪个工作区 ── */

    function WorkspaceModal({ payload, busy, onPick, onBrowse, onCancel }) {
      const list = Array.isArray(payload?.workspaces) ? payload.workspaces : [];
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
          React.createElement('div', { style: { fontSize: 13.5, fontWeight: 600 } }, L.wsTitle),
          React.createElement('div', { style: { fontSize: 12, color: COLORS.secondary, lineHeight: 1.5 } }, L.wsHint),
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
    const inject = ['slots', 'sessions', 'uiWorkspace'];

    function apply(ctx) {
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
