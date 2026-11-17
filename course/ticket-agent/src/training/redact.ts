// 训练数据脱敏（第 25 章）。
// 正则只能抓住格式固定的个人信息：邮箱、手机号、身份证号、长串数字。人名、地址、截图里的文字它抓不到，
// 所以这里还接受一份“已知姓名”名单（来自员工目录）；生产中再加一层 NER 或专门的 PII 服务，并抽样人工复核。

export interface RedactionStats {
  email: number;
  phone: number;
  idNumber: number;
  longNumber: number;
  name: number;
}

const patterns: Array<{ kind: keyof RedactionStats; pattern: RegExp; placeholder: string }> = [
  { kind: 'email', pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, placeholder: '<EMAIL>' },
  // 身份证号必须先于手机号处理：18 位号码里可能含有 11 位像手机号的片段
  { kind: 'idNumber', pattern: /(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g, placeholder: '<ID_NUMBER>' },
  { kind: 'phone', pattern: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, placeholder: '<PHONE>' },
  { kind: 'phone', pattern: /(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/g, placeholder: '<PHONE>' },
  // 兜底：7 位以上的连续数字（银行卡、工号、被截断的手机号）。会误伤订单号之类，宁可多删
  { kind: 'longNumber', pattern: /(?<!\d)\d{7,}(?!\d)/g, placeholder: '<NUMBER>' },
];

export function emptyStats(): RedactionStats {
  return { email: 0, phone: 0, idNumber: 0, longNumber: 0, name: 0 };
}

/** 把文本中的个人信息替换成占位符，并累加到 stats。knownNames 来自员工目录，长的先替换 */
export function redact(text: string, stats: RedactionStats = emptyStats(), knownNames: string[] = []): string {
  let result = text;
  for (const { kind, pattern, placeholder } of patterns) {
    result = result.replace(pattern, () => {
      stats[kind] += 1;
      return placeholder;
    });
  }
  for (const name of [...knownNames].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(name, () => {
      stats.name += 1;
      return '<NAME>';
    });
  }
  return result;
}

/** 导出后的最终检查：脱敏后的文本里还能找到个人信息，就说明规则有漏洞，导出应当失败 */
export function containsPii(text: string, knownNames: string[] = []): boolean {
  return patterns.some(({ pattern }) => new RegExp(pattern.source).test(text)) || knownNames.some((name) => name && text.includes(name));
}
