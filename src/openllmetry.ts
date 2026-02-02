/**
 * OpenLLMetry initialization — auto-instruments LLM SDK calls.
 *
 * OpenClaw is ESM and loads LLM SDKs before plugins initialize.
 * OpenLLMetry's require-hook patching won't catch already-loaded ESM modules.
 *
 * Solution:
 *   1. Call Traceloop.init() for general OTel pipeline setup
 *   2. Manually instrument each LLM SDK using the instrumentation's
 *      manuallyInstrument() method — patches prototypes in-place,
 *      affecting all existing instances retroactively.
 *
 * Supported providers: Anthropic, OpenAI, Bedrock, Vertex AI, Cohere, Together
 */

import { createRequire } from "node:module";
import type { OtelObservabilityConfig } from "./config.js";

let initialized = false;

// Resolve modules from OpenClaw's node_modules (not our plugin's)
const openclawRequire = createRequire(
  "/home/hrexed/.npm-global/lib/node_modules/openclaw/package.json"
);

/**
 * LLM provider definitions for manual instrumentation.
 * Each entry maps a provider SDK to its traceloop instrumentation.
 */
const LLM_PROVIDERS = [
  {
    name: "Anthropic",
    sdkPackage: "@anthropic-ai/sdk",
    instrumentationPackage: "@traceloop/instrumentation-anthropic",
    instrumentationClass: "AnthropicInstrumentation",
    // Verify the SDK has the expected structure
    validate: (sdk: any) => !!sdk?.Anthropic?.Messages?.prototype?.create,
  },
  {
    name: "OpenAI",
    sdkPackage: "openai",
    instrumentationPackage: "@traceloop/instrumentation-openai",
    instrumentationClass: "OpenAIInstrumentation",
    validate: (sdk: any) => !!sdk?.OpenAI || !!sdk?.default?.Chat?.Completions?.prototype?.create,
  },
  {
    name: "Bedrock",
    sdkPackage: "@aws-sdk/client-bedrock-runtime",
    instrumentationPackage: "@traceloop/instrumentation-bedrock",
    instrumentationClass: "BedrockInstrumentation",
    validate: (sdk: any) => !!sdk?.BedrockRuntimeClient?.prototype?.send,
  },
  {
    name: "Vertex AI",
    sdkPackage: "@google-cloud/vertexai",
    instrumentationPackage: "@traceloop/instrumentation-vertexai",
    instrumentationClass: "VertexAIInstrumentation",
    validate: (sdk: any) => !!sdk?.GenerativeModel?.prototype?.generateContent,
  },
  {
    name: "Google Generative AI",
    sdkPackage: "@google/generative-ai",
    instrumentationPackage: "@traceloop/instrumentation-vertexai",
    instrumentationClass: "VertexAIInstrumentation",
    validate: (sdk: any) => !!sdk?.GenerativeModel?.prototype?.generateContent,
  },
  {
    name: "Cohere",
    sdkPackage: "cohere-ai",
    instrumentationPackage: "@traceloop/instrumentation-cohere",
    instrumentationClass: "CohereInstrumentation",
    validate: (sdk: any) => !!sdk?.CohereClient || !!sdk?.default,
  },
  {
    name: "Together AI",
    sdkPackage: "together-ai",
    instrumentationPackage: "@traceloop/instrumentation-together",
    instrumentationClass: "TogetherInstrumentation",
    validate: (_sdk: any) => true,
  },
] as const;

export async function initOpenLLMetry(config: OtelObservabilityConfig, logger: any): Promise<void> {
  if (initialized) {
    logger.info("[otel] OpenLLMetry already initialized, skipping");
    return;
  }

  try {
    const traceloop = await import("@traceloop/node-server-sdk");

    const initOptions: Record<string, any> = {
      baseUrl: config.endpoint,
      disableBatch: false,
      appName: config.serviceName,
      traceContent: config.captureContent,
    };

    if (config.headers && Object.keys(config.headers).length > 0) {
      const headerStr = Object.entries(config.headers)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      process.env.TRACELOOP_HEADERS = headerStr;
    }

    process.env.TRACELOOP_BASE_URL = config.endpoint;

    traceloop.initialize(initOptions);
    initialized = true;
    logger.info(`[otel] OpenLLMetry initialized → ${config.endpoint} (captureContent=${config.captureContent})`);

    // Manually patch all available LLM SDKs
    await manuallyPatchAllProviders(config, logger);
  } catch (err) {
    logger.error(
      `[otel] Failed to initialize OpenLLMetry: ${err instanceof Error ? err.message : String(err)}`
    );
    logger.error("[otel] LLM auto-instrumentation will not be available");
  }
}

/**
 * Iterate all known LLM providers and manually instrument any that are
 * available in OpenClaw's node_modules.
 */
async function manuallyPatchAllProviders(config: OtelObservabilityConfig, logger: any): Promise<void> {
  let patchedCount = 0;

  for (const provider of LLM_PROVIDERS) {
    try {
      // Try to resolve the SDK from OpenClaw's module tree
      let sdk: any;
      try {
        sdk = openclawRequire(provider.sdkPackage);
      } catch {
        // SDK not installed in OpenClaw — skip silently
        continue;
      }

      // Get SDK version for logging
      let sdkVersion = "unknown";
      try {
        const pkgJson = openclawRequire(`${provider.sdkPackage}/package.json`);
        sdkVersion = pkgJson?.version || "unknown";
      } catch {
        // Some packages don't allow direct package.json import
      }

      // Validate SDK structure
      if (!provider.validate(sdk)) {
        logger.warn(`[otel] ${provider.name} SDK v${sdkVersion} found but structure doesn't match — skipping`);
        continue;
      }

      // Load the traceloop instrumentation
      let InstrumentationClass: any;
      try {
        const mod = await import(provider.instrumentationPackage);
        InstrumentationClass = mod[provider.instrumentationClass] || mod.default;
      } catch (err) {
        logger.warn(`[otel] Could not load ${provider.instrumentationPackage}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (!InstrumentationClass) {
        logger.warn(`[otel] ${provider.instrumentationPackage} loaded but ${provider.instrumentationClass} not found`);
        continue;
      }

      // Create and enable the instrumentation
      const instrumentation = new InstrumentationClass({
        traceContent: config.captureContent,
      });
      instrumentation.enable();

      // Manually patch the already-loaded SDK
      instrumentation.manuallyInstrument(sdk);

      patchedCount++;
      logger.info(`[otel] ✅ ${provider.name} SDK v${sdkVersion} manually instrumented`);
    } catch (err) {
      logger.warn(
        `[otel] Failed to instrument ${provider.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (patchedCount === 0) {
    logger.warn("[otel] No LLM SDKs were manually instrumented — GenAI spans won't be available");
  } else {
    logger.info(`[otel] ${patchedCount} LLM provider(s) instrumented for GenAI spans`);
  }
}
