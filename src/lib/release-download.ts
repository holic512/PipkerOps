import { ApiError } from "./auth";

/** Each download has one bounded deadline, including redirects and its body. */
export function trustedDownloadUrl(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    ![
      "api.github.com",
      "github.com",
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
    ].includes(url.hostname)
  )
    throw new ApiError(502, "发布文件地址不受信任");
  return url;
}
export async function downloadReleaseFile(
  raw: string,
  limit: number,
  timeoutMs = 120000,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  let url = trustedDownloadUrl(raw);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop < 6; hop++) {
    const response = await fetcher(url, {
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": "PipkerOps",
        Accept: "application/vnd.github+json",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = trustedDownloadUrl(
        new URL(response.headers.get("location") ?? "", url).href,
      );
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new ApiError(502, `获取发布文件失败（HTTP ${response.status}）`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) {
        throw new ApiError(502, "发布文件超过大小限制");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new ApiError(502, "发布下载重定向过多");
}
