import { launchBrowser, sleep } from "./browser.ts";
import { CliError } from "./client.ts";

export { findBrowser } from "./browser.ts";

/**
 * Open a fresh browser window on the note.com login page, let the user log in by hand
 * (email/password login requires reCAPTCHA since 2026-05), and return the note.com cookies
 * once `isLoggedIn` accepts them.
 */
export async function browserLogin(opts: {
  timeoutSec: number;
  browser?: string;
  isLoggedIn: (cookies: Record<string, string>) => Promise<boolean>;
}): Promise<Record<string, string>> {
  const { cdp, proc, close } = await launchBrowser({ browser: opts.browser, url: "https://note.com/login", prefix: "note-cli-login-" });
  try {
    console.error("Log in to note.com in the opened browser window. Waiting...");

    const deadline = Date.now() + opts.timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new CliError("LOGIN_ABORTED", "The browser was closed before login completed.");

      const { targetInfos } = await cdp.send<{ targetInfos: Array<{ type: string; url: string }> }>("Target.getTargets");
      const onLoginPage = targetInfos.some((t) => t.type === "page" && /note\.com\/login/.test(t.url));
      if (!onLoginPage) {
        const { cookies } = await cdp.send<{ cookies: Array<{ name: string; value: string; domain: string }> }>(
          "Storage.getCookies",
        );
        const map = Object.fromEntries(
          cookies.filter((c) => /(^|\.)note\.com$/.test(c.domain.replace(/^\./, ""))).map((c) => [c.name, c.value]),
        );
        if (map._note_session_v5 && (await opts.isLoggedIn(map))) return map;
      }
      await sleep(1500);
    }
    throw new CliError("LOGIN_TIMEOUT", `Login was not completed within ${opts.timeoutSec}s.`);
  } finally {
    await close();
  }
}
