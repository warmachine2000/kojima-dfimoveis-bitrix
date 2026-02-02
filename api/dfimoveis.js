// pages/api/dfimoveis.js
// Node 18+ (Vercel) - usa fetch nativo

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;

// Campo custom que você mostrou no fields:
// listLabel/formLabel: "UF_CRM_ORIGIN_URL"
const UF_CRM_ORIGIN_URL_FIELD = "UF_CRM_1763320747675";

// Nome desejado da fonte (como aparece no Bitrix)
const DEFAULT_SOURCE_NAME = "Portal DF Imóveis";

// ----------------------------------------------------

function mustEnv(name) {
  if (!process.env[name]) throw new Error(`Missing env: ${name}`);
  return process.env[name];
}

function cleanPhone(phone) {
  if (!phone) return "";
  // mantém + e números
  const p = String(phone).trim();
  // se vier sem +, ok, Bitrix aceita, mas vamos padronizar
  return p.startsWith("+") ? p : p;
}

function asOneLine(str) {
  return String(str || "").replace(/\s+/g, " ").trim();
}

function toMultifield(value, type = "WORK") {
  const v = String(value || "").trim();
  if (!v) return undefined;
  return [{ VALUE: v, VALUE_TYPE: type }];
}

async function bitrixCall(method, params = {}) {
  mustEnv("BITRIX_WEBHOOK_URL");

  // Bitrix aceita GET ou POST. Vamos usar POST com JSON para evitar limite de querystring.
  const url = `${BITRIX_WEBHOOK_URL.replace(/\/$/, "")}/${method}.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  const data = await resp.json().catch(() => ({}));

  // Bitrix costuma retornar { result, error, error_description }
  if (!resp.ok || data.error) {
    const msg = data.error_description || data.error || `HTTP_${resp.status}`;
    const err = new Error(msg);
    err.bitrix = data;
    err.httpStatus = resp.status;
    throw err;
  }

  return data.result;
}

async function getSources() {
  // Lista fontes: crm.status.list com ENTITY_ID=SOURCE
  const result = await bitrixCall("crm.status.list", {
    filter: { ENTITY_ID: "SOURCE" },
  });

  // result é array com { ID, ENTITY_ID, STATUS_ID, NAME, ... }
  return Array.isArray(result) ? result : [];
}

function buildComments({
  listingCode,
  listingUrl,
  name,
  phone,
  email,
  leadOrigin,
  message,
  technical = {},
}) {
  const lines = [];

  lines.push("*Novo contato - DF Imóveis*");
  lines.push("");

  if (listingCode) lines.push(`Código do anúncio: ${listingCode}`);
  if (listingUrl) lines.push(`Link do anúncio: ${listingUrl}`);

  if (name) lines.push(`Nome: ${name}`);
  if (phone) lines.push(`Telefone: ${phone}`);
  if (email) lines.push(`E-mail: ${email}`);

  if (leadOrigin) lines.push(`leadOrigin: ${leadOrigin}`);

  if (message) {
    lines.push("");
    lines.push("Mensagem:");
    lines.push(String(message));
  }

  // dados técnicos (se vier)
  const techKeys = Object.keys(technical || {});
  if (techKeys.length) {
    lines.push("");
    lines.push("-- Dados técnicos --");
    for (const k of techKeys) {
      const v = technical[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        lines.push(`${k}: ${v}`);
      }
    }
  }

  return lines.join("\n");
}

function textToHtml(text) {
  // timeline comment normalmente aceita HTML
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

// ----------------------------------------------------

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
    }

    if (!BITRIX_WEBHOOK_URL) {
      return res.status(500).json({ error: "MISSING_ENV", message: "BITRIX_WEBHOOK_URL não configurado" });
    }

    const mode = String(req.query.mode || "").trim().toLowerCase();

    // MODE = fields: devolve fields + sources (para você achar o SOURCE_ID certo)
    if (mode === "fields") {
      const fields = await bitrixCall("crm.lead.fields", {});
      const sources = await getSources();

      return res.status(200).json({
        ok: true,
        fields,
        sources: sources.map(s => ({
          STATUS_ID: s.STATUS_ID,
          NAME: s.NAME,
        })),
        hint: "Use o STATUS_ID correspondente ao NAME='Portal DF Imóveis' no campo SOURCE_ID.",
      });
    }

    // ---------- Entrada padrão ----------
    const name = asOneLine(req.query.name);
    const phone = cleanPhone(req.query.phone);
    const email = asOneLine(req.query.email);
    const leadOrigin = asOneLine(req.query.leadOrigin || "dfimoveis");

    // Identidade mínima
    if (!name && !phone && !email) {
      return res.status(400).json({
        error: "MISSING_IDENTITY",
        message: "Precisa de ao menos nome, e-mail ou telefone",
      });
    }

    const listingCode = asOneLine(req.query.listingCode || req.query.ddd || req.query.codigo || "");
    const listingUrl = asOneLine(req.query.listingUrl || req.query.url || "");
    const message = String(req.query.message || "").trim();

    // Você pode forçar o SOURCE_ID via query: &sourceId=XXXX
    let sourceId = asOneLine(req.query.sourceId || "");

    // Se não vier sourceId, tenta resolver automaticamente pelo nome "Portal DF Imóveis"
    if (!sourceId) {
      const sources = await getSources();
      const found = sources.find(s => String(s.NAME || "").trim().toLowerCase() === DEFAULT_SOURCE_NAME.toLowerCase());
      if (found?.STATUS_ID) sourceId = found.STATUS_ID;
    }

    // ORIGINATOR/ORIGIN_ID para dedupe
    const originLeadId = asOneLine(req.query.originLeadId || "");
    const originId =
      originLeadId ||
      `dfimoveis:${listingCode || "NAO_INFORMADO"}:${(phone || email || name || "anon").replace(/\s+/g, "").slice(0, 60)}`;

    // 1) tenta localizar lead existente pelo ORIGIN_ID/ORIGINATOR_ID
    const existing = await bitrixCall("crm.lead.list", {
      filter: {
        ORIGINATOR_ID: "dfimoveis",
        ORIGIN_ID: originId,
      },
      select: ["ID", "TITLE"],
      order: { ID: "DESC" },
      start: 0,
    });

    const codeForTitle = listingCode || "NAO_INFORMADO";
    const title = `DF Imóveis | ${codeForTitle} | ${name || "Novo Lead"}`;

    const technical = {
      timestamp: new Date().toISOString(),
      clientListingId: listingCode || "",
      originListingId: "",
      originLeadId: originLeadId || "",
    };

    const commentsPlain = buildComments({
      listingCode: codeForTitle ? `DF${codeForTitle.replace(/^DF/i, "")}`.startsWith("DF") ? `DF${codeForTitle.replace(/^DF/i, "")}` : codeForTitle : codeForTitle,
      listingUrl,
      name,
      phone,
      email,
      leadOrigin,
      message,
      technical,
    });

    let leadId;

    if (Array.isArray(existing) && existing.length > 0) {
      // atualiza lead existente
      leadId = existing[0].ID;

      const updateFields = {
        TITLE: title,
        COMMENTS: commentsPlain,
        SOURCE_DESCRIPTION: leadOrigin,
      };

      if (sourceId) updateFields.SOURCE_ID = sourceId;
      if (listingUrl) updateFields[UF_CRM_ORIGIN_URL_FIELD] = listingUrl;

      if (phone) updateFields.PHONE = toMultifield(phone);
      if (email) updateFields.EMAIL = toMultifield(email);

      await bitrixCall("crm.lead.update", {
        id: leadId,
        fields: updateFields,
      });

      // timeline comment (opcional)
      await bitrixCall("crm.timeline.comment.add", {
        fields: {
          ENTITY_TYPE_ID: 1, // Lead
          ENTITY_ID: leadId,
          COMMENT: textToHtml(commentsPlain),
        },
      });

      return res.status(200).json({
        ok: true,
        status: "LEAD_UPDATED",
        leadId,
        originId,
        sourceId: sourceId || null,
      });
    }

    // cria lead novo
    const leadFields = {
      TITLE: title,
      NAME: name || undefined,
      COMMENTS: commentsPlain,              // ✅ campo Observação (o que você queria)
      SOURCE_DESCRIPTION: leadOrigin,
      ORIGINATOR_ID: "dfimoveis",
      ORIGIN_ID: originId,
    };

    if (sourceId) leadFields.SOURCE_ID = sourceId; // ✅ Fonte correta
    if (phone) leadFields.PHONE = toMultifield(phone);
    if (email) leadFields.EMAIL = toMultifield(email);
    if (listingUrl) leadFields[UF_CRM_ORIGIN_URL_FIELD] = listingUrl; // ✅ URL no campo custom

    leadId = await bitrixCall("crm.lead.add", { fields: leadFields });

    // timeline comment (opcional, mas útil)
    await bitrixCall("crm.timeline.comment.add", {
      fields: {
        ENTITY_TYPE_ID: 1, // Lead
        ENTITY_ID: leadId,
        COMMENT: textToHtml(commentsPlain),
      },
    });

    return res.status(200).json({
      ok: true,
      status: "LEAD_CREATED",
      leadId,
      originId,
      sourceId: sourceId || null,
    });
  } catch (err) {
    const msg = err?.message || "INTERNAL_ERROR";
    const bitrixErr = err?.bitrix || null;

    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: msg,
      bitrix: bitrixErr,
    });
  }
}
