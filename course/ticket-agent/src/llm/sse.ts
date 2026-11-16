// 解析 Server-Sent Events。网络每次送来的一块数据（chunk）可能只有半个汉字、
// 半行 JSON，所以必须先缓存，等到空行（一个完整事件的结尾）再交出 data。
export async function* readSSE(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    // stream: true 会把被切断的多字节汉字留到下一块再解码
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const data = extractData(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (data !== null) yield data;
    }
  }

  buffer += decoder.decode();
  const rest = extractData(buffer.replace(/\r\n/g, '\n').trim());
  if (rest !== null) yield rest;
}

function extractData(rawEvent: string): string | null {
  const lines = rawEvent
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  return lines.length > 0 ? lines.join('\n') : null;
}
