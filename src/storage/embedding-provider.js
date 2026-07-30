class EmbeddingUnavailableError extends Error {
  constructor(message = "Embedding provider is unavailable.") {
    super(message);
    this.name = "EmbeddingUnavailableError";
    this.code = "embedding_unavailable";
  }
}

function resolveEmbeddingConfig(env = process.env) {
  const enabled = parseBoolean(env.SHIFT_EMBEDDING_ENABLED, false);
  const provider = String(env.SHIFT_EMBEDDING_PROVIDER || "disabled")
    .trim()
    .toLowerCase();
  const dimensions = parsePositiveInteger(env.SHIFT_EMBEDDING_DIMENSIONS, 0);
  return {
    enabled,
    provider: enabled ? provider : "disabled",
    model: String(env.SHIFT_EMBEDDING_MODEL || "").trim(),
    dimensions,
    batchSize: parsePositiveInteger(env.SHIFT_EMBEDDING_BATCH_SIZE, 16),
    timeoutMs: parsePositiveInteger(env.SHIFT_EMBEDDING_TIMEOUT_MS, 5000),
    baseUrl: String(env.SHIFT_EMBEDDING_BASE_URL || "").replace(/\/+$/, ""),
    apiKey: String(env.SHIFT_EMBEDDING_API_KEY || "").trim(),
  };
}

function createEmbeddingProvider(config, options = {}) {
  if (!config?.enabled || config.provider === "disabled") {
    return createDisabledEmbeddingProvider("disabled");
  }
  if (!["local", "openai-compatible"].includes(config.provider)) {
    return createDisabledEmbeddingProvider(`unsupported provider "${config.provider}"`);
  }
  if (!config.model || !config.dimensions || !config.baseUrl) {
    return createDisabledEmbeddingProvider("misconfigured");
  }
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return createDisabledEmbeddingProvider("fetch unavailable");
  }

  async function embed(texts) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(`${config.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          input: texts,
          dimensions: config.dimensions,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Embedding provider returned HTTP ${response.status}.`);
      }
      const payload = await response.json();
      const rows = Array.isArray(payload?.data)
        ? payload.data.slice().sort((a, b) => Number(a.index) - Number(b.index))
        : [];
      return assertEmbeddingBatch(
        rows.map((row) => new Float32Array(row.embedding || [])),
        texts.length,
        config.dimensions
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new EmbeddingUnavailableError(
          `Embedding request timed out after ${config.timeoutMs}ms.`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return validateEmbeddingProvider({
    available: true,
    model: config.model,
    dimensions: config.dimensions,
    embedDocuments(texts) {
      if (!Array.isArray(texts) || texts.length < 1) {
        return Promise.resolve([]);
      }
      return embed(texts.map((text) => String(text)));
    },
    async embedQuery(text) {
      const [vector] = await embed([String(text)]);
      return vector;
    },
  });
}

function createDisabledEmbeddingProvider(reason = "disabled") {
  return Object.freeze({
    available: false,
    reason,
    model: "",
    dimensions: 0,
    async embedDocuments() {
      throw new EmbeddingUnavailableError(`Embedding is ${reason}.`);
    },
    async embedQuery() {
      throw new EmbeddingUnavailableError(`Embedding is ${reason}.`);
    },
  });
}

function validateEmbeddingProvider(provider) {
  if (!provider || provider.available === false) return provider;
  if (typeof provider.model !== "string" || !provider.model) {
    throw new Error("Embedding provider model is required.");
  }
  if (!Number.isInteger(provider.dimensions) || provider.dimensions < 1) {
    throw new Error("Embedding provider dimensions must be a positive integer.");
  }
  if (
    typeof provider.embedDocuments !== "function" ||
    typeof provider.embedQuery !== "function"
  ) {
    throw new Error("Embedding provider must implement document and query embedding.");
  }
  return provider;
}

function assertEmbeddingBatch(vectors, expectedCount, dimensions) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new Error("Embedding provider returned an unexpected vector count.");
  }
  for (const vector of vectors) {
    if (
      !(vector instanceof Float32Array) ||
      vector.length !== dimensions ||
      Array.from(vector).some((value) => !Number.isFinite(value))
    ) {
      throw new Error("Embedding provider returned an invalid vector.");
    }
  }
  return vectors;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

module.exports = {
  EmbeddingUnavailableError,
  resolveEmbeddingConfig,
  createEmbeddingProvider,
  createDisabledEmbeddingProvider,
  validateEmbeddingProvider,
  assertEmbeddingBatch,
};
