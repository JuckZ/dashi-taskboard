import path from "node:path";
import { z } from "zod";
import { CodexAppServer } from "../../server/codex-app-server.mjs";
import { ApiError } from "../../shared/api-fields.mjs";
import { resolvePublicCodexCli } from "./public-codex-cli.mjs";

const SOURCE = "persisted-official-app-server";
const identifier = z.string().trim().min(1).max(256);
const conversationInput = z.object({ threadId: identifier, expectedCwd: z.string().min(1).optional() }).strict();
const executionInput = z.object({ issueId: identifier }).strict();
const cursor = z.string().min(1).max(4_096).optional();
const pageLimit = z.number().int().min(1).max(50);
const listInput = z.object({ cwd: z.string().min(1), scope: z.enum(["directory", "local", "project"]).default("directory"), publicProjectId: identifier.optional(), allPages: z.boolean().default(false), query: z.string().trim().max(256).optional(), cursor, archived: z.boolean().default(false), limit: pageLimit.default(20) }).strict();
const turnsInput = executionInput.extend({ before: cursor, limit: pageLimit.default(20) });
const turnMetadata = z.object({ id: identifier, status: z.string(), startedAt: z.number().nullable(), completedAt: z.number().nullable(), durationMs: z.number().nullable() }).strict();
const itemsInput = executionInput.extend({ turn: turnMetadata, before: cursor, limit: pageLimit.default(32) });
const modelsInput = z.object({ cursor, limit: z.coerce.number().int().min(1).max(50).default(50) }).strict();
const verifiedSources = new Set(["official-agent", SOURCE]);
const summaryLimit = 4_000;
const limitations = [
  "Stored local conversation data, not a subscription to desktop execution events.",
  "The independent engine's notLoaded/idle/active state is not desktop execution state.",
  "A completed or interrupted turn does not mean the Taskboard issue is accepted.",
];

function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "INVALID_NATIVE_SESSION_INPUT", "Provide an explicit conversation or issue identifier");
  return parsed.data;
}

function sameDirectory(left, right) {
  if (typeof left !== "string" || !path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function metadata(raw, input) {
  if (!raw || raw.id !== input.threadId) throw new ApiError(409, "NATIVE_SESSION_ID_MISMATCH", "The public API did not return the requested conversation identity");
  const cwdMatches = input.expectedCwd ? sameDirectory(raw.cwd, input.expectedCwd) : null;
  return {
    source: SOURCE, live: false, available: true, verified: cwdMatches !== false,
    cwdMatches, thread: {
      id: raw.id, cwd: typeof raw.cwd === "string" ? raw.cwd : null,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
      projectId: typeof raw.projectId === "string" ? raw.projectId : null,
    }, limitations,
  };
}

function textOutput(contents, type) {
  if (!Array.isArray(contents)) return null;
  const texts = contents.filter((content) => content?.type === type && typeof content.text === "string").map((content) => content.text);
  return texts.length ? texts.join("\n") : null;
}

function savedResultItem(entry) {
  const { item } = entry;
  let kind, text;
  if (item.type === "agentMessage" && typeof item.text === "string") {
    kind = "assistant-message"; text = item.text;
  } else if (item.type === "commandExecution") {
    kind = "command-output"; text = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : null;
  } else if (item.type === "dynamicToolCall") {
    kind = "tool-output"; text = textOutput(item.contentItems, "inputText");
  } else if (item.type === "mcpToolCall") {
    kind = "tool-output"; text = textOutput(item.result?.content, "text");
  } else return null;
  return {
    itemId: item.id, turnId: entry.turnId, kind, itemType: item.type,
    phase: item.type === "agentMessage" ? item.phase ?? null : null,
    status: typeof item.status === "string" ? item.status : null,
    exitCode: item.type === "commandExecution" && typeof item.exitCode === "number" ? item.exitCode : null,
    success: item.type === "dynamicToolCall" && typeof item.success === "boolean" ? item.success : null,
    text, startedAtMs: entry.startedAtMs ?? null, completedAtMs: entry.completedAtMs ?? null,
  };
}

function resultSummary(entries) {
  const messages = entries.filter(({ item }) => item.type === "agentMessage" && typeof item.text === "string" && item.text.trim());
  const message = messages.find(({ item }) => item.phase === "final_answer") ?? messages[0];
  let item, text, kind;
  if (message) {
    item = message.item;
    text = item.text;
    kind = "assistant-message";
  } else {
    // These fields are declared in the public ThreadItem JSON schema. Never
    // include user messages, reasoning, tool arguments or arbitrary item fields.
    for (const entry of entries) {
      if (entry.item.type === "commandExecution" && typeof entry.item.aggregatedOutput === "string" && entry.item.aggregatedOutput.trim()) {
        item = entry.item; text = item.aggregatedOutput; kind = "command-output"; break;
      }
      if (entry.item.type === "dynamicToolCall") {
        const output = textOutput(entry.item.contentItems, "inputText");
        if (output?.trim()) { item = entry.item; text = output; kind = "tool-output"; break; }
      }
      if (entry.item.type === "mcpToolCall") {
        const output = textOutput(entry.item.result?.content, "text");
        if (output?.trim()) { item = entry.item; text = output; kind = "tool-output"; break; }
      }
    }
  }
  return item ? {
    kind, itemId: item.id, phase: item.type === "agentMessage" ? item.phase ?? null : null,
    text: text.slice(0, summaryLimit), truncated: text.length > summaryLimit,
  } : null;
}

function pick(value, fields) {
  return Object.fromEntries(fields.map((field) => [field, value?.[field] ?? null]));
}

function rateLimitSnapshot(value) {
  if (!value) return null;
  return {
    ...pick(value, ["limitId", "limitName", "normalModelSlug", "planType", "rateLimitReachedType", "spendControlReached"]),
    primary: value.primary ? pick(value.primary, ["usedPercent", "windowDurationMins", "resetsAt"]) : null,
    secondary: value.secondary ? pick(value.secondary, ["usedPercent", "windowDurationMins", "resetsAt"]) : null,
    credits: value.credits ? pick(value.credits, ["hasCredits", "unlimited", "balance"]) : null,
  };
}

// getBinding reads the current Taskboard issue and its explicitly confirmed,
// officially verified binding. Return null for unverified legacy bindings;
// this reader never changes or discards those records.
export function createNativeSessions({ getBinding, executable, processEnv = process.env,
  clientFactory = async () => {
    const cli = await resolvePublicCodexCli({ explicit: executable, processEnv });
    const client = new CodexAppServer({ executable: cli.executable, processEnv });
    client.publicCli = cli;
    return client;
  },
} = {}) {
  async function withClient(action) {
    const client = await clientFactory();
    try {
      const result = await action(client);
      return { ...result, ...(client.publicCli ? { cli: client.publicCli } : {}) };
    }
    finally { await client.close(); }
  }

  async function publicRequest(client, method, params) {
    try { return await client.request(method, params); }
    catch (error) {
      throw new ApiError(409, "PUBLIC_NATIVE_SESSION_UNAVAILABLE", "The public CLI cannot read the requested data", {
        method, rpcCode: error.details?.code ?? error.rpcError?.code ?? null,
      });
    }
  }

  async function withBoundConversation(issueId, action) {
    const binding = await getBinding?.(issueId);
    const disconnected = (reason) => ({ source: SOURCE, live: false, available: false, reason, execution: null, limitations });
    if (!binding?.threadId || binding.userConfirmed !== true || !verifiedSources.has(binding.source)) return disconnected("verified_explicit_binding_required");
    if (binding.codexProjectKind === "remote" || (binding.codexHostId && binding.codexHostId !== "local")) return disconnected("local_persisted_conversation_required");
    const input = parse(conversationInput, { threadId: binding.threadId, ...(binding.workspacePath ? { expectedCwd: binding.workspacePath } : {}) });
    return withClient(async (client) => {
      const response = await publicRequest(client, "thread/read", { threadId: input.threadId, includeTurns: false });
      const verified = metadata(response.thread, input);
      if (!verified.verified) return { ...disconnected("workspace_mismatch"), thread: verified.thread, cwdMatches: false };
      return action(client, verified);
    });
  }

  return {
    async getProjects(value = {}) {
      const parsed = modelsInput.safeParse(value);
      if (!parsed.success) throw new ApiError(400, "INVALID_NATIVE_PROJECT_QUERY", "Native project discovery accepts only cursor and a limit from 1 to 50");
      const input = parsed.data;
      return withClient(async (client) => {
        const response = await publicRequest(client, "project/list", input);
        return { source: "public-independent-codex-cli", desktopIdentityParityVerified: false, directoryAvailabilityVerified: false,
          observedAt: new Date().toISOString(),
          projects: (response.data ?? []).map((project) => ({ id: project.id, name: project.name,
            roots: (project.roots ?? []).filter((root) => typeof root.path === "string" && path.isAbsolute(root.path)).map((root) => ({ path: root.path })),
          })), nextCursor: response.nextCursor ?? null,
        };
      });
    },

    async getAccount() {
      return withClient(async (client) => {
        const response = await publicRequest(client, "account/read", { refreshToken: false });
        const account = response.account;
        return { source: "public-independent-codex-cli", desktopAccountParityVerified: false, observedAt: new Date().toISOString(),
          account: !account ? null : account.type === "chatgpt" ? pick(account, ["type", "email", "planType"]) : { type: account.type ?? null },
          workspaceRouting: account?.type === "chatgpt" && response.workspaceRouting ? pick(response.workspaceRouting, ["chatgptAccountId"]) : null,
        };
      });
    },

    async getModels(value = {}) {
      const input = parse(modelsInput, value);
      return withClient(async (client) => {
        const response = await publicRequest(client, "model/list", { ...input, includeHidden: false });
        return { source: "public-independent-codex-cli", desktopPickerParityVerified: false, observedAt: new Date().toISOString(),
          models: (response.data ?? []).map((model) => ({
            ...pick(model, ["id", "model", "displayName", "description", "defaultReasoningEffort", "inputModalities", "hidden", "isDefault", "defaultServiceTier"]),
            supportedReasoningEfforts: model.supportedReasoningEfforts?.map((effort) => pick(effort, ["reasoningEffort", "description"])) ?? null,
            serviceTiers: model.serviceTiers?.map((tier) => pick(tier, ["id", "name", "description"])) ?? null,
          })), nextCursor: response.nextCursor ?? null,
        };
      });
    },

    async getUsage() {
      return withClient(async (client) => {
        const response = await publicRequest(client, "account/rateLimits/read", {});
        return { source: "public-independent-codex-cli", desktopUsageParityVerified: false, observedAt: new Date().toISOString(),
          ordinaryUsageAllowed: response.ordinaryUsageAllowed ?? null,
          rateLimits: rateLimitSnapshot(response.rateLimits),
          rateLimitsByLimitId: response.rateLimitsByLimitId ? Object.fromEntries(Object.entries(response.rateLimitsByLimitId).map(([id, snapshot]) => [id, rateLimitSnapshot(snapshot)])) : null,
        };
      });
    },

    async listConversations(value) {
      const input = parse(listInput, value);
      if (!path.isAbsolute(input.cwd)) throw new ApiError(400, "WORKSPACE_NOT_CONFIGURED", "Configure the project's actual local directory before listing conversations");
      if ((input.scope === "project") !== Boolean(input.publicProjectId)) throw new ApiError(400, "PUBLIC_PROJECT_SELECTION_REQUIRED", "Use scope project with an explicitly selected ID returned by the official project/list API");
      const cwd = path.resolve(input.cwd);
      return withClient(async (client) => {
        let publicProject = null;
        if (input.scope === "project") {
          const response = await publicRequest(client, "project/read", { projectId: input.publicProjectId });
          if (response.project?.id !== input.publicProjectId) throw new ApiError(409, "NATIVE_PROJECT_ID_MISMATCH", "The official API did not return the selected public project identity");
          publicProject = { id: response.project.id, name: response.project.name ?? null };
        }
        const threads = new Map();
        const cursors = new Set();
        let nextCursor = input.cursor ?? null;
        let pagesRead = 0;
        do {
          if (nextCursor) {
            if (cursors.has(nextCursor)) throw new ApiError(409, "NATIVE_CONVERSATION_CURSOR_REPEATED", "The official API repeated a cursor before completing the query");
            cursors.add(nextCursor);
          }
          const response = await publicRequest(client, "thread/list", {
            ...(input.scope === "directory" ? { cwd } : {}),
            ...(publicProject ? { projectId: publicProject.id } : {}),
            archived: input.archived, limit: input.limit, sortKey: "updated_at", sortDirection: "desc",
            // Explicitly include every provider, including custom providers.
            modelProviders: [],
            sourceKinds: ["cli", "vscode", "appServer"], useStateDbOnly: true,
            ...(nextCursor ? { cursor: nextCursor } : {}), ...(input.query ? { searchTerm: input.query } : {}),
          });
          for (const thread of response.data ?? []) {
            if (input.scope === "directory" && !sameDirectory(thread.cwd, cwd)) continue;
            if (!threads.has(thread.id)) threads.set(thread.id, thread);
          }
          pagesRead += 1;
          nextCursor = response.nextCursor ?? null;
        } while (input.allPages && nextCursor);
        return { source: SOURCE, live: false, cwd, scope: input.scope,
          observedAt: new Date().toISOString(), archived: input.archived, query: input.query ?? null,
          publicProject, pagesRead, complete: nextCursor === null,
          appProjectMembershipVerified: false, timeUnit: "unix-seconds", limitations: [...limitations,
            "Directory matches are metadata clues, not verified Codex App sidebar project membership.",
            "Public project IDs are verified only against the official public API, not desktop App project IDs. Candidate membership requires user confirmation.",
            "Results cover the selected archive, title and scope. complete means nextCursor is null, not that every desktop sidebar chat was enumerated.",
          ],
          threads: [...threads.values()].map((thread) => ({
            id: thread.id, cwd: thread.cwd, name: typeof thread.name === "string" ? thread.name : null,
            modelProvider: typeof thread.modelProvider === "string" ? thread.modelProvider : null,
            source: typeof thread.source === "string" ? thread.source : null,
            publicProjectId: typeof thread.projectId === "string" ? thread.projectId : null,
            cwdMatches: sameDirectory(thread.cwd, cwd),
            createdAt: thread.createdAt ?? null, updatedAt: thread.updatedAt ?? null,
            status: thread.status?.type ? { type: thread.status.type } : null, archived: input.archived,
          })), nextCursor,
        };
      });
    },

    async verifyConversation(value) {
      const input = parse(conversationInput, value);
      return withClient(async (client) => {
        const response = await publicRequest(client, "thread/read", { threadId: input.threadId, includeTurns: false });
        return metadata(response.thread, input);
      });
    },

    async listPersistedTurns(value) {
      const input = parse(turnsInput, value);
      return withBoundConversation(input.issueId, async (client, verified) => {
        const response = await publicRequest(client, "thread/turns/list", {
          threadId: verified.thread.id, limit: input.limit, sortDirection: "desc", itemsView: "notLoaded",
          ...(input.before ? { cursor: input.before } : {}),
        });
        return { ...verified, observedAt: new Date().toISOString(), timeUnit: "unix-seconds",
          turns: (response.data ?? []).map((turn) => ({ id: turn.id, status: turn.status,
            startedAt: turn.startedAt ?? null, completedAt: turn.completedAt ?? null, durationMs: turn.durationMs ?? null,
          })), nextCursor: response.nextCursor ?? null,
        };
      });
    },

    async readPersistedItems(value) {
      const input = parse(itemsInput, value);
      return withBoundConversation(input.issueId, async (client, verified) => {
        const response = await publicRequest(client, "thread/items/list", {
          threadId: verified.thread.id, turnId: input.turn.id, limit: input.limit, sortDirection: "desc",
          ...(input.before ? { cursor: input.before } : {}),
        });
        const entries = (response.data ?? []).filter((entry) => entry.turnId === input.turn.id);
        const resultItems = entries.map(savedResultItem).filter(Boolean);
        return { ...verified, observedAt: new Date().toISOString(), timeUnit: "unix-seconds",
          execution: { source: SOURCE, live: false, sessionId: verified.thread.sessionId,
            threadId: verified.thread.id, turnId: input.turn.id, cwd: verified.thread.cwd,
            persistedStatus: input.turn.status, startedAt: input.turn.startedAt, completedAt: input.turn.completedAt,
            durationMs: input.turn.durationMs, itemsRead: entries.length,
            moreItemsAvailable: Boolean(response.nextCursor),
            assistantMessagesRead: resultItems.filter((item) => item.kind === "assistant-message").length,
            resultItemsRead: resultItems.length,
            resultSummary: resultSummary(entries),
          }, resultItems, nextCursor: response.nextCursor ?? null,
        };
      });
    },

    async readPersistedExecution(value) {
      const { issueId } = parse(executionInput, value);
      const binding = await getBinding?.(issueId);
      const disconnected = (reason) => ({ source: SOURCE, live: false, available: false, reason, execution: null, limitations });
      if (!binding?.threadId || binding.userConfirmed !== true || !verifiedSources.has(binding.source)) return disconnected("verified_explicit_binding_required");
      if (binding.codexProjectKind === "remote" || (binding.codexHostId && binding.codexHostId !== "local")) return disconnected("local_persisted_conversation_required");
      const input = parse(conversationInput, { threadId: binding.threadId, ...(binding.workspacePath ? { expectedCwd: binding.workspacePath } : {}) });
      return withClient(async (client) => {
        const response = await publicRequest(client, "thread/read", { threadId: input.threadId, includeTurns: false });
        const verified = metadata(response.thread, input);
        if (!verified.verified) return { ...disconnected("workspace_mismatch"), thread: verified.thread, cwdMatches: false };
        const turns = await publicRequest(client, "thread/turns/list", {
          threadId: input.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
        });
        const turn = turns.data?.[0];
        if (!turn) return { ...verified, reason: "no_persisted_turn", execution: null, observedAt: new Date().toISOString() };
        const items = await publicRequest(client, "thread/items/list", {
          threadId: input.threadId, turnId: turn.id, limit: 32, sortDirection: "desc",
        });
        const entries = (items.data ?? []).filter((entry) => entry.turnId === turn.id);
        return {
          ...verified, reason: null, observedAt: new Date().toISOString(),
          execution: {
            source: SOURCE, live: false, sessionId: verified.thread.sessionId,
            threadId: verified.thread.id, turnId: turn.id, cwd: verified.thread.cwd,
            persistedStatus: turn.status, startedAt: turn.startedAt ?? null, completedAt: turn.completedAt ?? null,
            itemsRead: entries.length, moreItemsAvailable: Boolean(items.nextCursor),
            assistantMessagesRead: entries.filter((entry) => entry.item.type === "agentMessage").length,
            resultSummary: resultSummary(entries),
          },
        };
      });
    },
  };
}
