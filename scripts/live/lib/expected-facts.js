/**
 * Expected product facts for solo-grok-auth live scenario.
 * Used by hard/soft recall assertions — not just "substantive text".
 */

const AUTH_SCENARIO_FACTS = Object.freeze({
  id: "solo-grok-auth",
  /** Active TTL must match latest user revision (not the initial week). */
  ttl: {
    mustMatch: [/24\s*小时|24h|86400|一天/i],
    mustNotAsCurrent: [/约\s*一周|约\s*7\s*天|604800|7\s*天\s*会话|TTL[^\n]{0,20}一周/i],
  },
  refresh: {
    mustNot: [/refresh\s*token/i],
    mustSayNo: [/不做\s*refresh|无\s*refresh|禁止[^\n]{0,12}refresh|no\s*refresh/i],
  },
  storage: {
    mustMatch: [/SQLite|sqlite/i],
    singleSource: [/唯一|单真相|不要两套|禁止[^\n]{0,20}两套|唯一真相/i],
  },
  port: {
    mustMatch: [/8787/],
  },
  passwordHash: {
    mustMatchAny: [/argon2id/i, /scrypt/i],
    mustNot: [/\bMD5\b/i, /\bSHA-?1\b/i],
  },
  /** Topics that should remain active after supersede (when product memories exist). */
  expectedActiveTopics: [
    "auth-session-ttl",
    "auth-no-refresh-token",
    "storage-primary",
    "dev-port",
  ],
  /** Superseded content fragments that must not appear in inject items as active. */
  supersededMustNotInject: [/604800/, /约\s*一周/, /大概一周/],
});

/**
 * Evaluate recall assistant text + active memories + inject items against facts.
 * @returns {{ hard: object[], soft: object[] }}
 */
function evaluateExpectedFacts({
  facts = AUTH_SCENARIO_FACTS,
  recallText = "",
  activeProduct = [],
  injectItems = [],
  requireProductMemories = false,
} = {}) {
  const hard = [];
  const soft = [];
  const text = String(recallText || "");
  const memBlob = activeProduct
    .map((m) => `${m.topic || ""} ${m.content || ""}`)
    .join("\n");
  const injectBlob = (injectItems || [])
    .map((item) => {
      const c =
        typeof item.content === "string"
          ? item.content
          : item.content && typeof item.content === "object"
            ? JSON.stringify(item.content)
            : "";
      const topic = item.topic || item.metadata?.topic || "";
      return `${topic} ${c}`;
    })
    .join("\n");
  const combined = `${text}\n${memBlob}`;

  const hasProduct = activeProduct.length > 0;

  // --- TTL ---
  const ttlOk =
    facts.ttl.mustMatch.some((re) => re.test(combined)) ||
    facts.ttl.mustMatch.some((re) => re.test(text));
  hard.push({
    id: "F-TTL",
    ok: !hasProduct && !requireProductMemories ? true : ttlOk,
    message: ttlOk
      ? "latest TTL (24h/86400) present in recall or active memories"
      : hasProduct
        ? "missing 24h/86400 as current TTL in recall/active memories"
        : "no product memories to check TTL (skipped hard)",
  });

  // Active memories must not present week as current strategy when 24h exists
  const activeOnlyBlob = memBlob;
  const weekInActive = facts.ttl.mustNotAsCurrent.some((re) => re.test(activeOnlyBlob));
  const dayInActive = facts.ttl.mustMatch.some((re) => re.test(activeOnlyBlob));
  hard.push({
    id: "F-TTL-ACTIVE",
    ok: !(weekInActive && !dayInActive) || !hasProduct,
    message:
      weekInActive && !dayInActive
        ? "active memories still present week-class TTL without 24h"
        : "active TTL not stuck on superseded week-only wording",
  });

  // Recall must not claim 7-day as current when we have 24h memories
  if (hasProduct && dayInActive) {
    const claimsWeekCurrent =
      /当前[^\n]{0,30}(一周|7\s*天)/.test(text) ||
      /仍为[^\n]{0,10}(一周|7\s*天)/.test(text) ||
      /默认[^\n]{0,15}(一周|7\s*天|604800)/.test(text);
    soft.push({
      id: "F-TTL-RECALL-NO-WEEK",
      ok: !claimsWeekCurrent,
      message: claimsWeekCurrent
        ? "recall text may still describe week TTL as current policy"
        : "recall does not re-assert week TTL as current",
    });
  }

  // --- refresh ---
  const saysNoRefresh = facts.refresh.mustSayNo.some((re) => re.test(combined));
  hard.push({
    id: "F-REFRESH",
    ok: !hasProduct && !requireProductMemories ? true : saysNoRefresh,
    message: saysNoRefresh
      ? "no-refresh constraint visible"
      : hasProduct
        ? "missing explicit no-refresh wording in recall/active memories"
        : "no product memories (skipped)",
  });

  // --- storage ---
  const hasSqlite = facts.storage.mustMatch.some((re) => re.test(combined));
  hard.push({
    id: "F-STORAGE",
    ok: !hasProduct && !requireProductMemories ? true : hasSqlite,
    message: hasSqlite
      ? "SQLite present in recall/active memories"
      : hasProduct
        ? "missing SQLite in recall/active memories"
        : "no product memories (skipped)",
  });

  soft.push({
    id: "F-STORAGE-SINGLE",
    ok: !hasProduct || facts.storage.singleSource.some((re) => re.test(combined)),
    message: facts.storage.singleSource.some((re) => re.test(combined))
      ? "single-source / no dual-write wording present"
      : "single-source wording weak or missing",
  });

  // --- port ---
  soft.push({
    id: "F-PORT",
    ok: !hasProduct || facts.port.mustMatch.some((re) => re.test(combined)),
    message: facts.port.mustMatch.some((re) => re.test(combined))
      ? "port 8787 mentioned"
      : "port 8787 not found in recall/active memories",
  });

  // --- password hash ---
  soft.push({
    id: "F-HASH",
    ok:
      !hasProduct ||
      facts.passwordHash.mustMatchAny.some((re) => re.test(combined)),
    message: facts.passwordHash.mustMatchAny.some((re) => re.test(combined))
      ? "modern password hash (argon2id/scrypt) mentioned"
      : "password hash guidance not found in recall/active memories",
  });

  // --- inject must not carry superseded week as active content heavily ---
  if (injectItems.length) {
    const injectHasSupersededOnly =
      facts.supersededMustNotInject.some((re) => re.test(injectBlob)) &&
      !facts.ttl.mustMatch.some((re) => re.test(injectBlob));
    hard.push({
      id: "F-INJECT-NO-STALE-TTL",
      ok: !injectHasSupersededOnly,
      message: injectHasSupersededOnly
        ? "inject blob looks like stale week TTL without 24h"
        : "inject not stale-week-only for TTL",
    });

    // Inject items should not include superseded status
    const supersededInInject = injectItems.filter(
      (item) => String(item.status || "").toLowerCase() === "superseded"
    );
    hard.push({
      id: "F-INJECT-NO-SUPERSEDED-STATUS",
      ok: supersededInInject.length === 0,
      message:
        supersededInInject.length === 0
          ? "no superseded status rows in inject items"
          : `${supersededInInject.length} superseded item(s) in inject`,
    });
  }

  // Active topic uniqueness for expected topics
  if (hasProduct) {
    for (const topic of facts.expectedActiveTopics) {
      const matches = activeProduct.filter(
        (m) => String(m.topic || m.metadata?.topic || "") === topic
      );
      if (matches.length === 0) {
        soft.push({
          id: `F-TOPIC-${topic}`,
          ok: false,
          message: `expected active topic missing: ${topic}`,
        });
      } else if (matches.length > 1) {
        hard.push({
          id: `F-TOPIC-DUP-${topic}`,
          ok: false,
          message: `topic ${topic} has ${matches.length} active rows`,
        });
      }
    }
  }

  return { hard, soft };
}

module.exports = {
  AUTH_SCENARIO_FACTS,
  evaluateExpectedFacts,
};
