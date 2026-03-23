import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { attachTool } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createBrowserTools } from "./browser/index.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { setUploadFunction } from "./attach.js";
export { createSendMessageToChannelTool } from "./send-message-to-channel.js";
export { createBrowserTools } from "./browser/index.js";

export function createMomTools(executor: Executor): AgentTool<any>[] {
	return [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		attachTool,
	];
}
