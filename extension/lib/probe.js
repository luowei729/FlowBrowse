// probe.js —— WebTransport(QUIC/h3) RTT 探测；本模块只在 offscreen 文档中调用
// 为什么放 offscreen：Service Worker 对 WebTransport 支持不稳定，offscreen 是完整 DOM 安全源，最稳。
// 原理：向服务端 /wt 建会话，发一个带本地时间戳的不可靠数据报，服务端原样回显，
//       收到回显的时刻减去发送时刻即 QUIC 往返时延（RTT）。证书为 LE 受信证书，故无需 serverCertificateHashes。

export async function probeRtt(host, wtPort) {
  // 环境不支持 WebTransport（如非安全上下文）→ 明确降级
  if (typeof WebTransport === 'undefined') {
    return { ok: false, error: '当前上下文不支持 WebTransport' };
  }

  const url = `https://${host}:${wtPort}/wt`;
  let transport;
  try {
    transport = new WebTransport(url);
    await transport.ready;

    const start = performance.now();

    // 写入 8 字节浮点时间戳
    const writer = transport.datagrams.writable.getWriter();
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, start);
    await writer.ready;
    writer.write(new Uint8Array(view.buffer));
    writer.releaseLock();

    // 读回显
    const reader = transport.datagrams.readable.getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();

    const rttMs = Math.round(performance.now() - start);
    transport.close();
    return { ok: !done && value != null, rttMs };
  } catch (e) {
    // 失败（UDP 被封/证书/Origin 被拒等）→ 返回不 ok，交上层回退/提示
    try { transport && transport.close(); } catch (_) {}
    return { ok: false, error: String((e && e.message) || e) };
  }
}
