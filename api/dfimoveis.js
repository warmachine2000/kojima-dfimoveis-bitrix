/**
 * DF Imóveis -> Bitrix24 (Webhook)
 *
 * ✅ Correções:
 * - mode=fields roda ANTES de validar identidade
 * - NÃO usa crm.activity.add
 * - COMMENTS (campo do Lead) recebe TEXTO PURO + \r\n (para não “cortar” na 1ª linha)
 * - Timeline opcional (env ENABLE_TIMELINE=1)
 * - Anti-duplicação: tenta achar por PHONE / EMAIL e atualiza se existir
 *
 * ENV:
 * - BITRIX_WEBHOOK_URL = https://SEU.bitrix24.com.br/rest/1/SEU_WEBHOOK
 * - ENABLE_TIMELINE = "1" (opcional; se não setar, por padrão fica ON)
 */

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const ENABLE_TIMELINE = process.env.ENABLE_TIMELINE !== "0"; // default ON

function onlyDigits(str = "") {
  return String(str).replace(/\D+/g, "");
}

function normalizePhoneBR(phoneRaw = "") {
  const d = onlyDigits(phoneRaw);
  if (!d) return "";

  if (d.length >= 12 && d.startsWith("55")) return `+${d}`;
  if (d.length === 10 || d.length === 11) return `+55${d}`;

  return d.startsWith("+") ? d : `+${d}`;
}

function nowISO() {
  return new Date().toISOString();
}

async function bitrixCall(method, params = {}) {
  if (!BITRIX_WEBHOOK_URL) throw new Error("BITRIX_WEBHOOK_URL não definido");

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
  // tenta por PHONE
  if (phone) {
    const list = await bitrixCall("crm.lead.list", {
      filter: { PHONE: phone },
      select: ["ID", "TITLE", "NAME", "PHONE", "EMAIL"],
      order: { ID: "DESC" },
    });
    if (Array.isArray(list) && list.length) return list[0];
  }

  // tenta por EMAIL
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

/**
 * ✅ Campo COMMENTS do Lead:
 * - Sem emojis
 * - Sem markdown
 * - Usa \r\n
 */
function buildLeadCommentsPlain({
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

  lines.push(`Novo contato - ${portal}`);
  lines.push("");
  lines.push(`Codigo do anuncio: ${listingCode || "NAO_INFORMADO"}`);
  if (listingUrl) lines.push(`Link do anuncio: ${listingUrl}`);
  if (name) lines.push(`Nome: ${name}`);
  if (phone) lines.push(`Telefone: ${phone}`);
  if (email) lines.push(`Email: ${email}`);
  lines.push(`leadOrigin: ${leadOrigin}`);
  lines.push("");
  lines.push("Mensagem:");
  lines.push(message ? String(message) : "(sem mensagem)");
  lines.push("");
  lines.push("Dados tecnicos:");
  if (clientListingId) lines.push(`clientListingId: ${clientListingId}`);
  if (originListingId) lines.push(`originListingId: ${originListingId}`);
  if (originLeadId) lines.push(`originLeadId: ${originLeadId}`);
  if (timestamp) lines.push(`timestamp: ${timestamp}`);

  // ✅ importante: \r\n
  return lines.join("\r\n");
}

/**
 * (Opcional) Timeline pode ter emoji/“bonitinho”
 */
function buildTimelineCommentPretty({
  portal = "DF Imóveis",
  listingCode = "NAO_INFORMADO",
  listingUrl = "",
  name = "",
  phone = "",
  email = "",
  leadOrigin = "dfimoveis",
  message = "",
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
  lines.push(`timestamp: ${timestamp || nowISO()}`);

  return lines.join("\n");
}

module.exports = async (req, res) => {
  try {
    // =========================
    // ✅ 0) MODE=FIELDS primeiro
    // =========================
    if (req.method === "GET" && (req.query?.mode === "fields" || req.query?.mode === "field")) {
      const fields = await bitrixCall("crm.lead.fields", {});
      return res.status(200).json({ ok: true, fields });
    }

    // =========================
    // ✅ 1) Payload GET/POST
    // =========================
    const payload =
      req.method === "POST"
        ? (typeof req.body === "string" ? JSON.parse(req.body) : req.body || {})
        : (req.query || {});

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

    const clientListingId = payload.clientListingId || payload.client_listing_id || "";
    const originListingId = payload.originListingId || payload.origin_listing_id || "";
    const originLeadId = payload.originLeadId || payload.origin_lead_id || "";
    const timestamp = payload.timestamp || payload.ts || nowISO();

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
    // ✅ 3) Monta TITLE + COMMENTS
    // =========================
    const title = buildDfImoveisTitle({ portal, listingCode, name });

    // ✅ “campo Comentário do Lead”
    const commentsPlain = buildLeadCommentsPlain({
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
      timestamp,
    });

    // (Opcional) timeline bonitinha
    const timelinePretty = buildTimelineCommentPretty({
      portal,
      listingCode,
      listingUrl,
      name,
      phone,
      email,
      leadOrigin,
      message,
      timestamp,
    });

    // =========================
    // ✅ 4) Anti-duplicação
    // =========================
    let existing = null;
    try {
      existing = await findLeadByPhoneOrEmail({ phone, email });
    } catch (e) {
      console.warn("findLeadByPhoneOrEmail failed:", e?.message);
    }

    const leadFields = {
      TITLE: title,
      NAME: name || undefined,
      COMMENTS: commentsPlain, // ✅ aqui é o que vai para o campo “Comentário”
      SOURCE_DESCRIPTION: `${portal} (${leadOrigin})`,
      PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : undefined,
      EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : undefined,
    };

    Object.keys(leadFields).forEach((k) => leadFields[k] === undefined && delete leadFields[k]);

    let leadId = null;
    let status = "";

    if (existing?.ID) {
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
    // ✅ 5) Timeline (opcional)
    // =========================
    if (ENABLE_TIMELINE) {
      try {
        await bitrixCall("crm.timeline.comment.add", {
          fields: {
            ENTITY_TYPE: "lead",
            ENTITY_ID: leadId,
            COMMENT: timelinePretty,
          },
        });
      } catch (e) {
        console.warn("timeline.comment.add failed:", e?.message);
      }
    }

    return res.status(200).json({ status, leadId });
  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: err?.message || "Erro inesperado",
      bitrix: err?.data || null,
    });
  }
};
