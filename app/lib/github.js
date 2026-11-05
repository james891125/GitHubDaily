// GitHub REST API 小工具（可選的使用者 Token；未提供時每小時 60 次限制）
const API = "https://api.github.com";
const cache = new Map(); // 簡易記憶體快取，10 分鐘
const TTL = 10 * 60 * 1000;

function headers(token, accept = "application/vnd.github+json") {
  return {
    accept,
    "user-agent": "githubdaily-workbench",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function cachedFetch(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function ghFetch(url, token, accept) {
  const res = await fetch(url, { headers: headers(token, accept) });
  if (res.status === 404) throw new GitHubError("找不到此倉庫（可能已改名或刪除）", 404);
  if (res.status === 403 || res.status === 429) {
    const remain = res.headers.get("x-ratelimit-remaining");
    throw new GitHubError(
      remain === "0" ? "GitHub API 速率限制已用完，請在設定中加入 GitHub Token。" : `GitHub 拒絕存取（${res.status}）`,
      res.status,
    );
  }
  if (res.status === 401) throw new GitHubError("GitHub Token 無效", 401);
  if (!res.ok) throw new GitHubError(`GitHub API 錯誤 ${res.status}`, res.status);
  return res;
}

export async function getRepoInfo(fullName, token) {
  return cachedFetch(`info:${fullName}`, async () => {
    const r = await ghFetch(`${API}/repos/${fullName}`, token);
    const d = await r.json();
    return {
      full_name: d.full_name,
      html_url: d.html_url,
      description: d.description,
      stars: d.stargazers_count,
      forks: d.forks_count,
      open_issues: d.open_issues_count,
      language: d.language,
      license: d.license?.spdx_id || null,
      topics: d.topics || [],
      archived: d.archived,
      pushed_at: d.pushed_at,
      created_at: d.created_at,
      homepage: d.homepage || null,
    };
  });
}

export async function getReadme(fullName, token, maxChars = 30000) {
  return cachedFetch(`readme:${fullName}`, async () => {
    try {
      const r = await ghFetch(`${API}/repos/${fullName}/readme`, token, "application/vnd.github.raw");
      const t = await r.text();
      return t.length > maxChars ? t.slice(0, maxChars) + "\n\n…（README 過長，以下省略）" : t;
    } catch (e) {
      if (e.status === 404) return "";
      throw e;
    }
  });
}

/** 依活躍度給出簡單健康評等 */
export function healthOf(info) {
  if (!info) return { level: "unknown", label: "未知" };
  if (info.archived) return { level: "bad", label: "已封存" };
  const days = (Date.now() - new Date(info.pushed_at).getTime()) / 86400000;
  if (days < 90) return { level: "good", label: "活躍", days: Math.round(days) };
  if (days < 365) return { level: "ok", label: "一般", days: Math.round(days) };
  return { level: "bad", label: "停滯", days: Math.round(days) };
}
