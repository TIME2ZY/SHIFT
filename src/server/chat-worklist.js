/**
 * Chat multi-agent worklist runner (Phase C-1 extract from chat-routes).
 * Owns the try/for/finally around agent turns; no HTTP request parsing.
 */

const {
  createStreamDeltaCoalescer,
  resolveCoalesceOptionsFromEnv,
} = require("./stream-delta-coalescer");
const { createRunLifecycle } = require("../agents/event-protocol");
const { recordContextRestoration } = require("../session/context-restoration");
const { ENV } = require("../shared/brand");
const { observeAvailabilityEvent } = require("../agents/provider-availability");
const { IMPLEMENTATION_GATE_STATUS } = require("../agents/workflow-gates");
const { finalizeA2ARoutes } = require("../agents/a2a-finalize");
const { buildA2AInjectMetrics, logA2AInjectMetrics } = require("../agents/handoff-metrics");
const {
  emptyWriteStats,
  mergeWriteStats,
  buildMemoryWriteMetrics,
  logMemoryWriteMetrics,
} = require("../storage/memory-metrics");
const { refreshDigest } = require("../storage/memory-digest");
const { invocationUsageDelta, contextCharsFromEvent } = require("./chat-usage");
const { activeSkillNames } = require("../agents/duty-routing");
const { processIdentity } = require("../agents/process-ownership");
const { createTurnState, resetTurnStateForEntry, createTurnTracker } = require("./chat-turn-state");
const { assemblePrompt } = require("./chat-prompt-assembly");
const { startInvocationAndAnnounce } = require("./chat-invocation-starter");
const { announceMemoryInject } = require("./chat-memory-inject");
const { createSealCoordinator } = require("./chat-seal-coordination");
const {
  generateMessageId,
  buildAssistantFinalMessage,
  closeTurnFailure,
  completeAssistantTurn,
} = require("./chat-terminal");

/**
 * @param {object} ctx shared chat run context (mutated: session, aborted)
 * @returns {Promise<{ aborted: boolean, ownedInvocationSlotAtCleanup: boolean }>}
 */
async function runChatWorklist(ctx) {
  const {
    res,
    sendSse,
    sessionId,
    AGENTS,
    callbacks,
    contextHealth,
    sessionBootstrap,
    recallService,
    memoryService,
    storage,
    agentHandoff,
    durable,
    events,
    memories,
    collabTaskRegistry,
    deliveryVerifier,
    log,
    worklist,
    maxDepth,
    threadCtx,
    a2aHistory,
    runObs,
    invocationController,
    activeInvocations,
    useWorktree,
    runWorkspace,
    workspaceKey,
    activeWorktree,
    userMessageId,
    turnPrompt,
    skillNames,
    bootstrapInject,
    apiUrl,
    appendToSession,
    parseA2AMentions,
    filterBenignStderr,
    runChildStream,
    spawnRunner,
    buildChatArgs,
    options,
    prepareSkillDelivery,
    sessionProjectDir,
    isolatedWorkspace,
    runtime,
  } = ctx;

  const turnRunState = createTurnState(ctx);
  if (!Array.isArray(worklist) || worklist.length === 0) {
    throw new Error("runChatWorklist: worklist is empty or missing");
  }
  if (!threadCtx) {
    throw new Error("runChatWorklist: threadCtx is missing");
  }

  try {
    for (let i = 0; i < worklist.length; i++) {
      if (invocationController.signal.aborted) {
        turnRunState.aborted = true;
        break;
      }
      const agent = worklist[i];
      const agentConfig = AGENTS[agent] || { id: agent, label: agent, description: "" };
      const providerId = agentConfig.providerId || "";
      const providerKey =
        providerId && agentConfig.model ? `${providerId}:${agentConfig.model}` : providerId;
      resetTurnStateForEntry(turnRunState, { skillNames });
      turnRunState.openWindow =
        storage?.windows?.getOpen?.({
          threadId: sessionId,
          agentId: agent,
          providerKey,
          workspaceKey,
        }) ||
        durable.ensureWindow({
          session: turnRunState.session,
          threadId: sessionId,
          agentId: agent,
          providerKey,
          workspaceKey,
          capacityTokens: contextHealth.getAgentCapacity(agent),
          reserveRatio: contextHealth.getAgentReserveRatio(agent),
        });
      turnRunState.resumeSessionId = turnRunState.openWindow?.providerSessionId || "";
      // Owns every seal decision for this entry; reads mutable state at call time.
      const seals = createSealCoordinator(ctx, turnRunState, { agent, providerKey });

      const queuedCause = threadCtx.a2aCauses[i] || null;
      const dutyBinding = queuedCause?.dutyBinding || null;
      const parentInvocationId =
        i === 0 ? null : queuedCause?.parentInvocationId || turnRunState.previousInvocationId;
      const triggerType = i === 0 ? "user-message" : queuedCause?.triggerType || "a2a-handoff";
      const triggerMessageId =
        i === 0 ? userMessageId : queuedCause?.triggerMessageId || userMessageId;

      if (i === 0) {
        turnRunState.agentPrompt = turnPrompt;
      } else {
        const prev = a2aHistory[a2aHistory.length - 1];
        const prevLabel = AGENTS[prev.agent]?.label || prev.agent;
        // Prefer structured handoff for this target; soft-degrade if missing.
        const handoff =
          prev.handoffByTarget && prev.handoffByTarget[agent]
            ? prev.handoffByTarget[agent]
            : prev.handoff || null;
        const quality =
          prev.handoffQualityByTarget && prev.handoffQualityByTarget[agent]
            ? prev.handoffQualityByTarget[agent]
            : prev.handoffQuality || agentHandoff.evaluateHandoff(handoff);
        // Wave H1 Receive Bundle: memory card + policy banner + structured task + outbound card.
        const a2aMemoryPack = await sessionBootstrap.buildActiveMemoryCard({
          threadId: sessionId,
          prompt: [turnPrompt, handoff?.what, handoff?.next_action, prev.content]
            .filter(Boolean)
            .join("\n"),
          retrieveSource: recallService || null,
          memorySource: memoryService || null,
          budgetChars: sessionBootstrap.resolveA2AMemoryBudget
            ? sessionBootstrap.resolveA2AMemoryBudget()
            : undefined,
        });
        const a2aMemoryCard = a2aMemoryPack.rendered;
        const receiveBundle = agentHandoff.renderReceiveBundle({
          handoff,
          quality,
          fromAgent: prev.agent,
          fromLabel: prevLabel,
          toAgentId: agent,
          toLabel: agentConfig.label || agent,
          fromContent: prev.content,
          userPrompt: turnPrompt,
          memoryCard: a2aMemoryCard,
          includeOutboundCard: true,
        });
        const a2aSkills = prepareSkillDelivery({
          workspaceDir: runWorkspace.worktreeDir,
          projectDir: sessionProjectDir,
          useWorktree,
          isolated: isolatedWorkspace,
          rawPrompt: receiveBundle.text,
          skillNames: activeSkillNames(dutyBinding),
        });
        turnRunState.agentPrompt = a2aSkills.augmentedPrompt;
        turnRunState.turnSkillNames = a2aSkills.skillNames;
        // Stash for metrics after full prompt assembly (needs promptBytes).
        threadCtx._pendingA2AInject = {
          agent,
          fromAgent: prev.agent,
          memoryCard: a2aMemoryCard,
          inject: {
            items: a2aMemoryPack.items,
            stats: a2aMemoryPack.stats,
          },
        };
      }
      await assemblePrompt(ctx, turnRunState, {
        agent,
        agentConfig,
        i,
        dutyBinding,
        parentInvocationId,
        triggerType,
      });

      // Tracker from open window *before* this prompt (for PRE projection).
      turnRunState.healthTracker = createTurnTracker(agent, turnRunState.openWindow, {
        contextHealth,
        capacityFallback: contextHealth.getAgentCapacity(agent),
        reserveFallback: contextHealth.getAgentReserveRatio(agent),
      });
      // PRE-call rotation, if the projected budget overflows the usable window.
      await seals.preCallRotateIfNeeded();
      turnRunState.healthTracker.addInput(turnRunState.promptForAgent.length);

      // Start invocation only on the window that will actually run the provider.
      const started = startInvocationAndAnnounce(ctx, turnRunState, {
        agent,
        providerKey,
        parentInvocationId,
        triggerMessageId,
        triggerType,
        dutyBinding,
        resumeSessionId: turnRunState.resumeSessionId,
        handoffId: queuedCause?.handoffId || null,
        generationFallback: turnRunState.openWindow?.generation || 1,
        capacityFallback: contextHealth.getAgentCapacity(agent),
      });
      const { invocationId, callbackToken } = started;
      if (!started.run) {
        throw new Error(`Failed to persist invocation start for ${invocationId}.`);
      }
      // Prefer tracker bound to the durable window snapshot when present.
      if (turnRunState.durableRun.window) {
        turnRunState.healthTracker = createTurnTracker(agent, turnRunState.durableRun.window, {
          contextHealth,
        });
        turnRunState.healthTracker.addInput(turnRunState.promptForAgent.length);
      }
      turnRunState.billingAtStart = { ...turnRunState.healthTracker.snapshot().billing };
      seals.bindSealer();
      const turnStartHeadSha =
        useWorktree && runWorkspace?.worktreeDir && deliveryVerifier?.getHeadSha
          ? deliveryVerifier.getHeadSha(runWorkspace.worktreeDir)
          : null;
      threadCtx.turnStartHeadSha = turnStartHeadSha;
      // Capture the pre-call seal now that an invocation id exists for the SQLite FK.
      await seals.capturePreCallSeal();
      if (i === 0) {
        announceMemoryInject(ctx, turnRunState, {
          source: "bootstrap",
          agent,
          inject: bootstrapInject,
        });
      }

      if (threadCtx._pendingA2AInject) {
        const pending = threadCtx._pendingA2AInject;
        threadCtx._pendingA2AInject = null;
        const injectMetrics = buildA2AInjectMetrics({
          source: "chat",
          agent: pending.agent,
          fromAgent: pending.fromAgent,
          threadId: sessionId,
          invocationId,
          memoryCard: pending.memoryCard,
          promptBytes: turnRunState.promptForAgent.length,
        });
        logA2AInjectMetrics(injectMetrics, log);
        sendSse(res, "handoff-metrics", injectMetrics);
        if (pending.inject) {
          announceMemoryInject(ctx, turnRunState, {
            source: "a2a",
            agent: pending.agent,
            inject: pending.inject,
          });
        }
      }
      threadCtx.currentInvocationId = invocationId;
      threadCtx.windowId = turnRunState.durableRun?.window?.id || null;
      threadCtx.parentInvocationId = parentInvocationId;
      threadCtx.triggerMessageId = triggerMessageId;
      const invocationEnv = {
        [ENV.API_URL]: apiUrl,
        [ENV.THREAD_ID]: sessionId,
        [ENV.INVOCATION_ID]: invocationId,
        [ENV.CALLBACK_TOKEN]: callbackToken,
        [ENV.WORKTREE]: activeWorktree ? "1" : "0",
        [ENV.BASE_DIR]: runWorkspace.baseDir,
        [ENV.WORKTREE_DIR]: runWorkspace.worktreeDir,
        [ENV.BRANCH]: runWorkspace.branch || "",
        ...(turnRunState.enforcesImplementationPermission
          ? {
              [ENV.IMPLEMENTATION_GATE]: turnRunState.implementationPermission?.allowed
                ? IMPLEMENTATION_GATE_STATUS.APPROVED
                : IMPLEMENTATION_GATE_STATUS.REQUIRED,
              [ENV.APPROVED_PLAN_HASH]: turnRunState.implementationPermission?.allowed
                ? turnRunState.implementationPermission.planHash || ""
                : "",
            }
          : {}),
        INVOKE_SESSION_ID: turnRunState.resumeSessionId,
        INVOKE_PURPOSE: ctx.preparationOnly ? "prepare" : "execute",
        INVOKE_WORKSPACE_KEY: workspaceKey,
      };

      // Observers see SQLite appends only. Coalesce adjacent same-kind deltas;
      // flush on kind switch / hard boundary / maxChars / explicit end, and
      // within maxMs of the first token in a streak (idle may reset, max-wait
      // does not). usage.update is passthrough and does not end an open streak.
      const persistDurableEvent = (kind, payload) => {
        try {
          const createdAt = payload?.createdAt || payload?.ts || new Date().toISOString();
          events.append({
            threadId: sessionId,
            invocationId: turnRunState.activeInvocationId,
            kind,
            payload: { ...payload, agent, invocationId: turnRunState.activeInvocationId },
            createdAt,
          });
        } catch (error) {
          log.error?.(`[event-store] durable event failed: ${error.message}`);
          throw error;
        }
      };
      const durableCoalescer = createStreamDeltaCoalescer({
        ...resolveCoalesceOptionsFromEnv(),
        write: persistDurableEvent,
      });
      // Published so the seal coordinator can flush pending deltas before a seal.
      turnRunState.durableCoalescer = durableCoalescer;
      // Replay loop: at most one automatic re-run after empty emergency stop.
      turnRunState.code = 0;
      turnRunState.signal = null;
      turnRunState.streamFailure = null;
      turnRunState.streamStopped = false;
      turnRunState.streamStopReason = null;
      turnRunState.replayedAfterEmpty = false;
      turnRunState.sawUsageEvent = false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) {
          // New window after empty emergency — start a fresh invocation.
          turnRunState.assistantContent = "";
          turnRunState.observedProviderSessionId = "";
          turnRunState.emergencyStop = false;
          turnRunState.sealPending = false;
          turnRunState.contextSealHandled = false;
          turnRunState.contextSealedSseSent = false;
          turnRunState.contextWarned = false;
          turnRunState.sawUsageEvent = false;
          const retried = startInvocationAndAnnounce(ctx, turnRunState, {
            agent,
            providerKey,
            parentInvocationId,
            triggerMessageId,
            triggerType,
            dutyBinding: turnRunState.durableRun.binding || dutyBinding,
            resumeSessionId: "",
            replay: true,
            generationFallback: 2,
            // Read before the tracker rebind below: the retry window may lack
            // capacity, and the pre-retry tracker still holds the prior one.
            capacityFallback: turnRunState.healthTracker.capacityTokens,
          });
          if (!retried.run) break;
          const retryInvocationId = retried.invocationId;
          invocationEnv[ENV.INVOCATION_ID] = retryInvocationId;
          invocationEnv[ENV.CALLBACK_TOKEN] = retried.callbackToken;
          invocationEnv.INVOKE_SESSION_ID = "";
          turnRunState.healthTracker = createTurnTracker(agent, turnRunState.durableRun.window, {
            contextHealth,
            capacityFallback: turnRunState.healthTracker.capacityTokens,
            reserveFallback: turnRunState.healthTracker.reserveRatio,
            withBilling: false,
          });
          turnRunState.healthTracker.addInput(turnRunState.promptForAgent.length);
          turnRunState.billingAtStart = { ...turnRunState.healthTracker.snapshot().billing };
          if (sessionBootstrap.buildDigest) {
            const recovery = await sessionBootstrap.buildDigest({
              ...turnRunState.recoveryContext,
              generation: turnRunState.durableRun.window?.generation || 2,
            });
            turnRunState.promptForAgent += "\n\n" + recovery;
          }
          turnRunState.replayedAfterEmpty = true;
        }

        const toolLifecycle = createRunLifecycle();
        recordContextRestoration({
          eventStore: events,
          threadId: sessionId,
          invocationId: turnRunState.activeInvocationId,
          prompt: turnRunState.promptForAgent,
          seals: turnRunState.recoveryEvidence,
          taskVersion: turnRunState.taskSnapshot?.version,
        });
        const trackProcess = Boolean(collabTaskRegistry?.getTask(sessionId)?.delegationState);
        const processEvent = (kind, payload = {}) => {
          const written = events.append({
            threadId: sessionId,
            invocationId: turnRunState.activeInvocationId,
            kind,
            payload,
          });
          if (!written?.ok) throw new Error("Process ownership event was not persisted.");
        };
        if (trackProcess) processEvent("process.spawn_intent");
        const streamResult = await runChildStream({
          onSpawn: trackProcess
            ? (child) => {
                if (!child.pid) {
                  processEvent("process.exited", { reason: "not_spawned" });
                  return;
                }
                const identity = processIdentity(child.pid);
                if (!identity) {
                  processEvent("process.exited", { reason: "process_already_gone" });
                  return;
                }
                processEvent("process.bound", { identity });
              }
            : undefined,
          onClose: trackProcess ? () => processEvent("process.exited") : undefined,
          spawnRunner,
          args: buildChatArgs(agent, turnRunState.agentPrompt, turnRunState.promptForAgent),
          cwd: runWorkspace.worktreeDir,
          killGraceMs: options.killGraceMs,
          timeoutMs: options.timeoutMs,
          signal: invocationController.signal,
          env: invocationEnv,
          onError(payload) {
            sendSse(res, "error", payload);
          },
          onEvent(event) {
            const eventTime = event.createdAt || event.ts || new Date().toISOString();
            event.createdAt = eventTime;
            event.ts = eventTime;
            if (
              event.type === "tool.finished" &&
              event.status === "interrupted" &&
              invocationController.signal.aborted
            ) {
              event.status = "cancelled";
              event.state = "cancelled";
              event.error = "Tool execution cancelled by invocation stop.";
              event.failureReason = event.error;
            }
            observeAvailabilityEvent(ctx.availability, agent, event);
            if (
              typeof event.sessionId === "string" &&
              event.sessionId &&
              !event.subagentId &&
              turnRunState.durableRun?.window?.id
            ) {
              turnRunState.observedProviderSessionId = event.sessionId;
              durable.bindProviderSession(turnRunState.durableRun.window.id, event.sessionId);
            }
            if (event.type === "text.delta" && !event.subagentId) {
              const text = typeof event.text === "string" ? event.text : "";
              turnRunState.assistantContent += text;
              sendSse(res, "message", { agent, role: "assistant", text });
            }
            if (event.type === "tool.started" || event.type === "tool.finished") {
              runObs.noteToolEvent();
              toolLifecycle.observe(event);
            }
            sendSse(res, "agent-event", event);
            if (event.type === "usage.update" && !event.subagentId) {
              turnRunState.sawUsageEvent = true;
              turnRunState.healthTracker.applyUsage(event);
              if (turnRunState.durableRun?.window?.id) {
                durable.setWindowUsageSnapshot?.(
                  turnRunState.durableRun.window.id,
                  turnRunState.healthTracker.snapshot()
                );
              }
              seals.noteContextPressure();
            }
            const contextChars = contextCharsFromEvent(event);
            if (contextChars > 0) seals.addObservedContext(contextChars);
            durableCoalescer.accept(event);
          },
          onStderr(text) {
            ctx.availability?.observeFailure(agent, text);
            durableCoalescer.flushAll();
            const visible = filterBenignStderr(text);
            if (visible) {
              persistDurableEvent("stderr", { agent, text: visible });
              sendSse(res, "stderr", { agent, text: visible });
            }
          },
          onEncodingWarning(payload) {
            runObs.noteEncoding(payload.count || 1);
            if (payload.first) {
              sendSse(res, "encoding-warning", {
                agent,
                invocationId: turnRunState.activeInvocationId,
                channel: payload.channel,
                count: payload.count,
                total: payload.total,
                samples: payload.samples,
                cwd: payload.cwd,
                message:
                  "Replacement character U+FFFD detected in agent stream (encoding mismatch).",
              });
            }
          },
          onHealth: seals.addObservedContext,
          // Only physical/emergency stop mid-stream — never soft usable seal.
          shouldStop: () => turnRunState.emergencyStop,
        });
        turnRunState.code = streamResult.code;
        turnRunState.signal = streamResult.signal;
        turnRunState.streamFailure =
          streamResult.streamError ||
          (streamResult.timedOut
            ? { message: streamResult.stopReason, code: "provider_timeout" }
            : null);
        turnRunState.streamStopped = Boolean(streamResult.stopped);
        turnRunState.streamStopReason = streamResult.stopReason || null;
        if (streamResult.encoding?.total > 0) {
          runObs.noteDegraded("encoding_in_stream");
        }
        if (toolLifecycle.openToolCount > 0) {
          const isAbortedRun = Boolean(
            invocationController.signal.aborted ||
            turnRunState.streamStopped ||
            threadCtx?.controller?.signal?.aborted ||
            runtime?.getRun?.(sessionId)?.stopReason === "explicit-stop" ||
            invocationController.stopReason === "explicit-stop"
          );
          for (const toolFinished of toolLifecycle.closeOpenTools(
            { agent, invocationId: turnRunState.activeInvocationId },
            {
              cancelled: isAbortedRun,
              ok: turnRunState.code === 0,
              error: turnRunState.streamFailure?.message,
            }
          )) {
            const toolId = toolFinished.toolId;
            try {
              persistDurableEvent("tool.finished", toolFinished);
              sendSse(res, "agent-event", toolFinished);
              runObs.noteToolEvent();
            } catch (err) {
              log.error?.(
                `[chat-worklist] failed to emit interrupted tool.finished for ${toolId}: ${err.message}`
              );
              turnRunState.streamFailure ||= err;
            }
          }
        }
        if (turnRunState.streamFailure) {
          // Handler failure must not retry persist or empty-emergency replay.
          durableCoalescer.cancelAll();
          break;
        }
        try {
          durableCoalescer.flushAll();
          if (!turnRunState.sawUsageEvent && agent === "codex") {
            turnRunState.healthTracker.markBillingIncomplete();
          }
          if (turnRunState.durableRun) {
            durable.addWindowUsage(turnRunState.durableRun.window.id, {
              inputChars: turnRunState.promptForAgent.length,
              outputChars: turnRunState.assistantContent.length,
            });
            durable.setWindowUsageSnapshot?.(
              turnRunState.durableRun.window.id,
              turnRunState.healthTracker.snapshot()
            );
          }
        } catch (error) {
          turnRunState.streamFailure = {
            origin: "event persistence",
            message: error instanceof Error ? error.message : String(error),
          };
          log.error?.(
            `[event-store] post-stream persist failed: ${turnRunState.streamFailure.message}`
          );
          break;
        }

        const hasText = Boolean(String(turnRunState.assistantContent || "").trim());
        if (!hasText && turnRunState.emergencyStop && attempt === 0) {
          // The scheduler-facing terminal write owns invocation completion. Finish
          // the old invocation before rotation, whose orphan cleanup must never
          // race the normal terminal path.
          const ratio = turnRunState.healthTracker.getFillRatio();
          durable.completeInvocation({
            invocationId: turnRunState.activeInvocationId,
            code: turnRunState.code,
            signal: turnRunState.signal,
            reason: "empty-emergency",
            endPayload: {
              agent,
              contentBytes: 0,
              usage: invocationUsageDelta(
                turnRunState.healthTracker.snapshot().billing,
                turnRunState.billingAtStart
              ),
              fillRatioAtEnd: ratio,
              sealerState: "sealed",
              emptyEmergency: true,
              terminalState: "failed",
              failureStage: "seal",
              errorCode: "empty_emergency_retry",
              retryable: true,
            },
          });
          callbacks.retireInvocation?.(sessionId, turnRunState.activeInvocationId);
          if (!turnRunState.contextSealHandled) {
            seals.sealContextWindow(ratio, "physical-ceiling-empty");
          }
          const nextWin = storage?.windows?.getOpen?.({
            threadId: sessionId,
            agentId: agent,
            providerKey,
            workspaceKey,
          });
          if (nextWin) {
            turnRunState.healthTracker = createTurnTracker(agent, nextWin, {
              contextHealth,
              withBilling: false,
            });
            continue;
          }
        }
        break;
      }

      const invocationUsage = invocationUsageDelta(
        turnRunState.healthTracker.snapshot().billing,
        turnRunState.billingAtStart
      );
      const endPayload = {
        agent,
        contentBytes: turnRunState.assistantContent.length,
        usage: invocationUsage,
        fillRatioAtEnd: turnRunState.healthTracker.getFillRatio(),
        sealerState: turnRunState.sealer.getState(),
        emergencyStop: turnRunState.emergencyStop,
        sealPending: turnRunState.sealPending,
        preCallRotated: turnRunState.preCallRotated,
        replayedAfterEmpty: turnRunState.replayedAfterEmpty,
      };

      if (turnRunState.streamFailure) {
        // Handler or persist failure: one failed terminal, no silent retry.
        closeTurnFailure(ctx, turnRunState, {
          kind: "stream-failure",
          agent,
          invocationId: threadCtx.currentInvocationId || invocationId,
          usage: invocationUsage,
          endPayload,
        });
        break;
      }

      const isAborted = Boolean(
        invocationController.signal.aborted ||
        turnRunState.streamStopped ||
        threadCtx?.controller?.signal?.aborted ||
        runtime?.getRun?.(sessionId)?.stopReason === "explicit-stop" ||
        invocationController.stopReason === "explicit-stop"
      );

      if (isAborted) {
        // Single terminal write entry (Phase B-1); hop close stays in the scheduler.
        closeTurnFailure(ctx, turnRunState, {
          kind: "aborted",
          agent,
          invocationId: threadCtx.currentInvocationId || invocationId,
          usage: invocationUsage,
          endPayload,
        });
        break;
      }

      const finalInvocationId = threadCtx.currentInvocationId || invocationId;
      const hasAssistantText = Boolean(String(turnRunState.assistantContent || "").trim());

      // Under seal pressure, never treat empty content as a completed reply.
      // Clean zero-output exits (legacy mocks / silent success) may still persist "".
      const sealPressure =
        turnRunState.emergencyStop ||
        turnRunState.sealPending ||
        turnRunState.preCallRotated ||
        turnRunState.contextSealedSseSent;
      if (!hasAssistantText && sealPressure) {
        closeTurnFailure(ctx, turnRunState, {
          kind: "empty-under-seal",
          agent,
          invocationId: finalInvocationId,
          usage: invocationUsage,
          endPayload,
        });
        break;
      }

      if (turnRunState.code !== 0 || turnRunState.signal) {
        closeTurnFailure(ctx, turnRunState, {
          kind: "provider-failed",
          agent,
          invocationId: finalInvocationId,
          usage: invocationUsage,
          endPayload,
        });
        break;
      }

      const { workflowEvidenceEvents } = completeAssistantTurn(ctx, turnRunState, {
        agent,
        invocationId: finalInvocationId,
        usage: invocationUsage,
        endPayload,
        dutyBinding,
      });

      // POST soft seal after a complete answer, or provider-session bind if it
      // is not warranted (never the mid-stream kill path).
      seals.finalizeTurnSeal();

      const loopEvidence = workflowEvidenceEvents.find(
        (e) =>
          e.payload?.loopDetected ||
          (typeof e.event === "string" && e.event.endsWith("-loop-detected"))
      );
      const hasPlanLoop = Boolean(loopEvidence);
      if (hasPlanLoop) {
        const loopCode =
          loopEvidence.payload?.warning ||
          loopEvidence.payload?.reason ||
          "duplicate_plan_loop_detected";
        log?.warn?.(
          `[chat-worklist] runaway loop detected (${loopCode}) on thread ${sessionId}, terminating execution`
        );
        events.append({
          threadId: sessionId,
          invocationId: finalInvocationId,
          kind: "diagnostic",
          payload: {
            code: loopCode,
            severity: "warning",
            message:
              loopEvidence.payload?.message ||
              "Duplicate plan/review loop detected. Actively terminated runaway execution.",
            details: loopEvidence.payload,
          },
        });
      }

      // Parse structured handoff once per turn (soft — never blocks routing).
      const primaryHandoff = agentHandoff.extractPrimaryHandoff(turnRunState.assistantContent, {
        currentAgentId: agent,
      });
      const primaryQuality = agentHandoff.evaluateHandoff(primaryHandoff);
      const handoffByTarget = Object.create(null);
      const handoffQualityByTarget = Object.create(null);

      a2aHistory.push({
        agent,
        content: turnRunState.assistantContent,
        handoff: primaryHandoff,
        handoffQuality: primaryQuality,
        handoffByTarget,
        handoffQualityByTarget,
      });

      // Soft/post seal must not abort the user-visible answer or strip A2A.
      // Only client abort ends the chain early here.

      // Wave H2/H3: unified finalize (policy + capture + enqueue/repair).
      if (!hasPlanLoop) {
        const agentLabels = Object.fromEntries(
          Object.entries(AGENTS).map(([id, config]) => [id, config.label || id])
        );
        const finalized = finalizeA2ARoutes({
          text: turnRunState.assistantContent,
          fromAgent: agent,
          threadId: sessionId,
          sessionId,
          invocationId: finalInvocationId,
          windowId: turnRunState.durableRun?.window?.id || null,
          useWorktree: Boolean(useWorktree),
          worktreeDir: runWorkspace?.worktreeDir || "",
          worktreeBranch: runWorkspace?.branch || "",
          startHeadSha: threadCtx.turnStartHeadSha || null,
          deliveryVerifier,
          worklist,
          maxDepth,
          memoryCapture: memories,
          eventStore: events,
          durableRecorder: durable,
          sendSse: (event, payload) => sendSse(res, event, payload),
          appendToSession,
          agentLabels,
          source: "chat",
          parseMentions: parseA2AMentions,
          controller: invocationController,
          a2aState: threadCtx,
          logger: log,
          collabTaskRegistry,
          threadSeats: storage?.threadSeats || null,
          agents: AGENTS,
          availability: ctx.availability,
          fromSeatId: threadCtx.currentDutyBinding?.seatId || null,
          fromDuty: threadCtx.currentDutyBinding?.duty || null,
        });
        Object.assign(handoffByTarget, finalized.handoffByTarget);
        Object.assign(handoffQualityByTarget, finalized.handoffQualityByTarget);
      }

      const turnWriteStats = mergeWriteStats(
        emptyWriteStats(),
        threadCtx.memoryWriteStats || emptyWriteStats()
      );
      threadCtx.memoryWriteStats = emptyWriteStats();
      const writeMetrics = buildMemoryWriteMetrics({
        source: "chat",
        threadId: sessionId,
        invocationId: finalInvocationId,
        agent,
        stats: turnWriteStats,
      });
      logMemoryWriteMetrics(writeMetrics, log);
      sendSse(res, "memory-metrics", writeMetrics);

      // Recovery digest is derived state and never a product Memory write path.
      try {
        const digestResult = refreshDigest({
          storage,
          threadId: sessionId,
          logger: log,
        });
        if (digestResult?.digest) {
          sendSse(res, "memory-digest", {
            sessionId,
            invocationId: finalInvocationId,
            digest: digestResult.digest
              ? {
                  summary: digestResult.digest.summary,
                  topics: digestResult.digest.topics,
                  messageCount: digestResult.digest.messageCount,
                  updatedAt: digestResult.digest.updatedAt,
                }
              : null,
          });
        }
      } catch (error) {
        log.error?.(`[memory-digest] turn refresh failed: ${error.message}`);
      }

      if (hasPlanLoop) {
        throw new Error("Collaboration stopped: repeated evidence without progress.");
      }
    }
  } finally {
    turnRunState.ownedInvocationSlotAtCleanup =
      activeInvocations.get(sessionId) === invocationController;
    if (turnRunState.ownedInvocationSlotAtCleanup) {
      activeInvocations.delete(sessionId);
    }
    if (callbacks.getThread(sessionId) === threadCtx) {
      callbacks.unregisterThread(sessionId);
    }
  }

  ctx.session = turnRunState.session;
  ctx.aborted = turnRunState.aborted;
  return {
    aborted: turnRunState.aborted,
    ownedInvocationSlotAtCleanup: turnRunState.ownedInvocationSlotAtCleanup,
  };
}

module.exports = { runChatWorklist, generateMessageId, buildAssistantFinalMessage };
