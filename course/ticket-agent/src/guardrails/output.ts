import type { GuardrailFinding } from '../events.ts';

// 第 21 章：输出端护栏。模型的回答会被渲染成 Markdown、被复制、被转发，它和 SQL、HTML 一样是“不可信输出”。
// 三件事：系统提示词泄露（金丝雀 + 原文重合）、外部链接/图片（数据外带通道）、个人敏感信息（PII）脱敏。

export const LEAK_REPLACEMENT = '（这段回答包含系统内部配置，已被拦截。）';

/** host 在白名单内：完全相同，或是白名单域名的子域名。用 includes/startsWith 判断会被 intranet.acme.example.evil.example 绕过 */
export function hostAllowed(url: string, allowedHosts: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
};

/**
 * 移除不在白名单内的外部图片、链接和裸网址。
 * 图片最危险：Markdown 渲染时浏览器会自动请求图片地址，不需要用户点击，地址里拼上的数据就被带走了。
 */
export function stripExternalLinks(text: string, allowedHosts: readonly string[]): { text: string; removed: string[] } {
  const removed: string[] = [];
  let out = text.replace(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g, (match, url: string) => {
    if (hostAllowed(url, allowedHosts)) return match;
    removed.push(`图片 ${hostOf(url)}`);
    return '[已移除外部图片]';
  });
  out = out.replace(/\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g, (match, label: string, url: string) => {
    if (hostAllowed(url, allowedHosts)) return match;
    removed.push(`链接 ${hostOf(url)}`);
    return `${label}（外部链接已移除）`;
  });
  out = out.replace(/\b(?:https?|ftp):\/\/[^\s<>"'）)\]]+/gi, (url) => {
    if (hostAllowed(url, allowedHosts)) return url;
    removed.push(`网址 ${hostOf(url)}`);
    return '[已移除外部链接]';
  });
  return { text: out, removed };
}

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
};

const piiRules: Array<{ type: string; pattern: RegExp; mask: (value: string) => string; valid?: (value: string) => boolean }> = [
  {
    type: '身份证号',
    pattern: /(?<![\dA-Za-z])\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![\dA-Za-z])/g,
    mask: (v) => `${v.slice(0, 6)}********${v.slice(-4)}`,
  },
  {
    type: '银行卡号',
    pattern: /(?<!\d)\d{16,19}(?!\d)/g,
    mask: (v) => `****${v.slice(-4)}`,
    // 16–19 位数字不一定是卡号（订单号、时间戳），过 Luhn 校验才算，减少误伤
    valid: luhn,
  },
  { type: '手机号', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, mask: (v) => `${v.slice(0, 3)}****${v.slice(-4)}` },
  { type: '邮箱', pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, mask: (v) => `${v[0]}***@${v.split('@')[1]}` },
];

/** 脱敏而不是整段拦截：回答的其余部分通常仍然有用。只返回每类命中几次，审计日志不再存一份敏感原文 */
export function redactPII(text: string): { text: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let out = text;
  for (const rule of piiRules) {
    out = out.replace(rule.pattern, (value) => {
      if (rule.valid && !rule.valid(value)) return value;
      counts[rule.type] = (counts[rule.type] ?? 0) + 1;
      return rule.mask(value);
    });
  }
  return { text: out, counts };
}

/**
 * 系统提示词泄露检测：① 金丝雀——提示词里埋一个随机标记，它只可能从提示词里来；
 * ② 原文重合——回答里逐字出现了提示词中两行以上的较长句子。
 * 两者都只能抓“原样输出”，翻译、改写、编码后的泄露抓不到（见红队用例 sysprompt-base64）。
 */
export function detectPromptLeak(text: string, systemPrompt: string, canary: string): string | undefined {
  if (canary && text.includes(canary)) return '回答中出现了金丝雀标记';
  const lines = systemPrompt.split('\n').map((line) => line.trim()).filter((line) => line.length >= 12 && !(canary && line.includes(canary)));
  const copied = lines.filter((line) => text.includes(line)).length;
  if (copied >= 2) return `回答逐字复制了系统提示词中的 ${copied} 行`;
  return undefined;
}

export interface OutputPolicy {
  allowedHosts: readonly string[];
  canary: string;
  redactPII: boolean;
}

export function checkOutput(text: string, systemPrompt: string, policy: OutputPolicy): { text: string; findings: GuardrailFinding[] } {
  const leak = detectPromptLeak(text, systemPrompt, policy.canary);
  if (leak) return { text: LEAK_REPLACEMENT, findings: [{ stage: 'output', rule: 'system_prompt_leak', action: 'block', detail: leak }] };

  const findings: GuardrailFinding[] = [];
  const links = stripExternalLinks(text, policy.allowedHosts);
  if (links.removed.length) findings.push({ stage: 'output', rule: 'external_link', action: 'redact', detail: links.removed.join('；') });
  let out = links.text;
  if (policy.redactPII) {
    const pii = redactPII(out);
    const summary = Object.entries(pii.counts).map(([type, n]) => `${type}×${n}`).join('、');
    if (summary) findings.push({ stage: 'output', rule: 'pii', action: 'redact', detail: summary });
    out = pii.text;
  }
  return { text: out, findings };
}
