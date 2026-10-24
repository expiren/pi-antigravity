// Test preload: preserve real loopback HTTP tests, reject unmocked external provider traffic.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("Offline V3 validation refused an unmocked external network request.");
  return originalFetch(input, init);
};
