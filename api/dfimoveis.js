/**
 * Integração DF Imóveis / 62 Imóveis  → Bitrix24
 * Autor: Adriano Alves
 * Projeto: kojima-dfimoveis-bitrix
 */

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;

// Fonte DF Imóveis (ID interno da fonte que você renomeou de "E-mail")
const SOURCE_DF_IMOVEIS = "EMAIL";
const SOURCE_62_IMOVEIS = "EMAIL";

// Cache em memória (Vercel reaproveita em warm starts)
let CACHED_LEAD_FIELDS = null;
let CACHED_COMMENT_FIELD_KEY = null;

// ---------------- Helpers ----------------

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v);
}

function normalizePhone(ddd, phone) {
  const digitsDDD = (ddd || "").toString().replace(/\D/g, "");
  const digitsPhone = (phone || "").toString().replace(/\D/g, "");
  if (!digitsPhone) return null;
  if (digitsDDD) return `+55${digitsDDD}${digitsPhone}`;
  return `+55${digitsPhone}`;
}

function normalizeEmail(email) {
  const e = (email || "").toString().trim().toLowerCase();
  return e || null;
}

function stripAccents(s) {
  return (s || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function buildListingUrl(listingUrl, originListingId, clientListingId) {
  if (listingUrl) return String(listingUrl);
  const code = clientListingId || originListingId;
  if (code) return `https://www.dfimoveis.com.br/imovel/${encodeURIComponent(code)}`;
  return "";
}

function buildTimelineMessage({
  portalNome,
  leadOrigin,
  codigoImovel,
  listingUrl,
  name,
  fullPhone,
  email,
  message,
  clientListingId,
  originListingId,
  originLeadId,
  timestamp,
}) {
  const urlLine = listingUrl ? `🔗 Link do anúncio: ${listingUrl}\n` : "";

  return (
    `📩 *Novo contato - ${portalNome}*\n\n` +
    `🏷 Código do anúncio: ${codigoImovel}\n` +
    urlLine +
    `👤 Nome: ${safeStr(name) || "Não informado"}\n` +
    `📞 Telefone: ${fullPhone || "Não informado"}\n` +
    `✉️ E-mail: ${email || "Não informado"}\n` +
    `🧭 leadOrigin: ${leadOrigin || ""}\n\n` +
    `📝 Mensagem:\n${safeStr(message) || "(vazia)"}\n\n` +
    `-- Dados técnicos --\n` +
    `clientListingId: ${safeStr(clientListingId)}\n` +
    `originListingId: ${safeStr(originListingId)}\n` +
    `originLeadId: ${safeStr(originLeadId)}\n` +
    `timestamp: ${safeStr(timestamp)}\n`
  );
}

async function bitrixCall(method, params) {
  if (!BITRIX_WEBHOOK_URL) {
    throw new Error("BITRIX_WEBHOOK_URL não definido nas variáveis de ambiente");
  }

  const url = `${BITRIX_WEBHOOK_URL}/${method}.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  });

  let data = {};
  try {
    data = await resp.json();
  } catch (_) {
    data = {};
  }

  if (!resp.ok) {
    console.error(`Bitrix request FAILED [${method}]`, resp.status, data);
    throw new Error(
      `BITRIX_REQUEST_FAILED (${resp.status}) [${method}] - ${JSON.stringify(data)}`
    );
  }

  if (data && data.error) {
    throw new Error(
      `BITRIX_API_ERROR [${method}] ${data.error}: ${data.error_description || ""}`
    );
  }

  return data.result;
}

/**
 * Descobre automaticamente qual campo do LEAD tem título "Comentário".
 * Isso resolve quando o seu layout mostra um UF_* chamado "Comentário".
 */
async function resolveLeadCommentFieldKey() {
  if (CACHED_COMMENT_FIELD_KEY) return CACHED_COMMENT_FIELD_KEY;

  // Se já temos os fields em cache, usa
  if (!CACHED_LEAD_FIELDS) {
    CACHED_LEAD_FIELDS = await bitrixCall("crm.lead.fields", {});
  }

  // Tentativa 1: achar campo cujo title/FORM_LABEL seja "Comentário"
  const target = "comentario";

  for (const [key, def] of Object.entries(CACHED_LEAD_FIELDS || {})) {
    const title = stripAccents(def?.title || "").toLowerCase().trim();
    const formLabel = stripAccents(def?.formLabel || def?.form_label || "").toLowerCase().trim();
    const listLabel = stripAccents(def?.listLabel || def?.list_label || "").toLowerCase().trim();

    const joined = [title, formLabel, listLabel].filter(Boolean).join(" | ");

    if (joined.includes(target)) {
      // Preferir campos de texto
      const type = (def?.type || "").toLowerCase();
      if (type === "text" || type === "string") {
        CACHED_COMMENT_FIELD_KEY = key;
        return CACHED_COMMENT_FIELD_KEY;
      }
    }
  }

  // Tentativa 2: fallback seguro: COMMENTS (campo padrão)
  CACHED_COMMENT_FIELD_KEY = "COMMENTS";
  return CACHED_COMMENT_FIELD_KEY;
}

async function addTimelineCommentToLead(leadId, commentText) {
  return bitrixCall("crm.timeline.comment.add", {
    fields: {
      ENTITY_TYPE: "lead",
      ENTITY_ID: Number(leadId),
      COMMENT: commentText,
    },
  });
}

async function findDuplicate(phone, email) {
  const duplicates = { PHONE: null, EMAIL: null };

  if (phone) {
    try {
      duplicates.PHONE = await bitrixCall("crm.duplicate.findbycomm", {
        type: "PHONE",
        values: [phone],
      });
    } catch (e) {
      console.warn("Erro duplicidade telefone:", e.message);
    }
  }

  if (email) {
    try {
      duplicates.EMAIL = await bitrixCall("crm.duplicate.findbycomm", {
        type: "EMAIL",
        values: [email],
      });
    } catch (e) {
      console.warn("Erro duplicidade email:", e.message);
    }
  }

  return duplicates;
}

function pickLeadIdFromDuplicates(duplicates) {
  const leadFromPhone = duplicates?.PHONE?.LEAD?.[0];
  const leadFromEmail = duplicates?.EMAIL?.LEAD?.[0];
  return leadFromPhone || leadFromEmail || null;
}

// ---------------- Handler ----------------

module.exports = async (req, res) => {
  try {
    // CORS básico
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Payload
    let payload = {};
    if (req.method === "GET") {
      payload = req.query || {};
    } else {
      if (!req.body) {
        payload = req.query || {};
      } else if (typeof req.body === "string") {
        payload = JSON.parse(req.body);
      } else {
        payload = req.body;
      }
    }

    const {
      clientListingId,
      name,
      email,
      ddd,
      phone,
      message,
      leadOrigin,
      timestamp,
      originLeadId,
      originListingId,
      listingUrl,
    } = payload;

    if (!name && !email && !phone) {
      return res.status(400).json({
        error: "MISSING_IDENTITY",
        message: "Precisa de ao menos nome, e-mail ou telefone",
      });
    }

    const originLower = (leadOrigin || "").toString().toLowerCase();
    const is62Imoveis = originLower === "62imoveis";

    let portalNome = "DF Imóveis";
    let sourceId = SOURCE_DF_IMOVEIS;
    let portalOrigemUF = "DF_IMOVEIS";

    if (is62Imoveis) {
      portalNome = "62 Imóveis";
      sourceId = SOURCE_62_IMOVEIS;
      portalOrigemUF = "62_IMOVEIS";
    }

    const fullPhone = normalizePhone(ddd, phone);
    const emailNorm = normalizeEmail(email);

    const codigoImovel = clientListingId || originListingId || "NAO_INFORMADO";
    const anuncioUrl = buildListingUrl(listingUrl, originListingId, clientListingId);

    const commentText = buildTimelineMessage({
      portalNome,
      leadOrigin,
      codigoImovel,
      listingUrl: anuncioUrl,
      name,
      fullPhone,
      email: emailNorm,
      message,
      clientListingId,
      originListingId,
      originLeadId,
      timestamp,
    });

    // Descobre campo real "Comentário" do seu layout
    const commentFieldKey = await resolveLeadCommentFieldKey();

    // Duplicidade
    const duplicates = await findDuplicate(fullPhone, emailNorm);
    const duplicatedLeadId = pickLeadIdFromDuplicates(duplicates);

    if (duplicatedLeadId) {
      // ✅ 1) Timeline
      await addTimelineCommentToLead(duplicatedLeadId, commentText);

      // ✅ 2) Campo do formulário (o que você chamou de "campo correto")
      // atualiza o lead duplicado com o comentário também
      await bitrixCall("crm.lead.update", {
        id: Number(duplicatedLeadId),
        fields: {
          [commentFieldKey]: commentText,
          COMMENTS: commentText, // mantém também o padrão
        },
      });

      return res.json({
        status: "DUPLICATE_UPDATED_WITH_COMMENT",
        leadId: duplicatedLeadId,
        commentFieldKey,
      });
    }

    // Novo Lead
    const leadFields = {
      TITLE: `${portalNome} | ${codigoImovel} | ${name || "Sem nome"}`,
      NAME: name || "Contato Portal",
      SOURCE_ID: sourceId,
      SOURCE_DESCRIPTION: `Lead vindo do portal ${portalNome}`,

      // ✅ Preenche os dois: campo padrão + campo do seu layout
      COMMENTS: commentText,
      [commentFieldKey]: commentText,

      // ⚠️ Esses UF_* só mantenha se existirem no seu Bitrix.
      // Se não existirem, comente essas linhas.
      UF_CODIGO_IMOVEL: codigoImovel,
      UF_PORTAL_ORIGEM: portalOrigemUF,
      UF_DFIMOVEIS_ORIGIN_LEAD_ID: originLeadId || "",
      UF_DFIMOVEIS_ORIGIN_LISTING_ID: originListingId || "",
    };

    if (fullPhone) leadFields.PHONE = [{ VALUE: fullPhone, VALUE_TYPE: "WORK" }];
    if (emailNorm) leadFields.EMAIL = [{ VALUE: emailNorm, VALUE_TYPE: "WORK" }];

    const leadId = await bitrixCall("crm.lead.add", { fields: leadFields });

    // ✅ Garantir timeline também
    await addTimelineCommentToLead(leadId, commentText);

    return res.json({
      status: "LEAD_CREATED",
      leadId,
      commentFieldKey,
    });
  } catch (err) {
    console.error("ERRO GERAL /api/dfimoveis:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: err.message,
    });
  }
};
