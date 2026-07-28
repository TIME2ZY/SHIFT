/**
 * Audit observable A2A handoff closure from one chat SSE stream.
 *
 * A valid hop is not "another agent started". It requires:
 * parsed handoff -> accepted route -> causally linked target start -> target exit.
 */

function auditHandoffs(events = []) {
  const indexed = (events || []).map((item, index) => ({ ...item, index }));
  const parsed = indexed.filter((item) => item.event === "handoff-parsed");
  const routes = indexed.filter((item) => item.event === "a2a-route");
  const starts = indexed.filter((item) => item.event === "agent-start");
  const windowMetas = indexed.filter((item) => item.event === "window-meta");
  const exits = indexed.filter((item) => item.event === "agent-exit");
  const usedParsedIndexes = new Set();
  const duplicateKeys = new Set();
  const seenRouteKeys = new Set();
  const handoffs = [];

  for (const routeEvent of routes) {
    const route = objectData(routeEvent);
    const parseEvent = findMatchingParsed(parsed, routeEvent, route, usedParsedIndexes);
    if (parseEvent) usedParsedIndexes.add(parseEvent.index);
    const parsedData = objectData(parseEvent);
    const targetStart = findTargetStart(starts, windowMetas, routeEvent, route);
    const targetExit = targetStart
      ? exits.find(
          (item) =>
            item.index > targetStart.index &&
            objectData(item).invocationId === objectData(targetStart).invocationId
        ) || null
      : null;
    const routeKey = [
      route.parentInvocationId || "",
      route.from || "",
      route.to || "",
    ].join("|");
    const duplicate = seenRouteKeys.has(routeKey);
    seenRouteKeys.add(routeKey);
    if (duplicate) duplicateKeys.add(routeKey);

    const violations = [];
    if (!route.handoffId) violations.push("missing-handoff-id");
    if (!route.parentInvocationId) violations.push("missing-parent-invocation-id");
    if (!parseEvent) violations.push("missing-handoff-parsed");
    if (
      parseEvent &&
      (parsedData.from !== route.from || parsedData.to !== route.to)
    ) {
      violations.push("parsed-route-mismatch");
    }
    if (!targetStart) violations.push("target-not-started");
    if (targetStart && !targetExit) violations.push("target-not-exited");
    if (duplicate) violations.push("duplicate-route");

    handoffs.push({
      handoffId: route.handoffId || "",
      from: route.from || "",
      to: route.to || "",
      parentInvocationId: route.parentInvocationId || "",
      routeMessageId: route.routeMessageId || "",
      parsed: Boolean(parseEvent),
      routed: true,
      targetInvocationId: objectData(targetStart).invocationId || "",
      targetStarted: Boolean(targetStart),
      targetExited: Boolean(targetExit),
      duplicate,
      closed: violations.length === 0,
      violations,
    });
  }

  const violations = handoffs.flatMap((handoff) =>
    handoff.violations.map((code) => ({
      handoffId: handoff.handoffId,
      from: handoff.from,
      to: handoff.to,
      code,
    }))
  );

  return {
    handoffs,
    routes: routes.length,
    validA2AHops: handoffs.filter((item) => item.closed).length,
    duplicateRouteKeys: [...duplicateKeys],
    violations,
    handoffsClosed: violations.length === 0,
  };
}

function aggregateHandoffAudits(turns = []) {
  const violations = [];
  const duplicateRouteKeys = [];
  let routes = 0;
  let validA2AHops = 0;

  for (const turn of turns || []) {
    const audit = turn.handoffAudit || {
      routes: 0,
      validA2AHops: 0,
      duplicateRouteKeys: [],
      violations: [],
    };
    routes += audit.routes || 0;
    validA2AHops += audit.validA2AHops || 0;
    duplicateRouteKeys.push(...(audit.duplicateRouteKeys || []));
    for (const violation of audit.violations || []) {
      violations.push({ turnId: turn.turnId || "", ...violation });
    }
  }

  return {
    routes,
    validA2AHops,
    duplicateRouteKeys: [...new Set(duplicateRouteKeys)],
    violations,
    handoffsClosed: violations.length === 0,
  };
}

function findMatchingParsed(parsed, routeEvent, route, usedIndexes) {
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const item = parsed[index];
    const data = objectData(item);
    if (item.index >= routeEvent.index || usedIndexes.has(item.index)) continue;
    if (data.from === route.from && data.to === route.to) return item;
  }
  return null;
}

function findTargetStart(starts, windowMetas, routeEvent, route) {
  return (
    starts.find((item) => {
      if (item.index <= routeEvent.index) return false;
      const startData = objectData(item);
      if (startData.agent !== route.to) return false;
      const metaData = objectData(
        windowMetas.find(
          (meta) => objectData(meta).invocationId === startData.invocationId
        )
      );
      const causality = { ...startData, ...metaData };
      if (route.routeMessageId && causality.triggerMessageId) {
        return route.routeMessageId === causality.triggerMessageId;
      }
      if (route.parentInvocationId && causality.parentInvocationId) {
        return route.parentInvocationId === causality.parentInvocationId;
      }
      return false;
    }) || null
  );
}

function objectData(event) {
  return event?.data && typeof event.data === "object" ? event.data : {};
}

module.exports = {
  auditHandoffs,
  aggregateHandoffAudits,
};
