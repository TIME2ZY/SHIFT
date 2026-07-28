const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { loadProjectEnv } = require("../shared/load-env");
const { ENV } = require("../shared/brand");
const { AGENTS, getAgentModelProfile } = require("../agents/catalog");
const { getProviderAdapter, collectProviderStartupDiagnostics } = require("../agents/providers");
const { parseA2AMentions, getMaxA2ADepth } = require("../agents/routing");
const agentIdentity = require("../agents/identity");
const agentHandoff = require("../agents/handoff");
const callbacks = require("../agents/callbacks");
const contextHealth = require("../session/health");
const sessionSealer = require("../session/sealer");
const sessionBootstrap = require("../session/bootstrap");
const worktreeManagerModule = require("../worktree/manager");
const runtimePaths = require("../shared/runtime-paths");
const projectDirService = require("./project-dir");
const uiSecurity = require("./ui-security");
const { createSessionRoutes } = require("./session-routes");
const { createMemoryRoutes } = require("./memory-routes");
const { createStorageRoutes } = require("./storage-routes");
const callbackRoutes = require("./callback-routes");
const chatRoutes = require("./chat-routes");
const skills = require("./skills");
const { createSafeRequestListener, sendJson, sendSse, readJsonBody } = require("./http-transport");
const { serveIndex, serveStatic } = require("./static-assets");
const { createInvokeArgsBuilder } = require("./invoke-args");
const { runChildStream, filterBenignStderr } = require("./child-stream");
const { createServerStorage } = require("../storage/server-storage");
const { createMemoryCapture } = require("../storage/memory-capture");
const { createRecallService } = require("../storage/recall-service");
const {
  ROOT,
  DEFAULT_SESSIONS_FILE,
  DEFAULT_TRANSCRIPT_DIR,
  DEFAULT_AUDIT_TRANSCRIPT_DIR,
  DEFAULT_WORKTREE_STATE_FILE,
} = runtimePaths;

// When started as the main process (npm start), load project .env so local
// knobs like INVOKE_CLI_PROXY / INVOKE_CODEX_HOME persist without shell export.
// Tests require this module as a library and skip file loading.
if (require.main === module) {
  loadProjectEnv(ROOT);
}
const {
  getSkills,
  publicSkills,
  matchSkills,
  loadSkills,
  augmentPrompt,
  parseSkillFrontmatter,
  buildAugmentedPrompt,
} = skills;
const { validateProjectDir } = projectDirService;
const { createCallbackRoutes } = callbackRoutes;
const { createChatRoutes } = chatRoutes;
const DEFAULT_PORT = Number(process.env.PORT || 8787);
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
      reasoningEffort: agent.reasoningEffort || "",
      description: agent.description || "",
      role: identity ? identity.role : "",
      duties: identity ? identity.duties.slice() : [],
      boundaries: identity ? identity.boundaries.slice() : [],
    };
  });
}

function createServer(options = {}) {
  // Surface missing identity packs early so new agents aren't silent no-ops.
  agentIdentity.assertIdentitiesForAgents(Object.keys(AGENTS));
  const uiToken = uiSecurity.createUiToken(options.uiToken);
  const spawnRunner = options.spawnRunner || spawn;
  const sessionsFile = options.sessionsFile || DEFAULT_SESSIONS_FILE;
  const worktreeManager =
    options.worktreeManager ||
    worktreeManagerModule.createWorktreeManager({
      rootDir: ROOT,
      stateFile: DEFAULT_WORKTREE_STATE_FILE,
    });
  const logger = options.logger || console;
  const auditTranscriptDir = path.resolve(
    options.auditTranscriptDir ||
      process.env[ENV.AUDIT_TRANSCRIPT_DIR] ||
      (options.sessionsFile
        ? path.join(path.dirname(sessionsFile), "audit-transcripts")
        : DEFAULT_AUDIT_TRANSCRIPT_DIR)
  );
  const legacyTranscriptDir = path.resolve(
    process.env[ENV.TRANSCRIPT_DIR] || DEFAULT_TRANSCRIPT_DIR
  );
  if (runtimePaths.pathsOverlap(legacyTranscriptDir, auditTranscriptDir)) {
    throw new Error(
      `SQLite canonical audit directory must not overlap legacy transcripts: ` +
        `${auditTranscriptDir} <> ${legacyTranscriptDir}`
    );
  }
  const storageContext = createServerStorage(
    { ...options, auditTranscriptDir },
    sessionsFile,
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
    logger,
  });
  const memoryCapture = createMemoryCapture({
    memoryService,
    eventStore,
    allowTranscriptReplay: false,
    logger,
  });
  const activeInvocations = new Map();
  const { buildInvokeArgs, buildChatArgs } = createInvokeArgsBuilder({
    agents: AGENTS,
  });
  _previewManagers.add(worktreeManager);

  function createSessionDurable(file) {
    return sqliteSessionService.createSession(file);
  }

  function updateProjectDirDurable(file, sessionId, projectDir) {
    return sqliteSessionService.setSessionProjectDir(file, sessionId, projectDir);
  }

  function updateWorktreeDurable(file, sessionId, worktree) {
    return sqliteSessionService.setSessionWorktree(file, sessionId, worktree);
  }

  function appendToSessionDurable(file, sessionId, message, appendOptions = {}) {
    return sqliteSessionService.appendToSession(file, sessionId, message, appendOptions);
  }

  function deleteSessionDurable(file, sessionId) {
    const deleted = sqliteSessionService.deleteSession(file, sessionId);
    durableRecorder.deleteThread(sessionId);
    return deleted;
  }

  function getSessionDurable(file, sessionId) {
    return sqliteSessionService.getSession(file, sessionId);
  }

  function listSessionsDurable(file) {
    return sqliteSessionService.listSessions(file);
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

  const handleSessionRoutes = createSessionRoutes({
    rootDir: ROOT,
    sessionsFile,
    worktreeManager,
    cleanupSessionRuntime,
    sendJson,
    readJsonBody,
    listSessions: listSessionsDurable,
    createSession: createSessionDurable,
    getSession: getSessionDurable,
    deleteSession: deleteSessionDurable,
    setSessionWorktree: updateWorktreeDurable,
    validateProjectDir,
    setSessionProjectDir: updateProjectDirDurable,
    usageStorage: storageContext.storage,
  });
  const handleMemoryRoutes = createMemoryRoutes({
    memoryService,
    suggestionService: storageContext.storage?.suggestionService || null,
    storage: storageContext.storage,
    getSession: getSessionDurable,
    sessionsFile,
    sendJson,
    readJsonBody,
    eventStore,
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
    sessionsFile,
    sendJson,
    readJsonBody,
    durableRecorder,
    recallService,
    memoryCapture,
    memoryService,
    logger,
  });
  const handleChatRoutes = createChatRoutes({
    rootDir: ROOT,
    selfGitRoot: SELF_GIT_ROOT,
    options: { ...options, sessionsFile },
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
    buildInvokeArgs,
    buildChatArgs,
    augmentPrompt,
    getMaxA2ADepth,
    parseA2AMentions,
    filterBenignStderr,
    runChildStream,
    spawnRunner,
    getSession: getSessionDurable,
    createSession: createSessionDurable,
    setSessionProjectDir: updateProjectDirDurable,
    validateProjectDir,
    setSessionWorktree: updateWorktreeDurable,
    appendToSession: appendToSessionDurable,
    durableRecorder,
    memoryCapture,
    logger,
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/") {
      serveIndex(res, { indexPath: path.join(ROOT, "index.html"), uiToken, sendJson });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      const relative = url.pathname.slice("/public".length);
      serveStatic(res, relative, path.join(ROOT, "public"), sendJson);
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
  let storageClosed = false;
  async function closeStorageContext() {
    if (storageClosed) return;
    storageClosed = true;
    _previewManagers.delete(worktreeManager);
    try {
      await storageContext.close();
    } catch (error) {
      logger.error?.(`[server] storage shutdown failed: ${error.message}`);
    }
  }
  server.once("close", () => {
    void closeStorageContext();
  });
  // Expose for tests / orchestrated shutdown that can await flush-before-close.
  server.closeStorageContext = closeStorageContext;
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(DEFAULT_PORT, "127.0.0.1", () => {
    console.log(`Shift listening at http://127.0.0.1:${DEFAULT_PORT}`);
    for (const line of collectProviderStartupDiagnostics()) {
      console.log(line);
    }
  });
}

module.exports = {
  createServer,
  publicAgents,
  publicSkills,
  loadSkills,
  matchSkills,
  augmentPrompt,
  parseSkillFrontmatter,
  buildAugmentedPrompt,
};
