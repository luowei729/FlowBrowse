// probe.js —— 节点延迟探测（放弃 QUIC，改用经服务器的 HTTPS 往返计时）
// 说明：MV3 无法做原始 TCP/QUIC 测速；服务器的 HTTPS 站点（订阅端点）必然可达，
//       对其 HEAD 请求计时即得到「到服务器的 TCP+TLS 往返延迟」，稳定且无需 offscreen。

// host：节点域名；返回 { ok, latencyMs } 或 { ok:false, error }
export async function probeLatency(host) {
  if (!host) return { ok: false, error: '无主机' };
  const t0 = performance.now();
  try {
    // 加时间戳查询参数避免缓存；HEAD 无 body，最轻
    const resp = await fetch(`https://${host}/?_=${Date.now()}`, {
      method: 'HEAD',
      cache: 'no-store',
      credentials: 'omit',
    });
    const latencyMs = Math.round(performance.now() - t0);
    return { ok: resp.ok, latencyMs };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
