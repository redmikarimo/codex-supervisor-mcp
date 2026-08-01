const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_ALERT_COOLDOWN_MS = 300_000;
const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

function booleanFromEnv(env, name, defaultValue) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") {
    return defaultValue;
  }
  return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
}

function positiveIntegerFromEnv(env, name, defaultValue) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") {
    return defaultValue;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function optionalPositiveIntegerFromEnv(env, name) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer when provided.`);
  }
  return value;
}

export function monitorConfigFromEnv(env = process.env) {
  return {
    enabled: booleanFromEnv(env, "BIOTELE_RELAY_MONITOR_ENABLED", true),
    intervalMs: positiveIntegerFromEnv(env, "BIOTELE_RELAY_MONITOR_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    alertCooldownMs: positiveIntegerFromEnv(
      env,
      "BIOTELE_RELAY_MONITOR_ALERT_COOLDOWN_MS",
      DEFAULT_ALERT_COOLDOWN_MS,
    ),
    failureThreshold: positiveIntegerFromEnv(
      env,
      "BIOTELE_RELAY_MONITOR_FAILURE_THRESHOLD",
      DEFAULT_FAILURE_THRESHOLD,
    ),
    queueWarningThreshold: optionalPositiveIntegerFromEnv(
      env,
      "BIOTELE_RELAY_MONITOR_QUEUE_WARNING_THRESHOLD",
    ),
    agentStaleMs: optionalPositiveIntegerFromEnv(env, "BIOTELE_RELAY_MONITOR_AGENT_STALE_MS"),
    webhookUrl: String(env.BIOTELE_RELAY_MONITOR_WEBHOOK_URL ?? "").trim(),
    webhookTimeoutMs: positiveIntegerFromEnv(
      env,
      "BIOTELE_RELAY_MONITOR_WEBHOOK_TIMEOUT_MS",
      DEFAULT_WEBHOOK_TIMEOUT_MS,
    ),
  };
}

function failingCheckNames(snapshot) {
  return Object.entries(snapshot.checks)
    .filter(([, check]) => !check.ok)
    .map(([name]) => name)
    .join(",");
}

function cloneSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

export class RelayMonitor {
  constructor({
    state,
    config,
    logger = process.stdout,
    errorLogger = logger === process.stdout ? process.stderr : logger,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  }) {
    this.state = state;
    this.config = config;
    this.logger = logger;
    this.errorLogger = errorLogger;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timer = null;
    this.consecutiveFailures = 0;
    this.lastAlertAt = 0;
  }

  snapshot() {
    const now = this.now();
    const checks = {
      readiness: {
        ok: this.state.status === "ready",
        status: this.state.status,
        ...(this.state.error?.type ? { errorType: this.state.error.type } : {}),
      },
      queue: {
        ok: true,
        pending: this.state.config?.queue?.size ?? 0,
        threshold: this.config.queueWarningThreshold,
      },
      agent: {
        ok: true,
        lastSeenAt: this.state.lastAgentSeenAt
          ? new Date(this.state.lastAgentSeenAt).toISOString()
          : null,
        staleAfterMs: this.config.agentStaleMs,
      },
    };

    if (
      this.config.queueWarningThreshold !== null &&
      checks.queue.pending >= this.config.queueWarningThreshold
    ) {
      checks.queue.ok = false;
    }

    if (this.config.agentStaleMs !== null) {
      checks.agent.ok =
        this.state.lastAgentSeenAt !== null && now - this.state.lastAgentSeenAt < this.config.agentStaleMs;
    }

    const ok = Object.values(checks).every((check) => check.ok);
    return {
      status: ok ? "ok" : "degraded",
      checkedAt: new Date(now).toISOString(),
      consecutiveFailures: this.consecutiveFailures,
      checks,
    };
  }

  async check({ forceAlert = false } = {}) {
    const snapshot = this.snapshot();
    if (!this.config.enabled) {
      return snapshot;
    }
    if (snapshot.status === "ok") {
      this.consecutiveFailures = 0;
      return this.snapshot();
    }

    this.consecutiveFailures += 1;
    const failedSnapshot = this.snapshot();
    if (forceAlert || this.consecutiveFailures >= this.config.failureThreshold) {
      await this.alert(failedSnapshot);
    }
    return failedSnapshot;
  }

  start() {
    if (!this.config.enabled || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.check();
    }, this.config.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  recordAgentSeen() {
    this.state.lastAgentSeenAt = this.now();
  }

  async alert(snapshot) {
    const now = this.now();
    if (this.lastAlertAt > 0 && now - this.lastAlertAt < this.config.alertCooldownMs) {
      return;
    }
    this.lastAlertAt = now;
    const failedChecks = failingCheckNames(snapshot);
    this.errorLogger.write?.(`Hostinger relay health alert: status=${snapshot.status}; failed=${failedChecks}\n`);

    if (!this.config.webhookUrl || typeof this.fetchImpl !== "function") {
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.webhookTimeoutMs);
    try {
      await this.fetchImpl(this.config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "biotele.relay.health_alert",
          status: snapshot.status,
          checkedAt: snapshot.checkedAt,
          consecutiveFailures: snapshot.consecutiveFailures,
          failedChecks,
          checks: snapshot.checks,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      this.errorLogger.write?.(`Hostinger relay health alert webhook failed: ${error.name}\n`);
    } finally {
      clearTimeout(timeout);
    }
  }

  toJSON() {
    return cloneSnapshot(this.snapshot());
  }
}
