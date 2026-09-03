"use strict";

const { DUTIES, ENFORCEMENT_LEVELS, ROUTING_REASONS } = require("../shared/collab-contracts");

function createInvocationDutyBindingRepository(db) {
  const insert = db.prepare(`
    INSERT INTO invocation_duty_bindings (
      invocation_id, thread_id, seat_id, duty, skill_name,
      routing_reason, enforcement_level, created_at
    ) VALUES (
      @invocationId, @threadId, @seatId, @duty, @skillName,
      @routingReason, @enforcementLevel, @createdAt
    )
  `);
  const findForInvocation = db.prepare(
    "SELECT * FROM invocation_duty_bindings WHERE invocation_id = ?"
  );
  const listForThread = db.prepare(`
    SELECT * FROM invocation_duty_bindings
    WHERE thread_id = ?
    ORDER BY created_at, invocation_id
  `);
  const findSeat = db.prepare("SELECT * FROM thread_seats WHERE seat_id = ?");
  const findInvocation = db.prepare("SELECT thread_id FROM invocations WHERE id = ?");

  return {
    create(input) {
      const invocationId = requiredString(input.invocationId, "invocation id");
      const threadId = requiredString(input.threadId, "thread id");
      const seatId = requiredString(input.seatId, "seat id");
      const duty = allowedValue(input.duty, DUTIES, "duty");
      const routingReason = allowedValue(input.routingReason, ROUTING_REASONS, "routing reason");
      const enforcementLevel = allowedValue(
        input.enforcementLevel,
        ENFORCEMENT_LEVELS,
        "enforcement level"
      );
      if (enforcementLevel === "unavailable") {
        throw new Error("Unavailable routes cannot create an invocation duty binding.");
      }

      const seat = findSeat.get(seatId);
      if (!seat) throw new Error(`Seat ${seatId} does not exist.`);
      if (seat.thread_id !== threadId) throw new Error(`Seat ${seatId} belongs to another thread.`);
      if (seat.enabled !== 1) throw new Error(`Seat ${seatId} is not enabled.`);

      const invocation = findInvocation.get(invocationId);
      if (!invocation) throw new Error(`Invocation ${invocationId} does not exist.`);
      if (invocation.thread_id !== threadId) {
        throw new Error(`Invocation ${invocationId} belongs to another thread.`);
      }

      insert.run({
        invocationId,
        threadId,
        seatId,
        duty,
        skillName: requiredString(input.skillName, "skill name"),
        routingReason,
        enforcementLevel,
        createdAt: input.createdAt || new Date().toISOString(),
      });
      return this.getForInvocation(invocationId);
    },

    getForInvocation(invocationId) {
      return mapBinding(findForInvocation.get(requiredString(invocationId, "invocation id")));
    },

    listForThread(threadId) {
      return listForThread.all(requiredString(threadId, "thread id")).map(mapBinding);
    },
  };
}

function mapBinding(row) {
  if (!row) return null;
  return {
    invocationId: row.invocation_id,
    threadId: row.thread_id,
    seatId: row.seat_id,
    duty: row.duty,
    skillName: row.skill_name,
    routingReason: row.routing_reason,
    enforcementLevel: row.enforcement_level,
    createdAt: row.created_at,
  };
}

function allowedValue(value, allowed, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!allowed.includes(normalized)) throw new Error(`Unsupported ${label}: ${normalized}`);
  return normalized;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

module.exports = { createInvocationDutyBindingRepository, mapBinding };
