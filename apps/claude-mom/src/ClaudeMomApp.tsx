import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, Download, Eye, EyeOff, Loader2, Play, Plus, RefreshCw, ShieldCheck, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  IMPORT_SOURCES,
  SOURCE_LABELS,
  WINDOW_PRESETS,
  claudeState,
  emptyProfile,
  formatWindow,
  hostOf,
  isOk,
  modelLabel,
  normalizeModels,
  profileProblem,
  setupSteps,
  type ClaudeConfig,
  type ClaudeStatus,
  type CommandResult,
  type UpstreamBook,
  type UpstreamModel,
  type UpstreamProfile,
} from "./model";
import { checkForUpdate, currentVersion, installUpdate, type UpdateState } from "./updates";

type Tab = "upstream" | "claude";
type Notice = { text: string; tone: "ok" | "error" } | null;
type ClaudeAction = "launch" | "stop" | "trust" | "untrust" | "prepare" | "sync_sessions";

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function ClaudeMomApp() {
  const [book, setBook] = useState<UpstreamBook>({ profiles: [], activeId: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<UpstreamProfile | null>(null);
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [tab, setTab] = useState<Tab>("upstream");
  const pending = useRef(false);

  const say = (text: string, tone: "ok" | "error" = "ok") => setNotice(text ? { text, tone } : null);
  // 提示过一会儿自己消失：成功的 5 秒，出错的 12 秒。
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.tone === "error" ? 12000 : 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<UpdateState>({ phase: "idle" });

  // 启动时静默查一次更新：只在有新版本时提示，查不到（离线、限流）不打扰。
  useEffect(() => {
    void currentVersion().then(setVersion);
    const timer = setTimeout(() => {
      void checkForUpdate().then((result) => {
        if (result.phase === "available") setUpdate(result);
      });
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  const runUpdateCheck = async () => {
    setUpdate({ phase: "checking" });
    const result = await checkForUpdate();
    setUpdate(result);
    if (result.phase === "failed") say(`检查更新失败：${result.message}`, "error");
  };

  const runInstall = async () => {
    if (update.phase !== "available") return;
    const { update: pending, version: target } = update;
    setUpdate({ phase: "downloading", version: target, percent: null });
    try {
      await installUpdate(pending, (percent) => setUpdate({ phase: "downloading", version: target, percent }));
    } catch (cause) {
      setUpdate({ phase: "failed", message: errorText(cause) });
      say(`更新失败：${errorText(cause)}`, "error");
    }
  };

  const acceptBook = useCallback((result: CommandResult<UpstreamBook>, keepSelection?: string | null) => {
    const next = { profiles: result.profiles ?? [], activeId: result.activeId ?? null };
    setBook(next);
    const wanted = keepSelection ?? null;
    const target = next.profiles.find((profile) => profile.id === wanted) ?? next.profiles.find((profile) => profile.id === next.activeId) ?? next.profiles[0] ?? null;
    setSelectedId(target?.id ?? null);
    setDraft(target ? { ...target } : null);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const result = await invoke<CommandResult<ClaudeStatus>>("claude_local_status");
      if (isOk(result)) setStatus(result);
      else say(result.message, "error");
    } catch (cause) {
      say(errorText(cause), "error");
    }
  }, []);

  // 启动：读上游（同时切到完整功能模式、把选中的上游交给本地服务），再读 Claude 状态。
  useEffect(() => {
    void (async () => {
      try {
        const result = await invoke<CommandResult<UpstreamBook>>("claude_mom_load");
        acceptBook(result);
        if (!isOk(result)) say(result.message, "error");
      } catch (cause) {
        say(errorText(cause), "error");
      }
      await refreshStatus();
    })();
  }, [acceptBook, refreshStatus]);

  // Claude 开着或本地服务在跑时每 3 秒刷新一次状态；闲着不轮询（检测要查进程和证书）。
  useEffect(() => {
    if ((!status?.running && !status?.claudeRunning) || busy) return;
    const timer = setInterval(() => void refreshStatus(), 3000);
    return () => clearInterval(timer);
  }, [status?.running, status?.claudeRunning, busy, refreshStatus]);

  /** 同一时间只做一件事；结束后刷新状态。 */
  const run = async <T,>(label: string, task: () => Promise<T>): Promise<T | undefined> => {
    if (pending.current) return undefined;
    pending.current = true;
    setBusy(label);
    try {
      return await task();
    } catch (cause) {
      say(errorText(cause), "error");
      return undefined;
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };

  const claudeAction = (action: ClaudeAction) =>
    run(action, async () => {
      const result = await invoke<CommandResult<ClaudeStatus>>("claude_local_action", { action });
      if (isOk(result)) setStatus(result);
      say(result.message, isOk(result) ? "ok" : "error");
    });

  const configure = (patch: Partial<ClaudeConfig>) =>
    run("configure", async () => {
      if (!status) return;
      const config = { ...status.config, ...patch, enabled: true };
      const result = await invoke<CommandResult<ClaudeStatus>>("claude_local_configure", { config });
      if (isOk(result)) setStatus(result);
      else say(result.message, "error");
    });

  // 原生听写：Claude 开关、听写总开关、本地 SenseVoice 一起改（见 claude_mom_set_voice）。
  const setVoice = (enabled: boolean) =>
    run("voice", async () => {
      const result = await invoke<CommandResult<ClaudeStatus>>("claude_mom_set_voice", { enabled });
      if (isOk(result)) setStatus(result);
      say(result.message, isOk(result) ? "ok" : "error");
    });

  const bookCall = (label: string, command: string, args: Record<string, unknown>, keep?: string | null) =>
    run(label, async () => {
      const result = await invoke<CommandResult<UpstreamBook>>(command, args);
      acceptBook(result, keep);
      say(result.message, isOk(result) ? "ok" : "error");
      await refreshStatus();
      return result;
    });

  const active = book.profiles.find((profile) => profile.id === book.activeId) ?? null;
  const dirty = useMemo(() => {
    if (!draft) return false;
    const saved = book.profiles.find((profile) => profile.id === draft.id);
    return !saved || JSON.stringify(saved) !== JSON.stringify(draft);
  }, [book, draft]);

  const select = (id: string) => {
    const profile = book.profiles.find((item) => item.id === id);
    if (!profile) return;
    setSelectedId(id);
    setDraft({ ...profile });
    setTab("upstream");
  };

  const addProfile = () => {
    setSelectedId(null);
    setDraft(emptyProfile());
    setTab("upstream");
  };

  const saveDraft = async (activate: boolean) => {
    if (!draft) return;
    const problem = profileProblem(draft);
    if (problem) return say(problem, "error");
    const profile = { ...draft, models: normalizeModels(draft.models, draft.model) };
    const result = await bookCall("save", "claude_mom_save_profile", { profile, activate }, draft.id || undefined);
    // 新增的条目保存后才有 id：选中刚存的那条（列表最后一条或同名那条）。
    if (result && isOk(result) && !draft.id) {
      const created = [...(result.profiles ?? [])].reverse().find((item) => item.baseUrl === profile.baseUrl.trim().replace(/\/+$/, ""));
      if (created) {
        setSelectedId(created.id);
        setDraft({ ...created });
      }
    }
  };

  const fetchModels = () =>
    run("models", async () => {
      if (!draft) return;
      const result = await invoke<CommandResult<{ models: UpstreamModel[] }>>("claude_mom_fetch_models", { baseUrl: draft.baseUrl, apiKey: draft.apiKey });
      if (!isOk(result)) return say(result.message, "error");
      const ids = result.models.map((model) => model.id);
      setDraft((current) => {
        if (!current) return current;
        const model = current.model || ids[0] || "";
        const window = result.models.find((item) => item.id === model)?.contextWindow ?? current.contextWindow;
        const names = Object.fromEntries(result.models.filter((item) => item.displayName).map((item) => [item.id, item.displayName as string]));
        return { ...current, models: normalizeModels(ids, model), model, contextWindow: window ?? null, modelNames: { ...current.modelNames, ...names } };
      });
      say(result.message);
    });

  const state = claudeState(status, busy === "launch" || busy === "stop" ? busy : null);
  const steps = setupSteps(status, active);
  const canLaunch = Boolean(status?.supported && status.nodeAvailable && status.caTrusted && active && !profileProblem(active));
  const showStop = Boolean(status?.running || status?.localProcess);

  return (
    <div className="cm-shell">
      <aside className="cm-side">
        <div className="cm-side-head" data-tauri-drag-region>
          <span className="cm-brand">ClaudeMom</span>
        </div>
        <div className="cm-side-label">上游</div>
        <nav className="cm-list" aria-label="上游">
          {book.profiles.map((profile) => (
            <button
              aria-current={profile.id === selectedId ? "true" : undefined}
              className="cm-item"
              key={profile.id}
              onClick={() => select(profile.id)}
              onDoubleClick={() => void bookCall("activate", "claude_mom_set_active", { id: profile.id }, profile.id)}
              title="双击设为当前"
              type="button"
            >
              <span className="cm-radio" data-on={profile.id === book.activeId || undefined} />
              <span className="cm-item-text">
                <span className="cm-item-name">{profile.name || hostOf(profile.baseUrl)}</span>
                <span className="cm-item-sub">{profile.model ? modelLabel(profile, profile.model) : hostOf(profile.baseUrl)}</span>
              </span>
              {profile.source !== "manual" ? <span className="cm-tag">{SOURCE_LABELS[profile.source] ?? profile.source}</span> : null}
            </button>
          ))}
          {draft && !draft.id ? (
            <div className="cm-item" aria-current="true">
              <span className="cm-radio" />
              <span className="cm-item-text"><span className="cm-item-name">新上游</span><span className="cm-item-sub">未保存</span></span>
            </div>
          ) : null}
          {!book.profiles.length && !draft ? <p className="cm-empty">还没有上游。手动添加，或从 cc-switch / Magpie / Codex++ 导入。</p> : null}
        </nav>
        <div className="cm-side-foot">
          <button className="cm-btn cm-btn-quiet" onClick={addProfile} type="button"><Plus />添加</button>
          <ImportMenu disabled={busy !== null} onPick={(source) => void bookCall("import", "claude_mom_import", { source }, selectedId)} />
        </div>
      </aside>

      <main className="cm-main">
        <header className="cm-toolbar" data-tauri-drag-region>
          <span className="cm-dot" data-tone={state.tone} />
          <div className="cm-toolbar-text" data-tauri-drag-region>
            <strong>{state.text}</strong>
            <span>
              {!status?.supported && status ? "需要先安装官方 Claude Desktop" : active ? `${active.name} · ${active.model ? modelLabel(active, active.model) : "未选模型"}` : "还没有上游"}
            </span>
          </div>
          <div className="cm-toolbar-actions">
            <button aria-label="重新检测" className="cm-icon" disabled={busy !== null} onClick={() => void run("detect", refreshStatus)} title="重新检测" type="button">
              <RefreshCw className={busy === "detect" ? "cm-spin" : undefined} />
            </button>
            {showStop ? (
              <button className="cm-btn" disabled={busy !== null} onClick={() => void claudeAction("stop")} type="button"><Square />停止</button>
            ) : null}
            <button className="cm-btn cm-btn-primary" disabled={busy !== null || !canLaunch || Boolean(status?.claudeRunning)} onClick={() => void claudeAction("launch")} title={status?.claudeRunning ? "先完全退出 Claude 再启动" : undefined} type="button">
              {busy === "launch" ? <Loader2 className="cm-spin" /> : <Play />}启动 Claude
            </button>
          </div>
        </header>

        {steps.length || status?.needsRestart || status?.warning ? (
          <div className="cm-banners">
            {steps.map((step) => (
              <div className="cm-banner" key={step.id}>
                <span>{step.text}</span>
                {step.id === "trust" ? (
                  <button className="cm-btn cm-btn-small" disabled={busy !== null} onClick={() => void claudeAction("trust")} type="button"><ShieldCheck />信任证书</button>
                ) : step.id === "upstream" && !draft ? (
                  <button className="cm-btn cm-btn-small" onClick={addProfile} type="button"><Plus />添加上游</button>
                ) : null}
              </div>
            ))}
            {status?.needsRestart ? <div className="cm-banner" data-tone="info"><span>设置变了：完全退出 Claude 后重新启动生效。</span></div> : null}
            {status?.warning && !steps.length ? <div className="cm-banner"><span>{status.warning}</span></div> : null}
          </div>
        ) : null}

        <div className="cm-tabs" role="tablist">
          <button aria-selected={tab === "upstream"} onClick={() => setTab("upstream")} role="tab" type="button">上游</button>
          <button aria-selected={tab === "claude"} onClick={() => setTab("claude")} role="tab" type="button">Claude 设置</button>
        </div>

        <section className="cm-body">
          {tab === "upstream" ? (
            draft ? (
              <UpstreamEditor
                active={draft.id !== "" && draft.id === book.activeId}
                busy={busy}
                dirty={dirty}
                draft={draft}
                onActivate={() => void bookCall("activate", "claude_mom_set_active", { id: draft.id }, draft.id)}
                onChange={setDraft}
                onDelete={() => void bookCall("delete", "claude_mom_delete_profile", { id: draft.id })}
                onDiscard={() => {
                  const saved = book.profiles.find((profile) => profile.id === draft.id);
                  if (saved) setDraft({ ...saved });
                  else acceptBook({ ...book, status: "ok", message: "" });
                }}
                onFetchModels={() => void fetchModels()}
                onSave={(activate) => void saveDraft(activate)}
              />
            ) : (
              <div className="cm-placeholder">
                <p>选一组上游，或者新建一组。</p>
                <button className="cm-btn" onClick={addProfile} type="button"><Plus />添加上游</button>
              </div>
            )
          ) : (
            <ClaudeSettings
              busy={busy}
              onAction={(action) => void claudeAction(action)}
              onConfigure={(patch) => void configure(patch)}
              onVoice={(enabled) => void setVoice(enabled)}
              status={status}
              update={update}
              version={version}
              onCheckUpdate={() => void runUpdateCheck()}
              onInstallUpdate={() => void runInstall()}
            />
          )}
        </section>

        <footer className="cm-status">
          <span>{status?.port ? `本地服务 · 端口 ${status.port}` : "本地服务未运行"}</span>
          {update.phase === "available" ? (
            <button className="cm-update-chip" onClick={() => void runInstall()} type="button">新版本 {update.version}，点此更新</button>
          ) : update.phase === "downloading" ? (
            <span className="cm-update-chip">正在更新到 {update.version}{update.percent != null ? ` · ${update.percent}%` : "…"}</span>
          ) : null}
          {notice ? (
            <span className="cm-notice" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
              {notice.text}
              <button aria-label="关闭提示" onClick={() => setNotice(null)} type="button"><X /></button>
            </span>
          ) : null}
        </footer>
      </main>
    </div>
  );
}

function ImportMenu({ disabled, onPick }: { disabled: boolean; onPick: (source: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="cm-menu-anchor" ref={ref}>
      <button aria-expanded={open} className="cm-btn cm-btn-quiet" disabled={disabled} onClick={() => setOpen((value) => !value)} type="button">
        <Download />导入<ChevronDown className="cm-chevron" />
      </button>
      {open ? (
        <div className="cm-menu" role="menu">
          {IMPORT_SOURCES.map((source) => (
            <button key={source.id} onClick={() => { setOpen(false); onPick(source.id); }} role="menuitem" type="button">
              <strong>{source.label}</strong>
              <span>{source.detail}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="cm-field">
      <span className="cm-field-label">{label}</span>
      <span className="cm-field-control">{children}</span>
      {hint ? <span className="cm-field-hint">{hint}</span> : null}
    </label>
  );
}

function UpstreamEditor({ draft, active, dirty, busy, onChange, onSave, onActivate, onDelete, onDiscard, onFetchModels }: {
  draft: UpstreamProfile;
  active: boolean;
  dirty: boolean;
  busy: string | null;
  onChange: (next: UpstreamProfile) => void;
  onSave: (activate: boolean) => void;
  onActivate: () => void;
  onDelete: () => void;
  onDiscard: () => void;
  onFetchModels: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [newModel, setNewModel] = useState("");
  // 地址和 Key 填好以后很少改：默认收成一行，新建或没填时才展开。
  const [editConnection, setEditConnection] = useState(!draft.id || !draft.baseUrl);
  useEffect(() => setEditConnection(!draft.id || !draft.baseUrl), [draft.id]);
  const set = (patch: Partial<UpstreamProfile>) => onChange({ ...draft, ...patch });
  const preset = WINDOW_PRESETS.find((item) => item.value === draft.contextWindow);
  const options = draft.model && !draft.models.includes(draft.model) ? [draft.model, ...draft.models] : draft.models;
  const addModel = () => {
    const model = newModel.trim();
    if (!model) return;
    set({ models: normalizeModels([...draft.models, model]), model: draft.model || model });
    setNewModel("");
  };
  return (
    <div className="cm-editor">
      <div className="cm-editor-head">
        <input aria-label="名称" className="cm-title-input" onChange={(event) => set({ name: event.currentTarget.value })} placeholder={hostOf(draft.baseUrl) || "新上游"} value={draft.name} />
        {active ? <span className="cm-tag" data-tone="ok"><Check />使用中</span> : null}
      </div>

      <section className="cm-card">
        <div className="cm-card-label">连接</div>
        {editConnection ? (
          <div className="cm-form">
            <Field label="Base URL">
              <input autoComplete="off" onChange={(event) => set({ baseUrl: event.currentTarget.value })} placeholder="https://api.example.com" spellCheck={false} value={draft.baseUrl} />
            </Field>
            <Field label="Key">
              <input autoComplete="off" onChange={(event) => set({ apiKey: event.currentTarget.value })} placeholder="sk-…" spellCheck={false} type={showKey ? "text" : "password"} value={draft.apiKey} />
              <button aria-label={showKey ? "隐藏 Key" : "显示 Key"} className="cm-icon" onClick={() => setShowKey((value) => !value)} type="button">{showKey ? <EyeOff /> : <Eye />}</button>
            </Field>
          </div>
        ) : (
          <div className="cm-card-line">
            <span className="cm-mono cm-ellipsis" title={draft.baseUrl}>{draft.baseUrl}</span>
            {draft.source !== "manual" ? <span className="cm-tag">来自 {SOURCE_LABELS[draft.source] ?? draft.source}</span> : null}
            <button className="cm-link" onClick={() => setEditConnection(true)} type="button">修改</button>
          </div>
        )}
      </section>

      <section className="cm-card">
        <div className="cm-card-label">模型</div>
        <div className="cm-card-line">
          {options.length ? (
            <select aria-label="默认模型" className="cm-grow" onChange={(event) => set({ model: event.currentTarget.value })} value={draft.model}>
              {!draft.model ? <option value="">选一个默认模型</option> : null}
              {options.map((model) => <option key={model} value={model}>{modelLabel(draft, model)}</option>)}
            </select>
          ) : (
            <input aria-label="默认模型" className="cm-grow" onChange={(event) => set({ model: event.currentTarget.value })} placeholder="先拉取模型，或直接填模型名" spellCheck={false} value={draft.model} />
          )}
          <button aria-label="拉取模型" className="cm-icon" disabled={busy !== null || !draft.baseUrl.trim()} onClick={onFetchModels} title="从上游拉取模型列表" type="button">
            {busy === "models" ? <Loader2 className="cm-spin" /> : <RefreshCw />}
          </button>
        </div>
        {draft.models.length > 1 ? <p className="cm-field-hint">在 Claude 里还能切换另外 {draft.models.length - 1} 个模型。</p> : null}
      </section>

      <details className="cm-more">
        <summary>高级</summary>
        <div className="cm-form">
          <Field hint="标题生成等小任务用，留空同默认模型" label="快速模型">
            <select onChange={(event) => set({ smallModel: event.currentTarget.value })} value={draft.smallModel}>
              <option value="">同默认模型</option>
              {options.map((model) => <option key={model} value={model}>{modelLabel(draft, model)}</option>)}
            </select>
          </Field>
          <Field label="上下文窗口">
            <select onChange={(event) => set({ contextWindow: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) })} value={draft.contextWindow == null ? "" : String(draft.contextWindow)}>
              {WINDOW_PRESETS.map((item) => <option key={item.label} value={item.value == null ? "" : String(item.value)}>{item.label}</option>)}
              {!preset && draft.contextWindow ? <option value={String(draft.contextWindow)}>{formatWindow(draft.contextWindow)}</option> : null}
            </select>
          </Field>
          <div className="cm-field">
            <span className="cm-field-label">可选模型</span>
            <div className="cm-chips">
              {draft.models.map((model) => (
                <span className="cm-chip" data-primary={model === draft.model || undefined} key={model}>
                  <button onClick={() => set({ model })} title={`${model}（点一下设为默认）`} type="button">{modelLabel(draft, model)}</button>
                  <button aria-label={`移除 ${model}`} onClick={() => set({ models: draft.models.filter((item) => item !== model), model: draft.model === model ? "" : draft.model })} type="button"><X /></button>
                </span>
              ))}
              <input
                aria-label="添加模型"
                className="cm-chip-input"
                onChange={(event) => setNewModel(event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addModel(); } }}
                placeholder="添加模型，回车"
                spellCheck={false}
                value={newModel}
              />
            </div>
          </div>
          {draft.id ? (
            <div className="cm-row-actions">
              <button className="cm-btn cm-btn-small cm-btn-danger" disabled={busy !== null} onClick={onDelete} type="button"><Trash2 />删除这组上游</button>
            </div>
          ) : null}
        </div>
      </details>

      {dirty || (draft.id && !active) ? (
        <div className="cm-editor-foot">
          <span className="cm-spacer" />
          {dirty ? <button className="cm-btn cm-btn-quiet" disabled={busy !== null} onClick={onDiscard} type="button">放弃修改</button> : null}
          {!dirty && draft.id && !active ? <button className="cm-btn cm-btn-primary" disabled={busy !== null} onClick={onActivate} type="button">使用这组</button> : null}
          {dirty ? <button className="cm-btn" disabled={busy !== null} onClick={() => onSave(false)} type="button">保存</button> : null}
          {dirty ? <button className="cm-btn cm-btn-primary" disabled={busy !== null} onClick={() => onSave(true)} type="button">保存并使用</button> : null}
        </div>
      ) : null}
    </div>
  );
}

function Toggle({ label, detail, hint, checked, disabled, onChange }: { label: string; detail?: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="cm-toggle-row" title={detail}>
      <span className="cm-toggle-text">
        <span>{label}</span>
        {hint ? <span className="cm-field-hint">{hint}</span> : null}
      </span>
      <input checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} type="checkbox" />
      <span aria-hidden="true" className="cm-switch" />
    </label>
  );
}

type ModelState = { modelReady: boolean; phase?: string; completedBytes?: number; totalBytes?: number; message?: string };

/** 本地 SenseVoice 模型：状态、下载（约 230MB，和 Codex++ 共用 ~/.codex/speech-to-text）。 */
function VoiceModel({ onReady }: { onReady: () => void }) {
  const [state, setState] = useState<ModelState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setState(await invoke<ModelState>("dictation_local_model_status")); } catch (cause) { setError(errorText(cause)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const downloading = state?.phase === "downloading";
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void refresh(), 1000);
    return () => clearInterval(timer);
  }, [downloading, refresh]);
  const download = async () => {
    setError(null);
    setState((current) => ({ ...(current ?? { modelReady: false }), phase: "downloading", completedBytes: 0 }));
    try {
      const result = await invoke<CommandResult<ModelState>>("download_dictation_local_model");
      if (!isOk(result)) setError(result.message);
      else onReady();
    } catch (cause) {
      setError(errorText(cause));
    }
    await refresh();
  };
  if (!state) return null;
  const percent = state.totalBytes ? Math.min(100, Math.round(((state.completedBytes ?? 0) / state.totalBytes) * 100)) : 0;
  return (
    <div className="cm-row-actions cm-voice-model">
      <span className="cm-field-hint">
        {state.modelReady ? "本地语音模型（SenseVoice）已就绪。" : downloading ? `正在下载本地语音模型… ${percent}%` : "需要先下载本地语音模型（SenseVoice，约 230MB）。"}
        {error ? ` ${error}` : ""}
      </span>
      {!state.modelReady && !downloading ? <button className="cm-btn cm-btn-small" onClick={() => void download()} type="button"><Download />下载模型</button> : null}
      {downloading ? <Loader2 className="cm-spin" /> : null}
    </div>
  );
}

function ClaudeSettings({ status, busy, onConfigure, onAction, onVoice, update, version, onCheckUpdate, onInstallUpdate }: {
  status: ClaudeStatus | null;
  busy: string | null;
  onConfigure: (patch: Partial<ClaudeConfig>) => void;
  onAction: (action: ClaudeAction) => void;
  onVoice: (enabled: boolean) => void;
  update: UpdateState;
  version: string;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
}) {
  if (!status) return <div className="cm-placeholder"><Loader2 className="cm-spin" /></div>;
  const config = status.config;
  const disabled = busy !== null || !status.supported;
  const text = (key: "displayName" | "email", placeholder: string, label: string, type = "text") => (
    <Field label={label}>
      <input
        defaultValue={config[key] ?? ""}
        disabled={disabled}
        key={config[key] ?? ""}
        onBlur={(event) => { if (event.currentTarget.value !== (config[key] ?? "")) onConfigure({ [key]: event.currentTarget.value }); }}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        placeholder={placeholder}
        type={type}
      />
    </Field>
  );
  return (
    <div className="cm-settings">
      <section className="cm-card">
        <Toggle checked={config.localization} disabled={disabled} label="界面汉化" onChange={(next) => onConfigure({ localization: next })} />
        <Toggle
          checked={config.voiceInput}
          detail="Claude 输入框里的麦克风，用本机 SenseVoice 转写，音频不出本机。改完重新启动 Claude 生效。"
          disabled={disabled}
          label="语音输入"
          onChange={onVoice}
        />
        {config.voiceInput && !status.dictationReady ? <VoiceModel onReady={() => onAction("prepare")} /> : null}
        <Toggle
          checked={config.importCliSessions ?? true}
          detail="启动 Claude 前，把终端、BaoCode 等命令行里建的会话加进左侧列表（已在列表里的、删过的不会重复加）。"
          disabled={disabled}
          label="显示命令行会话"
          onChange={(next) => onConfigure({ importCliSessions: next })}
        />
      </section>

      <details className="cm-more">
        <summary>会话</summary>
        <Toggle
          checked={config.codeShareHome ?? true}
          detail="开：Code 页签和命令行共用 ~/.claude（会话、MCP、插件是同一份；~/.claude/settings.json 里的接口地址会优先）。关：用独立目录，请求走这里选的上游。"
          disabled={disabled}
          label="和命令行共用 ~/.claude"
          onChange={(next) => onConfigure({ codeShareHome: next })}
        />
        <Toggle checked={config.sessionSync === true} detail="启动前同步 3p 模式与完整功能模式的 Code 会话" disabled={disabled} label="同步 3p 模式的会话" onChange={(next) => onConfigure({ sessionSync: next })} />
        <div className="cm-row-actions">
          <button className="cm-btn cm-btn-small" disabled={disabled || status.claudeRunning} onClick={() => onAction("sync_sessions")} type="button">立即同步</button>
        </div>
      </details>

      <details className="cm-more">
        <summary>账号显示</summary>
        <p className="cm-field-hint">只改 Claude 里显示的信息，下次启动生效。</p>
        {text("displayName", "Local User", "用户名")}
        {text("email", "local@claude.local", "邮箱", "email")}
        <Field label="套餐">
          <select disabled={disabled} onChange={(event) => onConfigure({ plan: event.currentTarget.value })} value={config.plan || "ultra"}>
            {["free", "pro", "max", "ultra"].map((plan) => <option key={plan} value={plan}>{plan[0].toUpperCase() + plan.slice(1)}</option>)}
          </select>
        </Field>
      </details>

      <details className="cm-more">
        <summary>高级</summary>
        <Toggle checked={config.hideUnroutedModels ?? true} detail="Claude 自带的 Opus / Sonnet 等条目会被换成默认模型" disabled={disabled} label="只显示上游的模型" onChange={(next) => onConfigure({ hideUnroutedModels: next })} />
        <Toggle checked={config.computerUse} detail="需要系统的 Spotlight 正常工作，否则 Claude 会卡住" disabled={disabled} label="电脑控制" onChange={(next) => onConfigure({ computerUse: next })} />
        <Toggle checked={config.backgroundMode} disabled={disabled} label="后台模式" onChange={(next) => onConfigure(next ? { backgroundMode: true } : { backgroundMode: false, forceBackgroundMode: false })} />
        <Toggle checked={config.forceBackgroundMode ?? false} detail="Claude 在较新的 macOS 上会提示「暂不支持后台模式」；打开后不再限制系统版本，未经 Claude 验证，可能不稳定" disabled={disabled} label="新系统也开后台模式" onChange={(next) => onConfigure({ forceBackgroundMode: next })} />
        <div className="cm-row-actions" title="本地服务用它接管 Claude 的请求，只在本机有效。">
          <span className="cm-field-hint cm-grow">本地证书：{status.caTrusted ? "已信任" : status.caReady ? "未信任" : "未准备"}</span>
          {!status.caReady ? <button className="cm-btn cm-btn-small" disabled={busy !== null} onClick={() => onAction("prepare")} type="button">准备</button> : null}
          {status.caTrusted
            ? <button className="cm-btn cm-btn-small" disabled={busy !== null} onClick={() => onAction("untrust")} type="button">取消信任</button>
            : <button className="cm-btn cm-btn-small" disabled={busy !== null} onClick={() => onAction("trust")} type="button"><ShieldCheck />信任</button>}
        </div>
      </details>

      <div className="cm-about">
        <span>ClaudeMom {version || ""}{status.version ? ` · Claude ${status.version}` : ""}</span>
        {update.phase === "available" ? (
          <button className="cm-link" onClick={onInstallUpdate} type="button">更新到 {update.version}</button>
        ) : (
          <button className="cm-link" disabled={update.phase === "checking" || update.phase === "downloading"} onClick={onCheckUpdate} type="button">
            {update.phase === "checking" ? "检查中…" : update.phase === "latest" ? "已是最新" : "检查更新"}
          </button>
        )}
      </div>
    </div>
  );
}
