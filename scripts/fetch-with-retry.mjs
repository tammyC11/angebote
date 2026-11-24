const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0",
  "Accept-Language": "de-DE,de;q=0.9,en;q=0.5",
};

/** fetch with browser-like headers, a timeout and retries. */
export async function fetchWithRetry(url, { headers = {}, retries = 3, timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { ...BROWSER_HEADERS, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      lastError = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status < 500 && res.status !== 429) break; // retrying won't help
    } catch (err) {
      // e.g. "fetch failed" — add the URL and the underlying reason (DNS, timeout, …)
      const reason = err?.cause?.code ?? err?.cause?.message ?? err?.name;
      lastError = new Error(`${err.message} for ${url}${reason ? ` (${reason})` : ""}`, { cause: err });
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw lastError;
}
