import { buildApp, createLogger } from "./app.js";
import { checkReadiness, loadConfig } from "./config.js";
import { SIMULATOR_VERSION } from "./simulator/ids.js";

const config = loadConfig();
const logger = createLogger(config);

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception, exiting");
  process.exit(1);
});

const { app, engine, subscriptions } = await buildApp({ config, logger });

// Variable names only. Values (secrets) are never logged.
const readiness = checkReadiness(config, {
  enabledWebhooks: subscriptions.enabledCount,
  webhookStorePersistent: subscriptions.persistent,
});
logger.info(
  {
    version: SIMULATOR_VERSION,
    environment: config.nodeEnv,
    ready: readiness.ready,
    missing_variables: readiness.missing,
    invalid_variables: readiness.invalid,
    warnings: readiness.warnings,
  },
  "simulator starting in idle state",
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown requested");
  const forceExit = setTimeout(() => {
    logger.error("shutdown timed out, forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  try {
    await engine.shutdown(3000);
    await app.close();
    logger.info("shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error({ err }, "error during shutdown");
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  logger.fatal({ err }, "failed to bind HTTP server");
  process.exit(1);
}
