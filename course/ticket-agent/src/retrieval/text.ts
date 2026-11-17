// 检索用的分词：英文和数字按整词切，中文按相邻两个字（二元组）切，单个汉字保留为一个词。
// 不需要分词库；真实项目可替换为 jieba 等分词器或数据库自带的全文检索分词，函数签名不变。
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const run of text.toLowerCase().match(/[a-z0-9]+|\p{Script=Han}+/gu) ?? []) {
    if (!/\p{Script=Han}/u.test(run)) tokens.push(run);
    else if (run.length === 1) tokens.push(run);
    else for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}
