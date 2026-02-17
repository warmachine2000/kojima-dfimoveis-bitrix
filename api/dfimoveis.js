// api/dfimoveis.js
// Endpoint DF Imóveis / 62 Imóveis -> Bitrix
// Suporta:
//  - POST (application/json) conforme VRSYNC
//  - GET (querystring) para testes manuais
//
// Regras DF Imóveis:
// 1) Se vier listingUrl no payload, usar (normalizando).
// 2) Se NÃO vier listingUrl, tentar gerar a partir de OriginListingId e resolver redirect para URL canônica.
// 3) NÃO montar URL com ClientListingId (VILLA...) porque pode dar 404.

function onlyDigits(str = "") {
  return String(str).replace(/\D+/g, "");
}

function normalizePhoneBR(raw = "") {
  const digits = onlyDigits(raw);
  if (!digits) return { e164: "", digits: "" };

  let d = digits;
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);

  const e164 = d ? `+55${d}` : "";
  return { e164, digits: d };
}

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function normalizeUrl(raw = "") {
  let url = safeStr(raw);
  if (!url) return "";

  if (url.startsWith("www.")) url = "https://" + url;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  // remove double slash no path (mantendo https://)
  url = url.replace(/([^:]\/)\/+/g, "$1");
  return url;
}

// Extrai um “código do anúncio” (ClientListingId normalmente)
function resolveListingCode(input = {}) {
  const direct =
    safeStr(input.listingCode) ||
    safeStr(input.ListingCode) ||
    safeStr(input.ClientListingId) ||
    safeStr(input.clientListingId);

  if (direct) return direct;

  const url = safeStr(input.listingUrl) || safeStr(input.ListingUrl) || safeStr(input.listingURL);
  const m = url.match(/\/imovel\/([^/?#]+)/i);
  return m ? m[1] : "NAO_INFORMADO";
}

function resolveListingUrlDirect(input = {}) {
  const direct =
    safeStr(input.listingUrl) ||
    safeStr(input.ListingUrl) ||
    safeStr(input.listingURL);

  return normalizeUrl(direct);
}

function originListingIdFrom(input = {}) {
  const v = input.originListingId ?? input.OriginListingId;
  const s = safeStr(v);
  // garante que é número (string numérica)
  if (!s) return "";
  if (!/^\d+$/.test(s)) return "";
  return s;
}

// Tenta descobrir a URL canônica publicamente
async function resolveDfCanonicalUrl({ directUrl, originListingId }) {
  const direct = normalizeUrl(directUrl);
  if (direct) return direct;

  const id = safeStr(originListingId);
  if (!id) return "";

  // candidatos: alguns portais aceitam /imovel/{id} ou /imovel/imovel-{id} com redirect
  const candidates = [
    `https://www.dfimoveis.com.br/imovel/${id}`,
    `https://www.dfimoveis.com.br/imovel/imovel-${id}`,
  ];

  for (const u of candidates) {
    try {
      // HEAD às vezes é bloqueado; se falhar, tenta GET leve
      const resp = await fetch(u, {
        method: "HEAD",
        redirect: "follow",
      });

      // Alguns CDNs não retornam resp.url no HEAD; mas geralmente retorna.
      if (resp && resp.ok && resp.url) {
        const finalUrl = normalizeUrl(resp.url);
        // se já vier canônica com -ID no final, melhor ainda
        if (/-\d+\/?$/.test(finalUrl)) return finalUrl;
        return finalUrl;
      }

      // fallback: tenta GET
      const resp2 = await fetch(u, { method: "GET", redirect: "follow" });
      if (resp2 && resp2.ok && resp2.url) {
        const finalUrl2 = normalizeUrl(resp2.url);
        if (/-\d+\/?$/.test(finalUrl2)) return finalUrl2;
        return finalUrl2;
      }
    } catch {
      // tenta próximo candidato
    }
  }

  // Se não conseguiu resolver, devolve um candidato "funcional provável" (para o corretor tentar)
  return candidates[0];
}

function buildComments(payload = {}) {
  const leadOrigin = safeStr(payload.leadOrigin || payload.LeadOrigin || "dfimoveis");
  const timestamp = safeStr(payload.timestamp || payload.Timestamp) || new Date().toISOString();

  const originLeadId = safeStr(payload.originLeadId || payload.OriginLeadId);
  const originListingId = safeStr(payload.originListingId || payload.OriginListingId);

  const name = safeStr(payload.name || payload.Name);
  const email = safeStr(payload.email || payload.Email);
  const phoneRaw = safeStr(payload.phone || payload.Phone || payload.PhoneNumber);
  const { e164 } = normalizePhoneBR(phoneRaw);

  const listingCode = resolveListingCode(payload);
  const listingUrl = safeStr(payload._resolvedListingUrl || payload.listingUrl || payload.ListingUrl || payload.listingURL);

  const msg = safeStr(payload.message || payload.Message);

  const lines = [];
  lines.push(`*Novo contato - DF Imóveis*`);
  lines.push(``);
  lines.push(`Código do anúncio: ${listingCode}`);
  if (listingUrl) lines.push(`Link do anúncio: ${listingUrl}`);
  if (name) lines.push(`Nome: ${name}`);
  if (e164) lines.push(`Telefone: ${e164}`);
  if (email) lines.push(`E-mail: ${email}`);
  lines.push(`leadOrigin: ${leadOrigin}`);
  lines.push(``);

  lines.push(`Mensagem:`);
  lines.push(msg || "(sem mensagem)");
  lines.push(``);

  lines.push(`-- Dados técnicos --`);
  lines.push(`timestamp: ${timestamp}`);
  if (originLeadId) lines.push(`originLeadId: ${originLeadId}`);
  if (originListingId) lines.push(`originListingId: ${originListingId}`);

  return lines.join("\n");
}

async function callBitrix(method, params) {
  const base = process.env.BITRIX_WEBHOOK_BASE_URL;
  if (!base) throw new Error("MISSING_ENV: BITRIX_WEBHOOK_BASE_URL");

  const url = `${base}/${method}.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok || data.error) {
    const msg = data.error_description || data.error || `HTTP_${resp.status}`;
    const err = new Error(`BITRIX_REQUEST_FAILED (${resp.status}) ${method} - ${msg}`);
    err.bitrix = data;
    throw err;
  }

  return data;
}

function parseIncoming(req) {
  if (req.method === "POST") return req.body || {};

  const q = req.query || {};
  return {
    leadOrigin: q.leadOrigin,
    timestamp: q.timestamp,
    originLeadId: q.originLeadId,
    name: q.name,
    email: q.email,
    phone: q.phone,
    clientListingId: q.clientListingId,
    originListingId: q.originListingId,
    listingCode: q.listingCode,
    listingUrl: q.listingUrl,
    message: q.message,
  };
}

function validateIdentity(p = {}) {
  const name = safeStr(p.name || p.Name);
  const email = safeStr(p.email || p.Email);
  const phone = safeStr(p.phone || p.Phone || p.PhoneNumber);

  if (!name && !email && !phone) {
    const err = new Error("MISSING_IDENTITY");
    err.statusCode = 400;
    err.publicMessage = "Precisa de ao menos nome, e-mail ou telefone";
    throw err;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET" && req.query && req.query.ping === "1") {
      return res.status(200).json({ ok: true, pong: true });
    }

    const incoming = parseIncoming(req);

    if (req.method === "GET" && req.query && req.query.mode === "sample") {
      return res.status(200).json({
        ok: true,
        expected: {
          LeadOrigin: "DFimoveis",
          Timestamp: new Date().toISOString(),
          OriginLeadId: "uuid",
          Name: "Teste",
          Email: "teste@gmail.com",
          Phone: "(61) 99999-9999",
          PhoneNumber: "(61) 99999-9999",
          ClientListingId: "VILLA152067V01",
          OriginListingId: 1227330,
          Message: "teste",
        },
      });
    }

    validateIdentity(incoming);

    const name = safeStr(incoming.name || incoming.Name);
    const email = safeStr(incoming.email || incoming.Email);

    const phoneRaw = safeStr(incoming.phone || incoming.Phone || incoming.PhoneNumber);
    const { e164 } = normalizePhoneBR(phoneRaw);

    const leadOrigin = safeStr(incoming.leadOrigin || incoming.LeadOrigin || "dfimoveis");

    const listingCode = resolveListingCode(incoming);

    // >>> AQUI: resolve URL com fallback no OriginListingId
    const originListingId = originListingIdFrom(incoming);
    const listingUrl = await resolveDfCanonicalUrl({
      directUrl: resolveListingUrlDirect(incoming),
      originListingId,
    });

    const sourceId = process.env.BITRIX_SOURCE_ID_DFIMOVEIS || undefined;
    const originUrlField = process.env.BITRIX_FIELD_ORIGIN_URL || "";

    const comments = buildComments({
      ...incoming,
      leadOrigin,
      listingCode,
      _resolvedListingUrl: listingUrl, // garante que aparece no comentário
      name,
      email,
      phone: phoneRaw,
    });

    const leadFields = {
      TITLE: `DF Imóveis | ${listingCode} | ${name || "Novo Lead"}`,
      NAME: name || "",
      COMMENTS: comments,
    };

    if (sourceId) leadFields.SOURCE_ID = sourceId;

    if (e164) {
      leadFields.PHONE = [{ VALUE: e164, VALUE_TYPE: "WORK" }];
    }
    if (email) {
      leadFields.EMAIL = [{ VALUE: email, VALUE_TYPE: "WORK" }];
    }

    // UF_CRM_ORIGIN_URL (se configurado)
    if (originUrlField && listingUrl) {
      leadFields[originUrlField] = listingUrl;
    }

    const created = await callBitrix("crm.lead.add", { fields: leadFields });
    const leadId = created?.result;

    return res.status(200).json({
      status: "LEAD_CREATED",
      leadId,
      listingCode,
      leadOrigin,
      listingUrl,
      receivedMethod: req.method,
    });
  } catch (err) {
    const status = err.statusCode || 500;

    return res.status(status).json({
      error: status === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
      message: err.publicMessage || err.message || "UNKNOWN_ERROR",
      details: err.bitrix || undefined,
    });
  }
}
