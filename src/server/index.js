const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { loadProjectEnv } = require("../shared/load-env");
const { AGENTS, getAgentModelProfile } = require("../agents/catalog");
const { getProviderAdapter, collectProviderStartupDiagnostics } = require("../agents/providers");
const { parseA2AMentions, getMaxA2ADepth } = require("../agents/routing");
const agentIdentity = require("../agents/identity");
const agentHandoff = require("../agents/handoff");
const callbacks = require("../agents/callbacks");
const transcript = require("../session/transcript");
const contextHealth = require("../session/health");
const sessionSealer = require("../session/sealer");
const sessionBootstrap = require("../session/bootstrap");
const worktreeManagerModule = require("../worktree/manager");
const runtimePaths = require("../shared/runtime-paths");
const sessionStore = require("./session-store");
const sessionMapStore = require("./session-map-store");
const projectDirService = require("./project-dir");
const invocationStore = require("./invocation-store");
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
const { createInvocationRegistry } = require("./invocation-registry");
const { runChildStream, filterBenignStderr } = require("./child-stream");
const { createServerStorage } = require("../storage/server-storage");
const { createMemoryCapture } = require("../storage/memory-capture");
const { createRecallService } = require("../storage/recall-service");
const { createSessionReadService } = require("../storage/session-read-service");
const {
  ROOT,
  DEFAULT_SESSIONS_FILE,
  DEFAULT_INVOCATIONS_FILE,
  DEFAULT_SESSION_MAP_ROOT,
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
const {
  readSessions,
  writeSessions,
  createSession,
  restoreSession,
  ensureSession,
  listSessions,
  getSession,
  setSessionProjectDir,
  setSessionWorktree,
  deleteSession,
  appendToSession,
} = sessionStore;
const { getSessionMapPath, readSessionMap, deleteSessionMap } = sessionMapStore;
const { validateProjectDir } = projectDirService;
const { createCallbackRoutes } = callbackRoutes;
const { createChatRoutes } = chatRoutes;
const {
  readInvocationsFile,
  writeInvocationsFile,
  recordInvocationEvent,
  finalizeInvocationEvent,
  listInvocationsFromMap,
  searchInvocationsInMap,
  readInvocationFromMap,
} = invocationStore;
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
  const invocationsFile = options.invocationsFile || DEFAULT_INVOCATIONS_FILE;
  const sessionMapRoot = path.resolve(options.sessionMapRoot || DEFAULT_SESSION_MAP_ROOT);
  const logger = options.logger || console;
  const storageContext = createServerStorage({ ...options, transcript }, sessionsFile, logger);
  const durableRecorder = storageContext.recorder;
  const eventStore = storageContext.eventStore;
  const sqliteSessionService = storageContext.sessionService;
  const sqlitePrimary = storageContext.mode === "sqlite" && Boolean(sqliteSessionService);
  const memoryService = storageContext.storage?.memory || null;
  const recallService = createRecallService({
    storage: storageContext.storage,
    transcript,
    mode: storageContext.mode,
    logger,
  });
  const memoryCapture = createMemoryCapture({
    memoryService,
    transcript,
    eventStore,
    allowTranscriptReplay: storageContext.mode !== "sqlite",
    logger,
  });
  const sessionReader = createSessionReadService({
    mode: storageContext.mode,
    storage: storageContext.storage,
    fileStore: { getSession, listSessions },
    logger,
  });
  const activeInvocations = new Map();
  const invocationRegistry = createInvocationRegistry({
    file: invocationsFile,
    readFile: readInvocationsFile,
    writeFile: writeInvocationsFile,
  });
  const { buildInvokeArgs, buildChatArgs } = createInvokeArgsBuilder({
    agents: AGENTS,
  });
  _previewManagers.add(worktreeManager);

  function createSessionDual(file) {
    if (sqlitePrimary) return sqliteSessionService.createSession(file);
    const session = createSession(file);
    durableRecorder.mirrorThread(session);
    return session;
  }

  function ensureFileShadow(file, sessionId) {
    if (sqlitePrimary) return sqliteSessionService.getSession(file, sessionId);
    const existing = getSession(file, sessionId);
    if (existing || storageContext.mode !== "sqlite") return existing;
    const recovered = sessionReader.getSession(file, sessionId);
    return recovered ? restoreSession(file, recovered) : null;
  }

  function updateProjectDirDual(file, sessionId, projectDir) {
    if (sqlitePrimary)
      return sqliteSessionService.setSessionProjectDir(file, sessionId, projectDir);
    ensureFileShadow(file, sessionId);
    const session = setSessionProjectDir(file, sessionId, projectDir);
    durableRecorder.mirrorThread(session);
    return session;
  }

  function updateWorktreeDual(file, sessionId, worktree) {
    if (sqlitePrimary) return sqliteSessionService.setSessionWorktree(file, sessionId, worktree);
    ensureFileShadow(file, sessionId);
    const session = setSessionWorktree(file, sessionId, worktree);
    durableRecorder.mirrorThread(session);
    return session;
  }

  function appendToSessionDual(file, sessionId, message, appendOptions = {}) {
    if (sqlitePrimary) {
      return sqliteSessionService.appendToSession(file, sessionId, message, appendOptions);
    }
    if (appendOptions.allowCreate === false) ensureFileShadow(file, sessionId);
    const session = appendToSession(file, sessionId, message, appendOptions);
    durableRecorder.mirrorLastMessage(session, {
      windowId: appendOptions.windowId,
      invocationId: message.invocationId,
    });
    return session;
  }

  function deleteSessionDual(file, sessionId) {
    if (sqlitePrimary) {
      const deleted = sqliteSessionService.deleteSession(file, sessionId);
      // Keep recorder/event-store process guards in sync even when the row is
      // already gone (cascade deleted with the thread).
      durableRecorder.deleteThread(sessionId);
      return deleted;
    }
    ensureFileShadow(file, sessionId);
    const deleted = deleteSession(file, sessionId);
    if (deleted) durableRecorder.deleteThread(sessionId);
    return deleted;
  }

  function getSessionForMode(file, sessionId) {
    if (sqlitePrimary) return sqliteSessionService.getSession(file, sessionId);
    return sessionReader.getSession(file, sessionId);
  }

  function listSessionsForMode(file) {
    if (sqlitePrimary) return sqliteSessionService.listSessions(file);
    return sessionReader.listSessions(file);
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
    deleteSessionMap(sessionId, sessionMapRoot);
    await transcript.deleteSessionData(sessionId);
    invocationRegistry.deleteForSession(sessionId);
  }

  const handleSessionRoutes = createSessionRoutes({
    rootDir: ROOT,
    sessionsFile,
    worktreeManager,
    cleanupSessionRuntime,
    sendJson,
    readJsonBody,
    listSessions: listSessionsForMode,
    createSession: createSessionDual,
    getSession: getSessionForMode,
    deleteSession: deleteSessionDual,
    setSessionWorktree: updateWorktreeDual,
    validateProjectDir,
    setSessionProjectDir: updateProjectDirDual,
    usageStorage: storageContext.storage,
  });
  const handleMemoryRoutes = createMemoryRoutes({
    memoryService,
    suggestionService: storageContext.storage?.suggestionService || null,
    storage: storageContext.storage,
    getSession: getSessionForMode,
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
    transcript,
    eventStore,
    appendToSession: appendToSessionDual,
    getSession: getSessionForMode,
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
    sessionMapRoot,
    invocationEvents: invocationRegistry.events,
    options: { ...options, sessionsFile },
    AGENTS,
    callbacks,
    transcript,
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
    getSession: getSessionForMode,
    createSession: createSessionDual,
    setSessionProjectDir: updateProjectDirDual,
    validateProjectDir,
    setSessionWorktree: updateWorktreeDual,
    appendToSession: appendToSessionDual,
    getSessionMapPath,
    readSessionMap,
    recordInvocationEvent,
    finalizeInvocationEvent,
    persistInvocations: invocationRegistry.persist,
    durableRecorder,
    memoryCapture,
    storageMode: storageContext.mode,
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
  server.once("close", () => {
    _previewManagers.delete(worktreeManager);
    storageContext.close();
  });
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
  readSessions,
  writeSessions,
  createSession,
  ensureSession,
  listSessions,
  getSession,
  setSessionWorktree,
  deleteSession,
  appendToSession,
  readInvocationsFile,
  writeInvocationsFile,
  recordInvocationEvent,
  finalizeInvocationEvent,
  listInvocationsFromMap,
  searchInvocationsInMap,
  readInvocationFromMap,
};
