"use strict";

function createThreadSeatRepository(db) {
  const insert = db.prepare(`
    INSERT INTO thread_seats (
      seat_id, thread_id, provider_id, label, enabled,
      affinity_tags_json, created_at, updated_at
    ) VALUES (
      @seatId, @threadId, @providerId, @label, @enabled,
      @affinityTagsJson, @createdAt, @updatedAt
    )
  `);
  const find = db.prepare("SELECT * FROM thread_seats WHERE seat_id = ?");
  const listForThread = db.prepare(`
    SELECT * FROM thread_seats
    WHERE thread_id = ?
    ORDER BY created_at, seat_id
  `);
  const listEnabledForThread = db.prepare(`
    SELECT * FROM thread_seats
    WHERE thread_id = ? AND enabled = 1
    ORDER BY created_at, seat_id
  `);
  const updateConfiguration = db.prepare(`
    UPDATE thread_seats
    SET label = @label,
        enabled = @enabled,
        affinity_tags_json = @affinityTagsJson,
        updated_at = @updatedAt
    WHERE seat_id = @seatId
  `);

  return {
    create(input) {
      const now = input.createdAt || new Date().toISOString();
      insert.run({
        seatId: requiredString(input.seatId, "seat id"),
        threadId: requiredString(input.threadId, "thread id"),
        providerId: requiredString(input.providerId, "provider id").toLowerCase(),
        label: nullableString(input.label),
        enabled: input.enabled === false ? 0 : 1,
        affinityTagsJson: JSON.stringify(normalizeTags(input.affinityTags)),
        createdAt: now,
        updatedAt: input.updatedAt || now,
      });
      return this.get(input.seatId);
    },

    get(seatId) {
      return mapSeat(find.get(requiredString(seatId, "seat id")));
    },

    listForThread(threadId) {
      return listForThread.all(requiredString(threadId, "thread id")).map(mapSeat);
    },

    listEnabledForThread(threadId) {
      return listEnabledForThread.all(requiredString(threadId, "thread id")).map(mapSeat);
    },

    configure(seatId, patch = {}) {
      const current = this.get(seatId);
      if (!current) return null;
      updateConfiguration.run({
        seatId: current.seatId,
        label: patch.label === undefined ? current.label : nullableString(patch.label),
        enabled: patch.enabled === undefined ? (current.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
        affinityTagsJson: JSON.stringify(
          patch.affinityTags === undefined
            ? current.affinityTags
            : normalizeTags(patch.affinityTags)
        ),
        updatedAt: patch.updatedAt || new Date().toISOString(),
      });
      return this.get(current.seatId);
    },
  };
}

function mapSeat(row) {
  if (!row) return null;
  return {
    seatId: row.seat_id,
    threadId: row.thread_id,
    providerId: row.provider_id,
    label: row.label || null,
    enabled: row.enabled === 1,
    affinityTags: parseTags(row.affinity_tags_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tag) => String(tag || "").trim()).filter(Boolean))];
}

function parseTags(value) {
  try {
    return normalizeTags(JSON.parse(value));
  } catch {
    return [];
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function nullableString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

module.exports = { createThreadSeatRepository, mapSeat };
