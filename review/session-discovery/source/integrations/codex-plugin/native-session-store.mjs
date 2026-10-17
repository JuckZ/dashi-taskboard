import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../../shared/api-fields.mjs";
import { createNativeSessions } from "./native-sessions.mjs";

const SOURCE = "persisted-official-app-server";
const version = z.number().int().positive();
const identifier = z.string().trim().min(1).max(256);
const verifyInput = z.object({ threadId: z.string().uuid(), projectId: identifier.optional(), issueId: identifier.optional() }).strict();
const bindInput = z.object({ version, userConfirmed: z.literal(true), source: z.literal(SOURCE), threadId: z.string().uuid() }).strict();
const migrateInput = z.object({ version, userConfirmed: z.literal(true) }).strict();
const clearInput = migrateInput.extend({ clear: z.literal(true) });
const pageInput = z.object({ before: z.string().min(1).max(4_096).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }).strict();
const listInput = z.object({ projectId: identifier, issueId: identifier.optional(), scope: z.enum(["directory", "local"]).default("directory"), query: z.string().trim().max(256).optional(), cursor: z.string().min(1).max(4_096).optional(),
  archived: z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean().default(false)), limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();
const itemsInput = pageInput.extend({ turnId: identifier });
const sources = new Set(["official-agent", SOURCE]);
const disconnected = (reason) => ({ source: SOURCE, live: false, available: false, reason, execution: null });

function parse(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "INVALID_NATIVE_SESSION_INPUT", "Use an explicit conversation ID, current version and user confirmation for binding changes");
  return parsed.data;
}

export function createNativeSessionStore({ database, getWorkspace, clientFactory }) {
  const sqlite = database.database;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS official_persisted_execution_snapshots (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    PRIMARY KEY(thread_id, turn_id, source)
  );`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS official_persisted_turn_metadata (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    source TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    metadata TEXT NOT NULL,
    PRIMARY KEY(thread_id, turn_id, source)
  );`);

  function requireTask(id, expectedVersion) {
    const task = database.getTask(id);
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", "Task does not exist");
    if (expectedVersion !== undefined && task.version !== expectedVersion) throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", { expectedVersion, actualVersion: task.version });
    return task;
  }

  function getBinding(id) {
    const task = requireTask(id);
    const binding = task.officialConversationBinding;
    return binding?.threadId === task.threadId && binding.userConfirmed === true && sources.has(binding.source)
      && (binding.source !== SOURCE || binding.verified === true) ? binding : null;
  }

  const sessions = createNativeSessions({ getBinding, ...(clientFactory ? { clientFactory } : {}) });

  function requireSameBinding(id, binding) {
    const current = getBinding(id);
    if (current?.threadId !== binding.threadId || current.source !== binding.source || current.workspacePath !== binding.workspacePath) throw new ApiError(409, "CONVERSATION_BINDING_CHANGED", "Conversation binding changed while its stored result was being read");
  }

  async function expectedWorkspace(projectId, task) {
    if (task && projectId && task.projectId !== projectId) throw new ApiError(409, "TASK_PROJECT_MISMATCH", "The selected issue does not belong to this board project");
    const selectedProjectId = task?.projectId ?? projectId;
    const configured = selectedProjectId ? await getWorkspace(selectedProjectId) : null;
    return task?.developmentContext?.type === "worktree" ? task.developmentContext.path : configured;
  }

  async function listConversations(value) {
    const { projectId, issueId, ...input } = parse(listInput, value);
    const cwd = await expectedWorkspace(projectId, issueId ? requireTask(issueId) : null);
    if (!cwd) throw new ApiError(409, "WORKSPACE_NOT_CONFIGURED", "Configure the project's actual local directory before listing conversations");
    return { ...await sessions.listConversations({ ...input, cwd }), projectId, boardProjectId: projectId };
  }

  async function listTurns(id, value = {}) {
    const input = parse(pageInput, value);
    const binding = getBinding(id);
    if (!binding) return disconnected("verified_explicit_binding_required");
    const page = await sessions.listPersistedTurns({ issueId: id, ...input });
    if (!page.available) return page;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      requireSameBinding(id, binding);
      const save = sqlite.prepare(`INSERT INTO official_persisted_turn_metadata (thread_id,turn_id,source,observed_at,metadata)
        VALUES (?,?,?,?,?) ON CONFLICT(thread_id,turn_id,source) DO UPDATE SET observed_at=excluded.observed_at,metadata=excluded.metadata`);
      for (const turn of page.turns) save.run(binding.threadId, turn.id, SOURCE, page.observedAt, JSON.stringify(turn));
      sqlite.exec("COMMIT");
      return page;
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }

  async function readItems(id, value) {
    const { turnId, ...input } = parse(itemsInput, value);
    const binding = getBinding(id);
    if (!binding) return disconnected("verified_explicit_binding_required");
    if (binding.codexProjectKind === "remote" || (binding.codexHostId && binding.codexHostId !== "local")) return disconnected("local_persisted_conversation_required");
    const row = sqlite.prepare("SELECT observed_at,metadata FROM official_persisted_turn_metadata WHERE thread_id=? AND turn_id=? AND source=?").get(binding.threadId, turnId, SOURCE);
    if (!row) throw new ApiError(409, "PERSISTED_TURN_SELECTION_REQUIRED", "Query this bound conversation's turn list before selecting its result");
    const page = await sessions.readPersistedItems({ issueId: id, turn: JSON.parse(row.metadata), ...input });
    requireSameBinding(id, binding);
    return { ...page, turnObservedAt: row.observed_at };
  }

  function previousBinding(task) {
    if (task.officialConversationBinding) return task.officialConversationBinding;
    if (!task.threadId) return null;
    const row = sqlite.prepare("SELECT thread_codex_project_id,thread_codex_project_kind,thread_codex_host_id,thread_workspace_path FROM tasks WHERE id=?").get(task.id);
    return { threadId: task.threadId, source: "legacy-binding", codexProjectId: row.thread_codex_project_id,
      codexProjectKind: row.thread_codex_project_kind, codexHostId: row.thread_codex_host_id, workspacePath: row.thread_workspace_path };
  }

  function requireLocalPrevious(previous) {
    if (previous?.codexProjectKind === "remote" || (previous?.codexHostId && previous.codexHostId !== "local")) throw new ApiError(409, "LOCAL_NATIVE_CONVERSATION_REQUIRED", "Keep this remote binding unchanged; the public local reader cannot verify it");
  }

  function saveBinding(task, input, verified, actor) {
    if (!verified.verified || verified.thread.id !== input.threadId) throw new ApiError(409, "NATIVE_CONVERSATION_NOT_VERIFIED", "The public API did not verify the selected conversation and directory");
    const previous = task.threadId === input.threadId ? previousBinding(task) : null;
    const retained = Object.fromEntries(["codexProjectId", "codexProjectKind", "codexHostId", "turnId"].map((field) => [field, previous?.[field] ?? null]));
    const fieldSources = Object.fromEntries(Object.entries(retained).filter(([, value]) => value !== null)
      .map(([field]) => [field, previous.fieldSources?.[field] ?? (previous.source === SOURCE ? "previous-binding" : previous.source)]));
    if (verified.thread.projectId) { retained.codexProjectId = verified.thread.projectId; fieldSources.codexProjectId = SOURCE; }
    fieldSources.threadId = SOURCE;
    fieldSources.workspacePath = SOURCE;
    return database.bindConversation(task.id, input.version, {
      version: input.version, userConfirmed: true, source: SOURCE, verified: true,
      officialMethod: "thread/read", threadId: verified.thread.id, workspacePath: verified.thread.cwd,
      ...retained, fieldSources, verifiedFields: ["threadId", "workspacePath", ...(verified.thread.projectId ? ["codexProjectId"] : [])],
      ...(previous ? { previousBinding: previous.source === SOURCE ? previous.previousBinding ?? previous : previous } : {}),
      metadata: verified.thread, ...(verified.cli ? { cli: verified.cli } : {}),
    }, actor);
  }

  async function verifyConversation(value) {
    const input = parse(verifyInput, value);
    const expectedCwd = await expectedWorkspace(input.projectId, input.issueId ? requireTask(input.issueId) : null);
    return sessions.verifyConversation({ threadId: input.threadId, ...(expectedCwd ? { expectedCwd } : {}) });
  }

  async function bind(id, body, actor) {
    const input = parse(bindInput, body);
    const task = requireTask(id, input.version);
    if (task.threadId === input.threadId) requireLocalPrevious(previousBinding(task));
    // Verify again here; a prior UI verification response is not binding authority.
    const expectedCwd = await expectedWorkspace(task.projectId, task);
    const verified = await sessions.verifyConversation({ threadId: input.threadId, ...(expectedCwd ? { expectedCwd } : {}) });
    return saveBinding(task, input, verified, actor);
  }

  async function migrateExisting(id, body, actor) {
    const input = parse(migrateInput, body);
    const task = requireTask(id, input.version);
    const previous = previousBinding(task);
    if (!task.threadId) throw new ApiError(409, "CONVERSATION_BINDING_REQUIRED", "The issue has no existing conversation to verify");
    requireLocalPrevious(previous);
    const bindingInput = parse(bindInput, { ...input, source: SOURCE, threadId: task.threadId });
    const expectedCwd = await expectedWorkspace(task.projectId, task) ?? previous?.workspacePath;
    const verified = await sessions.verifyConversation({ threadId: bindingInput.threadId, ...(expectedCwd ? { expectedCwd } : {}) });
    return saveBinding(task, bindingInput, verified, actor);
  }

  function clear(id, body, actor) {
    const input = parse(clearInput, body);
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const task = requireTask(id, input.version);
      const previous = previousBinding(task);
      const timestamp = new Date().toISOString();
      const changed = sqlite.prepare(`UPDATE tasks SET thread_id = NULL, thread_codex_project_id = NULL,
        thread_codex_project_kind = NULL, thread_codex_host_id = NULL, thread_workspace_path = NULL,
        version = version + 1, updated_at = ? WHERE id = ? AND version = ?`).run(timestamp, task.id, input.version);
      if (changed.changes !== 1) throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client");
      sqlite.prepare("DELETE FROM task_conversation_bindings WHERE task_id = ?").run(task.id);
      sqlite.prepare(`INSERT INTO task_activities (id,task_id,actor_type,actor_id,actor_name,actor_avatar_url,changes,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), task.id, actor.type, actor.id, actor.name, actor.avatarUrl ?? null,
        JSON.stringify([{ field: "officialConversationBinding", before: previous, after: null }]), timestamp);
      sqlite.exec("COMMIT");
      return database.getTask(task.id);
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }

  async function readExecution(id, { refresh = true } = {}) {
    const binding = getBinding(id);
    if (!binding) return disconnected("verified_explicit_binding_required");
    if (binding.codexProjectKind === "remote" || (binding.codexHostId && binding.codexHostId !== "local")) return disconnected("local_persisted_conversation_required");
    if (!refresh) {
      const row = sqlite.prepare(`SELECT snapshot FROM official_persisted_execution_snapshots
        WHERE thread_id = ? AND source = ? ORDER BY observed_at DESC LIMIT 1`).get(binding.threadId, SOURCE);
      return row ? { ...JSON.parse(row.snapshot), cached: true } : disconnected("no_saved_observation");
    }
    const snapshot = await sessions.readPersistedExecution({ issueId: id });
    if (!snapshot.available) return snapshot;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const current = getBinding(id);
      if (current?.threadId !== binding.threadId || current.source !== binding.source || current.workspacePath !== binding.workspacePath) throw new ApiError(409, "CONVERSATION_BINDING_CHANGED", "Conversation binding changed while its stored result was being read");
      const observedAt = snapshot.observedAt ?? new Date().toISOString();
      const saved = { ...snapshot, observedAt };
      sqlite.prepare(`INSERT INTO official_persisted_execution_snapshots (thread_id,turn_id,source,observed_at,snapshot)
        VALUES (?,?,?,?,?) ON CONFLICT(thread_id,turn_id,source) DO UPDATE SET observed_at=excluded.observed_at,snapshot=excluded.snapshot
        WHERE excluded.observed_at >= official_persisted_execution_snapshots.observed_at`).run(binding.threadId, snapshot.execution?.turnId ?? "", SOURCE, observedAt, JSON.stringify(saved));
      sqlite.exec("COMMIT");
      return { ...saved, cached: false };
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }

  return { getProjects: sessions.getProjects, getAccount: sessions.getAccount, getModels: sessions.getModels, getUsage: sessions.getUsage, listConversations, listTurns, readItems, verifyConversation, bind, migrateExisting, clear, readExecution, getBinding };
}
