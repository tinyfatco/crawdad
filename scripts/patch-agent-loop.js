#!/usr/bin/env node

/**
 * Agent-loop patch — no longer needed as of pi-agent-core 0.58.4.
 *
 * The Agent class now uses runAgentLoop/runAgentLoopContinue directly
 * (not the stream-wrapper IIFE pattern), with proper error handling
 * built into Agent._runLoop's try/catch.
 *
 * This script is kept as a no-op so `npm run patch` in the build still succeeds.
 */

console.log("No patch needed — Agent uses runAgentLoop directly (0.58.4+)");
