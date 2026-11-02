/** Test-only preload: replace future GitHub responses with real fixture files. */
import { appendFileSync, readFileSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
const registry = process.env.PIPKEROPS_TEST_GITHUB_FIXTURE;
const audit = process.env.PIPKEROPS_TEST_GITHUB_AUDIT;
if (!registry)
  throw new Error("The managed GitHub fixture registry is required");
const originalFetch = globalThis.fetch;
const hosts = new Set([
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!hosts.has(url.hostname)) return originalFetch(input, init);
  const fixtures = JSON.parse(readFileSync(registry, "utf8"));
  const fixture = fixtures[url.href];
  if (audit)
    appendFileSync(
      audit,
      JSON.stringify({
        url: url.href,
        status: fixture ? (fixture.status ?? 200) : 404,
      }) + "\n",
    );
  if (!fixture)
    return new Response("No future GitHub fixture for this URL", {
      status: 404,
    });
  if (fixture.location)
    return new Response(null, {
      status: fixture.status ?? 302,
      headers: { Location: fixture.location },
    });
  return new Response(Readable.toWeb(createReadStream(fixture.file)), {
    status: fixture.status ?? 200,
    headers: {
      "Content-Type": fixture.contentType ?? "application/octet-stream",
    },
  });
};
