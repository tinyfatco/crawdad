#!/usr/bin/env node

/**
 * Patch pi-agent-core's agent-loop.js to add .catch() on the IIFE producers.
 *
 * Without this, if runLoop() throws after the stream has started producing events,
 * the error is silently swallowed — the EventStream never gets agent_end or end(),
 * and the consumer (Agent._runLoop's `for await`) hangs forever.
 *
 * This adds .catch() that pushes an error agent_end event and ends the stream,
 * so the consumer can surface the error.
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentLoopPath = join(__dirname, "..", "node_modules", "@mariozechner", "pi-agent-core", "dist", "agent-loop.js");

let code = readFileSync(agentLoopPath, "utf-8");
let patchCount = 0;

// Pattern 1: agentLoop IIFE — no .catch()
// Before: await runLoop(...); })();
// After:  await runLoop(...); })().catch((err) => { ... });
const pattern1 = `await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
    })();
    return stream;
}`;

const replacement1 = `await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
    })().catch((err) => {
        console.error("[agent-loop] IIFE error in agentLoop:", err);
        try {
            stream.push({ type: "agent_end", messages: newMessages });
            stream.end(newMessages);
        } catch (e) { /* stream may already be ended */ }
    });
    return stream;
}`;

if (code.includes(pattern1.split("\n")[0])) {
	code = code.replace(pattern1, replacement1);
	patchCount++;
}

// Pattern 2: agentLoopContinue IIFE — same issue
const pattern2 = `await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
    })();
    return stream;
}
function createAgentStream`;

const replacement2 = `await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
    })().catch((err) => {
        console.error("[agent-loop] IIFE error in agentLoopContinue:", err);
        try {
            stream.push({ type: "agent_end", messages: newMessages });
            stream.end(newMessages);
        } catch (e) { /* stream may already be ended */ }
    });
    return stream;
}
function createAgentStream`;

if (code.includes(pattern2.split("\n")[0])) {
	code = code.replace(pattern2, replacement2);
	patchCount++;
}

writeFileSync(agentLoopPath, code);
console.log(`Patched ${patchCount} IIFE(s) in agent-loop.js`);

if (patchCount === 0) {
	console.warn("WARNING: No patterns matched — agent-loop.js may have changed. Check manually.");
	process.exit(1);
}
