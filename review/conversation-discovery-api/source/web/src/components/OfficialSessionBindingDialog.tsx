import { useState, type FormEvent } from "react";

import { useTaskboardI18n } from "../i18n";
import "./OfficialSessionBindingDialog.css";

export interface OfficialSessionVerification {
  source: string;
  live: false;
  available?: boolean;
  verified: boolean;
  cwdMatches: boolean | null;
  thread: {
    id: string;
    cwd: string | null;
    sessionId: string | null;
    projectId: string | null;
  };
}

export interface ExistingSessionBinding {
  threadId: string;
  source?: string;
  workspacePath?: string | null;
}

export interface OfficialConversationList {
  source: string;
  live: false;
  projectId: string;
  boardProjectId: string;
  scope: "directory" | "local" | "project";
  publicProject: { id: string; name: string | null } | null;
  pagesRead: number;
  complete: boolean;
  cwd: string;
  observedAt: string;
  archived: boolean;
  query: string | null;
  appProjectMembershipVerified: false;
  threads: Array<{
    id: string; cwd: string; name: string | null; createdAt: number | null; updatedAt: number | null;
    modelProvider: string | null; source: string | null; publicProjectId: string | null; cwdMatches: boolean;
  }>;
  nextCursor: string | null;
  timeUnit: "unix-seconds";
}

export interface OfficialSessionBindingDialogProps {
  initialBinding: ExistingSessionBinding | null;
  taskIdentifier: string;
  taskVersion: number;
  onVerify: (threadId: string) => Promise<OfficialSessionVerification>;
  onListConversations?: (input: { query: string; scope: "directory" | "local"; allPages?: boolean; cursor?: string }) => Promise<OfficialConversationList>;
  onBind: (verified: OfficialSessionVerification | null) => Promise<void>;
  onClose: () => void;
  onError?: (message: string) => void;
}

export function OfficialSessionBindingDialog({
  initialBinding, taskIdentifier, taskVersion, onVerify, onListConversations, onBind, onClose, onError,
}: OfficialSessionBindingDialogProps) {
  const { text, locale } = useTaskboardI18n();
  const [threadId, setThreadId] = useState(initialBinding?.threadId ?? "");
  const [selection, setSelection] = useState<{
    input: string; taskIdentifier: string; taskVersion: number; result: OfficialSessionVerification;
  } | null>(null);
  const [busy, setBusy] = useState<"verify" | "bind" | "unbind" | "list" | null>(null);
  const [confirmation, setConfirmation] = useState<"replace" | "unbind" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [conversationQuery, setConversationQuery] = useState("");
  const [conversationScope, setConversationScope] = useState<"directory" | "local">("directory");
  const [conversations, setConversations] = useState<{ query: string; scope: "directory" | "local"; data: OfficialConversationList } | null>(null);
  const [candidate, setCandidate] = useState<OfficialConversationList["threads"][number] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const sameConversationSearch = conversations?.query === conversationQuery.trim() && conversations.scope === conversationScope;
  const result = selection?.result;
  const sameTaskVersion = selection?.taskIdentifier === taskIdentifier && selection.taskVersion === taskVersion;
  const canBind = Boolean(result?.verified && result.live === false && result.available !== false
    && result.cwdMatches !== false && result.thread.id === threadId.trim()
    && selection?.input === threadId.trim() && sameTaskVersion);

  function report(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    setError(message);
    onError?.(message);
  }

  async function listConversations(cursor?: string, allPages = false, scopeOverride?: "local") {
    if (!onListConversations) return;
    if (cursor && !sameConversationSearch) return;
    const query = cursor && conversations ? conversations.query : conversationQuery.trim();
    const scope = scopeOverride ?? (cursor && conversations ? conversations.scope : conversationScope);
    if (scopeOverride) setConversationScope(scopeOverride);
    setBusy("list");
    setListError(null);
    setCandidate(null);
    try {
      const data = await onListConversations({ query, scope, allPages, ...(cursor ? { cursor } : {}) });
      const previous = cursor && conversations ? conversations.data : null;
      const unique = new Map<string, OfficialConversationList["threads"][number]>();
      for (const thread of [...(previous?.threads ?? []), ...data.threads]) {
        if (!unique.has(thread.id)) unique.set(thread.id, thread);
      }
      setConversations({ query, scope, data: { ...data, threads: [...unique.values()], pagesRead: (previous?.pagesRead ?? 0) + data.pagesRead } });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setListError(message); onError?.(message);
    } finally { setBusy(null); }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = threadId.trim();
    setBusy("verify");
    setSelection(null);
    setConfirmation(null);
    setError(null);
    setNotice(null);
    try {
      const verified = await onVerify(input);
      setSelection({ input, taskIdentifier, taskVersion, result: verified });
    } catch (cause) { report(cause); }
    finally { setBusy(null); }
  }

  async function bind() {
    if (!canBind || !result) return;
    setBusy("bind");
    setError(null);
    setNotice(null);
    try {
      await onBind(result);
      setConfirmation(null);
      setNotice(text("会话关联已保存。", "Conversation association saved."));
    } catch (cause) { report(cause); }
    finally { setBusy(null); }
  }

  async function unbind() {
    setBusy("unbind");
    setError(null);
    setNotice(null);
    try {
      await onBind(null);
      setConfirmation(null);
      setSelection(null);
      setNotice(text("会话关联已解除。", "Conversation association removed."));
    } catch (cause) { report(cause); }
    finally { setBusy(null); }
  }

  return (
    <div className="delete-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget && busy === null) onClose();
    }}>
      <section
        className="delete-dialog project-create-dialog official-session-binding-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="official-session-binding-title"
        aria-busy={busy !== null}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          if (busy === null) onClose();
        }}
      >
        <header className="official-session-binding-header">
          <h2 id="official-session-binding-title">{text("关联 Codex 会话", "Associate a Codex conversation")}</h2>
          <button className="button secondary" type="button" disabled={busy !== null} onClick={onClose}>{text("关闭", "Close")}</button>
        </header>
        <p>{taskIdentifier} · {text("任务版本", "Task version")} {taskVersion}</p>
        <p className="official-session-binding-note">{text("输入你明确选定的真实聊天 ID，核验公开来源后再关联。", "Enter the ID of a real conversation you explicitly selected, then verify its public source before associating it.")}</p>

        {initialBinding && <section className="official-session-binding-existing">
          <h3>{text("当前关联", "Current association")}</h3>
          <dl className="official-session-binding-fields">
            <dt>{text("会话 ID", "Conversation ID")}</dt><dd><code>{initialBinding.threadId}</code></dd>
            {initialBinding.source && <><dt>{text("保存的来源", "Stored source")}</dt><dd>{initialBinding.source}</dd></>}
            {initialBinding.workspacePath && <><dt>{text("保存的目录", "Stored directory")}</dt><dd>{initialBinding.workspacePath}</dd></>}
          </dl>
        </section>}

        {onListConversations && <section className="official-session-binding-picker">
          <button className="button secondary" type="button" disabled={busy !== null} onClick={() => setPickerOpen((current) => !current)}>{text("查询保存会话", "Find saved conversations")}</button>
          {pickerOpen && <>
            <p className="official-session-binding-note">{text("通过官方会话 API 查询未归档会话，覆盖全部模型服务商。当前目录未找到目标时，可跨目录补查；完整查询会读取全部分页并按会话 ID 去重。", "Search unarchived conversations across all model providers through the official conversation API. Search across directories when the target is missing; a complete query reads every page and deduplicates by conversation ID.")}</p>
            <p className="official-session-binding-note">{text("目录匹配仅作线索，候选归属由你确认。确认只填入会话 ID，不读取正文、不保存任务关联。", "Directory matches are only clues; you confirm candidate membership. Confirmation only fills the conversation ID, without reading messages or saving a task association.")}</p>
            <form className="official-session-binding-form official-session-binding-search" onSubmit={(event) => { event.preventDefault(); void listConversations(); }}>
              <fieldset disabled={busy !== null}>
                <label className="official-session-binding-scope"><span>{text("查询范围", "Search scope")}</span><select value={conversationScope} onChange={(event) => { setConversationScope(event.target.value as "directory" | "local"); setCandidate(null); }}>
                  <option value="directory">{text("当前目录", "Current directory")}</option>
                  <option value="local">{text("本机全部目录", "All local directories")}</option>
                </select></label>
                <label><span>{text("按会话名称查询（可留空）", "Conversation name query (optional)")}</span><input maxLength={256} value={conversationQuery} onChange={(event) => { setConversationQuery(event.target.value); setCandidate(null); }} /></label>
                <div className="official-session-binding-search-actions">
                  <button className="button secondary" type="submit">{busy === "list" ? text("查询中…", "Searching…") : text("查询一页", "Search one page")}</button>
                  <button className="button secondary" type="button" onClick={() => void listConversations(undefined, true)}>{text("查询全部分页", "Search all pages")}</button>
                </div>
              </fieldset>
            </form>
            {listError && <p className="official-session-binding-error" role="alert">{listError}</p>}
            {conversations && <>
              <p className="official-session-binding-note">{text("结果范围：", "Result scope: ")}{conversations.data.scope === "local" ? text("本机全部目录", "All local directories") : text("当前目录", "Current directory")}{conversations.query ? ` · ${text("名称：", "Name: ")}${conversations.query}` : ""}</p>
              <p className="official-session-binding-note">{text("对照目录：", "Reference directory: ")}{conversations.data.cwd}</p>
              <p>{text("来源：", "Source: ")}{conversations.data.source}</p>
              <p className="official-session-binding-note">{text("读取时间：", "Observed: ")}{new Date(conversations.data.observedAt).toLocaleString(locale)}</p>
              <p className="official-session-binding-note" role="status">{text(`已读取 ${conversations.data.pagesRead} 页，去重后 ${conversations.data.threads.length} 条`, `${conversations.data.pagesRead} pages read, ${conversations.data.threads.length} unique conversations`)} · {conversations.data.complete ? text("本查询分页已全部读取", "All pages of this query read") : text("还有下一页", "More pages available")}</p>
              <p className="official-session-binding-note">{text("App 侧栏项目归属：未核验。", "App sidebar project membership: unverified.")}</p>
              {!sameConversationSearch && <p className="official-session-binding-note">{text("查询条件已变化，请重新查询；当前仍展示上次查询结果。", "Search options changed. Search again; the displayed results are from the previous query.")}</p>}
              {conversations.data.threads.length === 0 && <p className="official-session-binding-note">{text("当前页没有匹配的会话。", "No matching conversation on this page.")}</p>}
              <ul className="official-session-binding-conversations">{conversations.data.threads.map((thread) => <li key={thread.id}>
                <button type="button" disabled={busy !== null || !sameConversationSearch} aria-pressed={candidate?.id === thread.id} onClick={() => {
                  setCandidate(thread); setSelection(null); setConfirmation(null); setError(null); setNotice(null);
                }}>
                  <strong>{thread.name || thread.id}</strong>
                  <span>{text("项目归属待你确认", "Project membership awaits your confirmation")}</span>
                  <code>{thread.id}</code>
                  <span>{thread.cwd}</span>
                  <span>{thread.cwdMatches ? text("目录线索：与对照目录一致", "Directory clue: matches the reference directory") : text("目录线索：与对照目录不同", "Directory clue: differs from the reference directory")}</span>
                  <span>{text("模型服务商：", "Model provider: ")}{thread.modelProvider ?? text("未提供", "Not provided")}{text(" · 会话来源：", " · Conversation source: ")}{thread.source ?? text("未提供", "Not provided")}</span>
                  <span>{text("公共接口项目字段：", "Public API project field: ")}{thread.publicProjectId ?? text("未提供", "Not provided")}</span>
                  {thread.updatedAt !== null && <time>{text("更新于：", "Updated: ")}{new Date(thread.updatedAt * 1000).toLocaleString(locale)}</time>}
                </button>
              </li>)}</ul>
              {candidate && sameConversationSearch && <section className="official-session-binding-result" aria-label={text("确认候选归属", "Confirm candidate membership")}>
                <h3>{text("确认候选归属", "Confirm candidate membership")}</h3>
                <p>{candidate.name || candidate.id}</p>
                <p><code>{candidate.id}</code><br />{candidate.cwd}</p>
                <p className="official-session-binding-note">{text("请确认这是当前项目的会话。此操作只填入 ID；正文读取和任务关联仍需分别操作。", "Confirm that this conversation belongs to the current project. This only fills the ID; reading messages and associating a task remain separate actions.")}</p>
                <button className="button secondary" type="button" disabled={busy !== null} onClick={() => {
                  setThreadId(candidate.id); setSelection(null); setConfirmation(null); setError(null); setCandidate(null);
                  setNotice(text("你已确认候选归属并填入会话 ID，尚未读取正文或保存关联。", "You confirmed candidate membership and filled the conversation ID. No messages were read and no association was saved."));
                  setPickerOpen(false);
                }}>{text("确认归属并填入 ID", "Confirm membership and fill ID")}</button>
              </section>}
              {conversations.data.nextCursor && <div className="official-session-binding-search-actions">
                <button className="button secondary" type="button" disabled={busy !== null || !sameConversationSearch} onClick={() => void listConversations(conversations.data.nextCursor!)}>{text("加载下一页", "Load next page")}</button>
                <button className="button secondary" type="button" disabled={busy !== null || !sameConversationSearch} onClick={() => void listConversations(conversations.data.nextCursor!, true)}>{text("读取剩余全部分页", "Read all remaining pages")}</button>
              </div>}
              {conversationScope === "directory" && <button className="button secondary" type="button" disabled={busy !== null} onClick={() => void listConversations(undefined, true, "local")}>{text("跨目录补查全部分页", "Search all pages across directories")}</button>}
            </>}
          </>}
        </section>}

        <form className="official-session-binding-form" onSubmit={(event) => void verify(event)}>
          <fieldset disabled={busy !== null}>
            <label><span>{text("目标真实聊天 ID", "Target real conversation ID")}</span><input
              autoFocus required maxLength={256} value={threadId}
              onChange={(event) => {
                setThreadId(event.target.value); setSelection(null); setConfirmation(null); setNotice(null); setError(null);
              }}
            /></label>
            <button className="button secondary" type="submit" disabled={!threadId.trim()}>{busy === "verify" ? text("核验中…", "Verifying…") : text("核验", "Verify")}</button>
          </fieldset>
        </form>

        {result && <section className="official-session-binding-result">
          <h3>{text("公开来源核验结果", "Public-source verification")}</h3>
          <dl className="official-session-binding-fields">
            <dt>{text("来源", "Source")}</dt><dd>{result.source === "persisted-official-app-server" ? text("公开 CLI 保存的会话元数据", "Persisted conversation metadata from the public CLI") : result.source}</dd>
            <dt>{text("实际会话 ID", "Actual conversation ID")}</dt><dd><code>{result.thread.id}</code></dd>
            {result.thread.cwd && <><dt>{text("实际工作目录", "Actual working directory")}</dt><dd>{result.thread.cwd}</dd></>}
            {result.thread.sessionId && <><dt>{text("会话 session ID", "Session ID")}</dt><dd><code>{result.thread.sessionId}</code></dd></>}
            {result.thread.projectId && <><dt>{text("实际项目 ID", "Actual project ID")}</dt><dd><code>{result.thread.projectId}</code></dd></>}
            <dt>{text("目录匹配", "Directory match")}</dt><dd>{result.cwdMatches === true ? text("与所选工作目录一致", "Matches the selected working directory") : result.cwdMatches === false ? text("与所选工作目录不一致，无法关联", "Does not match the selected working directory; association unavailable") : text("未进行目录匹配", "Directory matching was not performed")}</dd>
            <dt>{text("核验", "Verification")}</dt><dd>{result.verified ? text("公开来源已核验", "Public source verified") : text("未通过核验", "Verification did not pass")}</dd>
          </dl>
          <p>{text("这是保存的会话元数据，不是实时执行状态。接口未提供的身份字段保持为空。", "This is persisted conversation metadata, not live execution state. Identity fields not provided by the API remain empty.")}</p>
          {!sameTaskVersion && <p className="official-session-binding-error" role="alert">{text("任务版本已变化，请重新核验后再尝试关联。", "The task version changed. Verify again before attempting association.")}</p>}
        </section>}

        {error && <p className="official-session-binding-error" role="alert">{error}</p>}
        {notice && <p className="official-session-binding-notice" role="status">{notice}</p>}

        <footer className="official-session-binding-footer">
          {confirmation === "replace" ? <>
            <p>{text("确认替换当前关联：", "Confirm replacement of the current association: ")}<code>{initialBinding?.threadId}</code> → <code>{result?.thread.id}</code></p>
            <button className="button secondary" type="button" disabled={busy !== null} onClick={() => setConfirmation(null)}>{text("取消", "Cancel")}</button>
            <button className="button primary" type="button" disabled={busy !== null || !canBind} onClick={() => void bind()}>{busy === "bind" ? text("关联中…", "Associating…") : text("确认替换关联", "Confirm replacement")}</button>
          </> : confirmation === "unbind" ? <>
            <p>{text("确认解除此任务与该会话的关联：", "Confirm removal of this task's association with: ")}<code>{initialBinding?.threadId}</code></p>
            <button className="button secondary" type="button" disabled={busy !== null} onClick={() => setConfirmation(null)}>{text("取消", "Cancel")}</button>
            <button className="button danger" type="button" disabled={busy !== null || !initialBinding} onClick={() => void unbind()}>{busy === "unbind" ? text("解除中…", "Removing…") : text("确认解除关联", "Confirm removal")}</button>
          </> : <>
            {initialBinding && <button className="button secondary" type="button" disabled={busy !== null} onClick={() => { setConfirmation("unbind"); setError(null); setNotice(null); }}>{text("解除关联", "Remove association")}</button>}
            <button className="button primary" type="button" disabled={busy !== null || !canBind} onClick={() => {
              if (initialBinding && initialBinding.threadId !== result?.thread.id) setConfirmation("replace");
              else void bind();
            }}>{busy === "bind" ? text("关联中…", "Associating…") : text("关联此会话", "Associate this conversation")}</button>
          </>}
        </footer>
      </section>
    </div>
  );
}
