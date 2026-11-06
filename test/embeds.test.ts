import assert from "node:assert/strict";
import { test } from "bun:test";
import { embedService } from "../src/embeds.ts";

test("embedService follows the editor's URL patterns", () => {
  const cases: Array<[string, string | null]> = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"],
    ["https://youtu.be/dQw4w9WgXcQ?si=x", "youtube"],
    ["https://x.com/note/status/123", "twitter"],
    ["https://twitter.com/note", "twitterProfile"],
    ["https://note.com/someone/n/n0123456789ab", "note"],
    ["https://github.com/shoot16625/note-cli", "githubRepository"],
    ["https://open.spotify.com/track/abc", "spotify"],
    ["https://bsky.app/profile/a.bsky.social", "bluesky"],
    ["https://example.com/post", null],
  ];
  for (const [url, service] of cases) assert.equal(embedService(url), service, url);
});
