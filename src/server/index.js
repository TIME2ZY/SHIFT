const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { ENV } = require("../shared/brand");
const { AGENTS, getAgentModelProfile, loadAgentCatalogFromHome } = require("../agents/catalog");
const { getProviderAdapter } = require("../agents/providers");
const { parseA2AMentions, getMaxA2ADepth } = require("../agents/routing");
const agentIdentity = require("../agents/identity");
const agentHandoff = require("../agents/handoff");
const callbacks = require("../agents/callbacks");
const contextHealth = require("../session/health");
const sessionSealer = require("../session/sealer");
const sessionBootstrap = require("../session/bootstrap");
const worktreeManagerModule = require("../worktree/manager");
const { createDeliveryVerifier } = require("../worktree/delivery-verifier");
const { ROOT, createRuntimePaths } = require("../shared/runtime-paths");
const uiSecurity = require("./ui-security");
const { createSessionRoutes } = require("./session-routes");
const { createProjectRoutes } = require("./project-routes");
const { createMemoryRoutes } = require("./memory-routes");
const { createStorageRoutes } = require("./storage-routes");
const callbackRoutes = require("./callback-routes");
const chatRoutes = require("./chat-routes");
const { createCollabTaskRegistry } = require("../agents/collab-task-registry");

const { initializeCatalogSeats } = require("../agents/duty-routing");
const skills = require("./skills");
const { createSafeRequestListener, sendJson, sendSse, readJsonBody } = require("./http-transport");
const { serveIndex, serveStatic } = require("./static-assets");
const { createInvokeArgsBuilder } = require("./invoke-args");
const { runChildStream, filterBenignStderr } = require("./child-stream");
const { createServerStorage } = require("../storage/server-storage");
const { createMemoryCapture } = require("../storage/memory-capture");
const { createRecallService } = require("../storage/recall-service");
const {
  getSkills,
  publicSkills,
  matchSkills,
  loadSkills,
  augmentPrompt,
  prepareSkillDelivery,
  listSkillIndex,
  getSkillByName,
  parseSkillFrontmatter,
  buildAugmentedPrompt,
} = skills;
const { createCallbackRoutes } = callbackRoutes;
const { createChatRoutes } = chatRoutes;
// Git root of the chat app itself, used to detect self-modification previews.
const SELF_GIT_ROOT = (() => {
  try {
    return worktreeManagerModule.ensureGitRoot(__dirname);
  } catch {
    return null;
  }
})();

const _previewManagers = new Set();
process.on("exit", () => {
  for (const mgr of _previewManagers) {
    try {
      mgr.stopAllPreviews();
    } catch {}
  }
});
function publicAgents() {
  return Object.values(AGENTS).map((agent) => {
    const identity = agentIdentity.getIdentity(agent.id);
    const modelProfile = getAgentModelProfile(agent.id);
    const provider = getProviderAdapter(agent.providerId);
    return {
      id: agent.id,
      label: agent.label,
      providerId: agent.providerId,
      model: agent.model,
      modelVendor: modelProfile ? modelProfile.vendorId : "",
      contextTokens: modelProfile ? modelProfile.contextTokens : null,
      reserveRatio: modelProfile ? modelProfile.reserveRatio : 0.2,
      capabilities: { ...provider.capabilities },
      runtimeCapabilities: { ...agent.runtimeCapabilities },
      reasoningEffort: agent.reasoningEffort || "",
      description: agent.description || "",
      role: identity ? identity.role : "",
      duties: identity ? identity.duties.slice() : [],
      boundaries: identity ? identity.boundaries.slice() : [],
    };
  });
}

function createServer(options = {}) {
  const uiToken = uiSecurity.createUiToken(options.uiToken);
  const appPaths =
    options.runtimePaths ||
    createRuntimePaths({ env: options.env || process.env, homeDir: options.homeDir });
  loadAgentCatalogFromHome(appPaths.shiftHome);
  // Surface missing identity packs early so new agents aren't silent no-ops.
  agentIdentity.assertIdentitiesForAgents(Object.keys(AGENTS));
  const webDistDir = options.webDistDir || path.join(ROOT, "dist", "web");
  const webIndexPath = options.webIndexPath || path.join(webDistDir, "index.html");
  const spawnRunner = options.spawnRunner || spawn;
  const worktreeManager =
    options.worktreeManager ||
    worktreeManagerModule.createWorktreeManager({
      rootDir: ROOT,
      stateFile: options.worktreeStateFile || appPaths.worktreeStateFile,
    });
  const deliveryVerifier = options.deliveryVerifier || createDeliveryVerifier();
  const logger = options.logger || console;
  const auditTranscriptDir = path.resolve(
    options.auditTranscriptDir || appPaths.auditTranscriptDir
  );
  const storageContext = createServerStorage(
    {
      ...options,
      memoryDbFile: options.memoryDbFile || appPaths.databaseFile,
      auditTranscriptDir,
    },
    logger
  );
  const durableRecorder = storageContext.recorder;
  const eventStore = storageContext.eventStore;
  const sqliteSessionService = storageContext.sessionService;
  if (!sqliteSessionService) {
    throw new Error("SQLite session service is required.");
  }
  const memoryService = storageContext.storage?.memory || null;
  const recallService = createRecallService({
    storage: storageContext.storage,
    embeddingRuntime: storageContext.embeddingRuntime,
    logger,
  });
  // Collaboration events only — product memory uses memoryService.writeMemoryCandidate.
  const memoryCapture = createMemoryCapture({
    eventStore,
    logger,
  });
  const collabTaskRegistry = createCollabTaskRegistry({
    repository: storageContext.storage?.collaborationTasks || null,
    readWorkspace: (threadId) => worktreeManager.getStatus(threadId),
  });
  const activeInvocations = new Map();
  const runtimeRoot = path.resolve(options.runtimeRoot || process.env[ENV.RUNTIME_ROOT] || ROOT);
  const { buildChatArgs } = createInvokeArgsBuilder({
    agents: AGENTS,
    runnerPath: path.join(runtimeRoot, "src", "agents", "invoke-cli.js"),
  });
  _previewManagers.add(worktreeManager);

  function createSessionDurable(input) {
    const session = sqliteSessionService.createSession(input);
    initializeCatalogSeats(storageContext.storage.threadSeats, session.id, AGENTS, {
      createdAt: session.createdAt,
    });
    return session;
  }

  function updateWorktreeDurable(sessionId, worktree) {
    return sqliteSessionService.setSessionWorktree(sessionId, worktree);
  }

  function appendToSessionDurable(sessionId, message, appendOptions = {}) {
    return sqliteSessionService.appendToSession(sessionId, message, appendOptions);
  }

  function findUserMessageByClientTurnIdDurable(sessionId, clientTurnId) {
    return sqliteSessionService.findUserMessageByClientTurnId(sessionId, clientTurnId);
  }

  function deleteSessionDurable(sessionId) {
    const deleted = durableRecorder.archiveThread(sessionId);
    sqliteSessionService.releaseSession(sessionId);
    return deleted;
  }

  function getSessionDurable(sessionId) {
    return sqliteSessionService.getSession(sessionId);
  }

  function listSessionsDurable(projectKey) {
    return sqliteSessionService.listSessions(projectKey);
  }

  async function cleanupSessionRuntime(sessionId) {
    const controller = activeInvocations.get(sessionId);
    if (controller) {
      controller.abort();
      activeInvocations.delete(sessionId);
    }

    const thread = callbacks.getThread(sessionId);
    if (thread) {
      try {
        thread.controller?.abort();
      } catch {}
      callbacks.unregisterThread(sessionId);
    }

    try {
      worktreeManager.discardWorktree(sessionId);
    } catch {}
  }

  function archiveProjectDurable(projectKey) {
    for (const sessionId of activeInvocations.keys()) {
      const thread = storageContext.storage.threads.getIncludingArchived(sessionId);
      if (thread?.projectKey !== projectKey) continue;
      const error = new Error(`Project ${projectKey} has an active runtime invocation.`);
      error.code = "PROJECT_ACTIVE_INVOCATIONS";
      error.statusCode = 409;
      throw error;
    }
    return storageContext.storage.projects.archive(projectKey);
  }

  const handleProjectRoutes = createProjectRoutes({
    projects: storageContext.storage.projects,
    listSessions: listSessionsDurable,
    archiveProject: archiveProjectDurable,
    sendJson,
    readJsonBody,
  });

  const handleSessionRoutes = createSessionRoutes({
    worktreeManager,
    cleanupSessionRuntime,
    sendJson,
    readJsonBody,
    createSession: createSessionDurable,
    getSession: getSessionDurable,
    deleteSession: deleteSessionDurable,
    setSessionWorktree: updateWorktreeDurable,
    usageStorage: storageContext.storage,
    recallService,
    executionStorage: storageContext.storage,
    collabTaskRegistry,
    threadSeats: storageContext.storage.threadSeats,
    invocationDutyBindings: storageContext.storage.invocationDutyBindings,
  });
  const handleMemoryRoutes = createMemoryRoutes({
    memoryService,
    storage: storageContext.storage,
    getSession: getSessionDurable,
    sendJson,
    readJsonBody,
    logger,
  });
  const handleStorageRoutes = createStorageRoutes({
    storageContext,
    sendJson,
    readJsonBody,
  });
  const handleCallbackRoutes = createCallbackRoutes({
    callbacks,
    eventStore,
    appendToSession: appendToSessionDurable,
    getSession: getSessionDurable,
    sendJson,
    readJsonBody,
    durableRecorder,
    recallService,
    memoryCapture,
    memoryService,
    storage: storageContext.storage,
    logger,
  });
  const handleChatRoutes = createChatRoutes({
    selfGitRoot: SELF_GIT_ROOT,
    options,
    AGENTS,
    callbacks,
    eventStore,
    contextHealth,
    sessionSealer,
    sessionBootstrap,
    recallService,
    memoryService,
    storage: storageContext.storage,
    agentIdentity,
    agentHandoff,
    worktreeManager,
    worktreeManagerModule,
    activeInvocations,
    sendJson,
    sendSse,
    readJsonBody,
    buildChatArgs,
    augmentPrompt,
    prepareSkillDelivery,
    getMaxA2ADepth,
    parseA2AMentions,
    filterBenignStderr,
    runChildStream,
    spawnRunner,
    getSession: getSessionDurable,
    setSessionWorktree: updateWorktreeDurable,
    appendToSession: appendToSessionDurable,
    findUserMessageByClientTurnId: findUserMessageByClientTurnIdDurable,
    durableRecorder,
    memoryCapture,
    collabTaskRegistry,
    deliveryVerifier,
    logger,
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/") {
      serveIndex(res, { indexPath: webIndexPath, uiToken, sendJson });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      serveStatic(res, url.pathname, webDistDir, sendJson);
      return;
    }

    if (
      url.pathname.startsWith("/api/") &&
      !uiSecurity.authorizeApiRequest(req, res, url, { uiToken, sendJson })
    ) {
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agents") {
      sendJson(res, 200, { agents: publicAgents() });
      return;
    }

    if (await handleStorageRoutes(req, res, url)) {
      return;
    }

    if (await handleProjectRoutes(req, res, url)) {
      return;
    }

    if (await handleSessionRoutes(req, res, url)) {
      return;
    }

    if (await handleMemoryRoutes(req, res, url)) {
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/skills") {
      // Empty prompt still matches always-on skills (UI should show them idle).
      const prompt = url.searchParams.get("prompt") || "";
      const skills = getSkills();
      const matched = matchSkills(prompt, skills);
      sendJson(res, 200, {
        skills: publicSkills(),
        active: matched.map((s) => s.name),
      });
      return;
    }

    if (await handleCallbackRoutes(req, res, url)) {
      return;
    }

    if (await handleChatRoutes(req, res, url)) {
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  }

  const server = http.createServer(
    createSafeRequestListener(handleRequest, { sendJson, sendSse, logger })
  );
  let storageClosePromise = null;
  function closeStorageContext() {
    if (storageClosePromise) return storageClosePromise;
    _previewManagers.delete(worktreeManager);
    storageClosePromise = (async () => {
      try {
        await storageContext.close();
      } catch (error) {
        logger.error?.(`[server] storage shutdown failed: ${error.message}`);
      }
    })();
    return storageClosePromise;
  }
  server.once("close", () => {
    void closeStorageContext();
  });
  // Expose for tests / orchestrated shutdown that can await flush-before-close.
  server.closeStorageContext = closeStorageContext;
  return server;
}

module.exports = {
  createServer,
  publicAgents,
  publicSkills,
  loadSkills,
  matchSkills,
  augmentPrompt,
  prepareSkillDelivery,
  listSkillIndex,
  getSkillByName,
  parseSkillFrontmatter,
  buildAugmentedPrompt,
};
