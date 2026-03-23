/**
 * Browser connection manager.
 * Lazily connects to a Chrome instance on localhost:9222.
 * Starts Chrome if not already running.
 */

import { execSync, spawn } from "node:child_process";
import type { Browser, Page } from "puppeteer-core";
import puppeteer from "puppeteer-core";

const CHROME_PORT = 9222;
const CONNECT_TIMEOUT = 5000;
const USER_DATA_DIR = `${process.env.HOME}/.cache/browser-tools`;

let browserInstance: Browser | null = null;

function getChromePath(): string {
	if (process.platform === "darwin") {
		return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	}
	const paths = ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"];
	for (const p of paths) {
		try {
			execSync(`test -x ${p}`, { stdio: "ignore" });
			return p;
		} catch {}
	}
	throw new Error("Chrome/Chromium not found. Install google-chrome or chromium.");
}

async function isReady(): Promise<boolean> {
	try {
		const b = await Promise.race([
			puppeteer.connect({ browserURL: `http://localhost:${CHROME_PORT}`, defaultViewport: null }),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
		]);
		await b.disconnect();
		return true;
	} catch {
		return false;
	}
}

function startChrome(): void {
	const chromePath = getChromePath();

	const chromeArgs = [
		`--remote-debugging-port=${CHROME_PORT}`,
		`--user-data-dir=${USER_DATA_DIR}`,
		"--no-first-run",
		"--no-sandbox",
		"--disable-setuid-sandbox",
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-gpu",
		"--disable-dev-shm-usage",
		// Always use headless — we don't need a visible window, just the CDP protocol.
		// Even with DISPLAY set, headless is more reliable in containers.
		"--headless",
	];

	execSync(`mkdir -p "${USER_DATA_DIR}"`, { stdio: "ignore" });

	const chrome = spawn(chromePath, chromeArgs, {
		detached: true,
		stdio: "ignore",
	});
	chrome.unref();
}

/**
 * Get a connected browser instance. Starts Chrome if needed.
 */
export async function getBrowser(): Promise<Browser> {
	// If we have a cached instance, check it's still connected
	if (browserInstance) {
		try {
			// Quick ping — if disconnected this throws
			await browserInstance.version();
			return browserInstance;
		} catch {
			browserInstance = null;
		}
	}

	// Try to connect to existing Chrome
	try {
		browserInstance = await Promise.race([
			puppeteer.connect({ browserURL: `http://localhost:${CHROME_PORT}`, defaultViewport: null }),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), CONNECT_TIMEOUT)),
		]);
		return browserInstance;
	} catch {
		// Chrome not running — start it
	}

	startChrome();

	// Wait for Chrome to be ready
	for (let i = 0; i < 30; i++) {
		if (await isReady()) {
			browserInstance = await puppeteer.connect({
				browserURL: `http://localhost:${CHROME_PORT}`,
				defaultViewport: null,
			});
			return browserInstance;
		}
		await new Promise((r) => setTimeout(r, 500));
	}

	throw new Error("Failed to start Chrome. Ensure google-chrome is installed.");
}

/**
 * Get the active (last) page, or create one if none exist.
 */
export async function getActivePage(): Promise<Page> {
	const browser = await getBrowser();
	const pages = await browser.pages();
	if (pages.length === 0) {
		return browser.newPage();
	}
	return pages[pages.length - 1];
}
