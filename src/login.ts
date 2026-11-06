import { CliError } from "./client.ts";

/**
 * Open a real browser window, let the user log in to note.com by hand
 * (email/password login requires reCAPTCHA since 2026-05), then return the cookies.
 */
export async function browserLogin(opts: { timeoutSec: number; channel: string }): Promise<Record<string, string>> {
  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new CliError("DEPENDENCY_MISSING", "playwright-core is not installed. Run `npm install` in the note-cli repo.");
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: false, channel: opts.channel });
  } catch (e) {
    throw new CliError(
      "BROWSER_LAUNCH_FAILED",
      `Could not launch browser channel "${opts.channel}". Install Google Chrome, pass --channel msedge, or use \`note-cli auth import\`. (${(e as Error).message.split("\n")[0]})`,
    );
  }

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("https://note.com/login");
    console.error("Log in to note.com in the opened browser window. Waiting...");

    const deadline = Date.now() + opts.timeoutSec * 1000;
    while (Date.now() < deadline) {
      const cookies = await context.cookies("https://note.com");
      const map = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
      // The session cookie exists for anonymous visitors too; the login is done once
      // the browser leaves the /login page.
      if (map._note_session_v5 && !/\/login/.test(page.url())) {
        // Load a page once more so XSRF-TOKEN is refreshed for the logged-in session.
        await page.goto("https://note.com/").catch(() => {});
        const finalCookies = await context.cookies("https://note.com");
        return Object.fromEntries(finalCookies.map((c) => [c.name, c.value]));
      }
      if (page.isClosed()) throw new CliError("LOGIN_ABORTED", "Browser window was closed before login completed.");
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new CliError("LOGIN_TIMEOUT", `Login was not completed within ${opts.timeoutSec}s.`);
  } finally {
    await browser.close().catch(() => {});
  }
}
