/**
 * DF Imóveis -> Bitrix24 (Webhook)
 * Autor: Adriano Alves
 *
 * ✅ Correções incluídas:
 * - mode=fields roda ANTES de validar name/email/phone
 * - Remove uso de crm.activity.add (evita erro COMMUNICATIONS)
 * - Cria/atualiza Lead + grava texto no campo COMMENTS (campo do Lead)
 * - Opcional: também cria comentário na TIMELINE (crm.timeline.comment.add)
 * - Anti-duplicação simples: procura lead por telefone/e-mail e atualiza se achar
 *
 * ENV:
 * - BITRIX_WEBHOOK_URL = https://SEU.bitrix24.com.br/rest/1/SEU_WEBHOOK
 */

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;

function onlyDigits(str = "") {
  return String(str).replace(/\D+/g, "");
}

function normalizePhoneBR(phoneRaw = "") {
  // Aceita: 61999998888, +55 61 99999-8888, 61 99999-8888 etc.
  const d = onlyDigits(phoneRaw);
  if (!d) return "";

  // Se vier com 55 na frente
  if (d.length >= 12 && d.startsWith("55")) return `+${d}`;

  // Se vier DDD+numero sem 55
  if (d.length === 10 || d.length === 11) return `+55${d}`;

  // Se vier maior/menor, retorna como +digits (pra não quebrar)
  return d.startsWith("+") ? d : `+${d}`;
}

function nowISO() {
  return new Date().toISOString();
}

async function bitrixCall(method, params = {}) {
  if (!BITRIX_WEBHOOK_URL) {
    throw new Error("BITRIX_WEBHOOK_URL não definido");
  }

  const url = `${BITRIX_WEBHOOK_URL.replace(/\/+$/, "")}/${method}.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok || data.error) {
    const errMsg =
      data?.error_description ||
      data?.error ||
      `BITRIX_REQUEST_FAILED (${resp.status})`;
    const e = new Error(errMsg);
    e.status = resp.status;
    e.data = data;
    throw e;
  }

  return data.result;
}

async function findLeadByPhoneOrEmail({ phone, email }) {
  // Busca simples por PHONE/EMAIL. Retorna o primeiro lead encontrado.
  // Bitrix filtra assim: filter: { "PHONE": "+5561...", "EMAIL": "x@y.com" } (nem sempre funciona igual)
  // Estratégia: tenta por PHONE, depois por EMAIL.

  if (phone) {
    const list = await bitrixCall("crm.lead.list", {
      filter: { PHONE: phone },
      select: ["ID", "TITLE", "NAME", "PHONE", "EMAIL"],
      order: { ID: "DESC" },
    });
    if (Array.isArray(list) && list.length) return list[0];
  }

  if (email) {
    const list = await bitrixCall("crm.lead.list", {
      filter: { EMAIL: email },
      select: ["ID", "TITLE", "NAME", "PHONE", "EMAIL"],
      order: { ID: "DESC" },
    });
    if (Array.isArray(list) && list.length) return list[0];
  }

  return null;
}

function buildDfImoveisTitle({ portal = "DF Imóveis", listingCode = "NAO_INFORMADO", name = "Sem Nome" }) {
  return `${portal} | ${listingCode || "NAO_INFORMADO"} | ${name || "Sem Nome"}`;
}

function buildDfImoveisComment({
  portal = "DF Imóveis",
  listingCode = "NAO_INFORMADO",
  listingUrl = "",
  name = "",
  phone = "",
  email = "",
  leadOrigin = "dfimoveis",
  message = "",
  clientListingId = "",
  originListingId = "",
  originLeadId = "",
  timestamp = "",
}) {
  const lines = [];

  lines.push(`*Novo contato - ${portal}*`);
  lines.push("");
  lines.push(`🏷 Código do anúncio: ${listingCode || "NAO_INFORMADO"}`);

  if (listingUrl) lines.push(`🔗 Link do anúncio: ${listingUrl}`);

  if (name) lines.push(`👤 Nome: ${name}`);
  if (phone) lines.push(`📞 Telefone: ${phone}`);
  if (email) lines.push(`✉️ E-mail: ${email}`);

  lines.push(`🧭 leadOrigin: ${leadOrigin}`);

  lines.push("");
  lines.push("📝 Mensagem:");
  lines.push(message ? String(message) : "(sem mensagem)");

  lines.push("");
  lines.push("-- Dados técnicos --");
  if (clientListingId) lines.push(`clientListingId: ${clientListingId}`);
  if (originListingId) lines.push(`originListingId: ${originListingId}`);
  if (originLeadId) lines.push(`originLeadId: ${originLeadId}`);
  if (timestamp) lines.push(`timestamp: ${timestamp}`);

  return lines.join("\n");
}

module.exports = async (req, res) => {
  try {
    // =========================
    // ✅ 0) MODO "FIELDS" PRIMEIRO (antes de validar identidade)
    // =========================
    if (req.method === "GET" && (req.query?.mode === "fields" || req.query?.mode === "field")) {
      const fields = await bitrixCall("crm.lead.fields", {});
      return res.status(200).json({ ok: true, fields });
    }

    // =========================
    // ✅ 1) Aceita GET (querystring) e POST (body)
    // =========================
    const payload =
      req.method === "POST"
        ? (typeof req.body === "string" ? JSON.parse(req.body) : req.body || {})
        : (req.query || {});

    // Campos esperados (adaptáveis)
    const portal = payload.portal || "DF Imóveis";
    const leadOrigin = payload.leadOrigin || "dfimoveis";

    const name = payload.name || payload.nome || "";
    const email = payload.email || payload["e-mail"] || "";
    const phoneRaw = payload.phone || payload.telefone || payload.whatsapp || "";
    const phone = normalizePhoneBR(phoneRaw);

    const listingUrl = payload.listingUrl || payload.url || payload.imovelUrl || "";
    const listingCode =
      payload.listingCode ||
      payload.codigoAnuncio ||
      payload.codAnuncio ||
      payload.adCode ||
      payload.imovelCodigo ||
      "NAO_INFORMADO";

    const message = payload.message || payload.mensagem || "";

    // IDs técnicos (se o DF Imóveis mandar)
    const clientListingId = payload.clientListingId || payload.client_listing_id || "";
    const originListingId = payload.originListingId || payload.origin_listing_id || "";
    const originLeadId = payload.originLeadId || payload.origin_lead_id || "";
    const timestamp = payload.timestamp || payload.ts || "";

    // =========================
    // ✅ 2) Validação mínima
    // =========================
    if (!name && !email && !phone) {
      return res.status(400).json({
        error: "MISSING_IDENTITY",
        message: "Precisa de ao menos nome, e-mail ou telefone",
      });
    }

    // =========================
    // ✅ 3) Monta TITLE + COMMENTS (campo certo do Lead)
    // =========================
    const title = buildDfImoveisTitle({ portal, listingCode, name });
    const commentText = buildDfImoveisComment({
      portal,
      listingCode,
      listingUrl,
      name,
      phone,
      email,
      leadOrigin,
      message,
      clientListingId,
      originListingId,
      originLeadId,
      timestamp: timestamp || nowISO(),
    });

    // =========================
    // ✅ 4) Anti-duplicação: procura lead por phone/email
    // =========================
    let existing = null;
    try {
      existing = await findLeadByPhoneOrEmail({ phone, email });
    } catch (e) {
      // Se a busca falhar, não mata o fluxo (só cria novo)
      console.warn("findLeadByPhoneOrEmail failed:", e?.message);
    }

    const leadFields = {
      TITLE: title,
      NAME: name || undefined,

      // Campo certo (comentário do Lead)
      COMMENTS: commentText,

      // Fonte (opcional)
      SOURCE_DESCRIPTION: `${portal} (${leadOrigin})`,

      // Comunicação
      PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : undefined,
      EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : undefined,
    };

    // Remove undefined (Bitrix às vezes reclama)
    Object.keys(leadFields).forEach((k) => leadFields[k] === undefined && delete leadFields[k]);

    let leadId = null;
    let status = "";

    if (existing?.ID) {
      // Atualiza para não duplicar
      await bitrixCall("crm.lead.update", {
        id: existing.ID,
        fields: leadFields,
        params: { REGISTER_SONET_EVENT: "Y" },
      });
      leadId = Number(existing.ID);
      status = "LEAD_UPDATED";
    } else {
      leadId = await bitrixCall("crm.lead.add", {
        fields: leadFields,
        params: { REGISTER_SONET_EVENT: "Y" },
      });
      leadId = Number(leadId);
      status = "LEAD_CREATED";
    }

    // =========================
    // ✅ 5) (Opcional) Comentário na TIMELINE
    // =========================
    // Se você NÃO quiser timeline, comente esse bloco inteiro.
    try {
      await bitrixCall("crm.timeline.comment.add", {
        fields: {
          ENTITY_TYPE: "lead",
          ENTITY_ID: leadId,
          COMMENT: commentText,
        },
      });
    } catch (e) {
      // Se falhar, não quebra o lead
      console.warn("timeline.comment.add failed:", e?.message);
    }

    return res.status(200).json({ status, leadId });
  } catch (err) {
    console.error(err);

    // Erro do Bitrix com mais detalhes
    if (err?.message?.includes("BITRIX_REQUEST_FAILED") || err?.data) {
      return res.status(500).json({
        error: "INTERNAL_ERROR",
        message: err.message,
        bitrix: err.data || null,
      });
    }

    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: err.message || "Erro inesperado",
    });
  }
};
