/**
 * Integração DF Imóveis / 62 Imóveis  → Bitrix24
 * Autor: Adriano Alves
 * Projeto: kojima-dfimoveis-bitrix
 */

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || null;

const BITRIX_RESPONSIBLE_ID = process.env.BITRIX_RESPONSIBLE_ID
  ? Number(process.env.BITRIX_RESPONSIBLE_ID)
  : null;

const SOURCE_DF_IMOVEIS = "EMAIL";
const SOURCE_62_IMOVEIS = "EMAIL";

function normalizePhone(ddd, phone) {
  const digitsDDD = (ddd || "").toString().replace(/\D/g, "");
  const digitsPhone = (phone || "").toString().replace(/\D/g, "");

  if (!digitsPhone) return null;

  if (digitsDDD) {
    return `+55${digitsDDD}${digitsPhone}`;
  }
  return `+55${digitsPhone}`;
}

async function bitrixCall(method, params) {
  if (!BITRIX_WEBHOOK_URL) {
    throw new Error("BITRIX_WEBHOOK_URL não definido");
  }

  const url = `${BITRIX_WEBHOOK_URL}/${method}.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  let data = {};
  try {
    data = await resp.json();
  } catch (_) {}

  if (!resp.ok) {
    throw new Error(`BITRIX_REQUEST_FAILED (${resp.status})`);
  }

  if (data.error) {
    throw new Error(`BITRIX_API_ERROR ${data.error}`);
  }

  return data.result;
}

async function findDuplicate(phone, email) {
  const duplicates = { PHONE: null, EMAIL: null };

  if (phone) {
    duplicates.PHONE = await bitrixCall("crm.duplicate.findbycomm", {
      type: "PHONE",
      values: [phone],
    });
  }

  if (email) {
    duplicates.EMAIL = await bitrixCall("crm.duplicate.findbycomm", {
      type: "EMAIL",
      values: [email],
    });
  }

  return duplicates;
}

function hasLeadDuplicate(duplicates) {
  const leadIdsPhone = duplicates?.PHONE?.LEAD || [];
  const leadIdsEmail = duplicates?.EMAIL?.LEAD || [];
  return leadIdsPhone.length > 0 || leadIdsEmail.length > 0;
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    if (WEBHOOK_TOKEN) {
      const rawHeader = req.headers["authorization"] || "";
      const received = rawHeader.replace(/^Bearer\s+/i, "").trim();
      const expected = WEBHOOK_TOKEN.trim();

      if (!received || received !== expected) {
        return res.status(401).json({ error: "INVALID_TOKEN" });
      }
    }

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
    } = payload;

    if (!name && !email && !phone) {
      return res.status(400).json({
        error: "MISSING_IDENTITY"
      });
    }

    const originLower = (leadOrigin || "").toLowerCase();
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
    const codigoImovel =
      clientListingId || originListingId || "NAO_INFORMADO";

    const duplicates = await findDuplicate(fullPhone, email);
    const isDuplicate = hasLeadDuplicate(duplicates);

    let leadId = null;

    if (isDuplicate) {
      leadId =
        duplicates.PHONE?.LEAD?.[0] ||
        duplicates.EMAIL?.LEAD?.[0];

      const activityFields = {
        OWNER_ID: leadId,
        OWNER_TYPE_ID: 1,
        TYPE_ID: 4,
        SUBJECT: `Novo contato ${portalNome} (duplicado) - ${codigoImovel}`,
        DESCRIPTION: `
Portal: ${portalNome}
Mensagem: ${message || ""}
Telefone: ${fullPhone || ""}
E-mail: ${email || ""}
clientListingId: ${clientListingId || ""}
originListingId: ${originListingId || ""}
originLeadId: ${originLeadId || ""}
timestamp: ${timestamp || ""}
`,
        COMPLETED: "N",
      };

      if (BITRIX_RESPONSIBLE_ID) {
        activityFields.RESPONSIBLE_ID = BITRIX_RESPONSIBLE_ID;
      }

      await bitrixCall("crm.activity.add", {
        fields: activityFields,
      });

      return res.json({
        status: "DUPLICATE_ACTIVITY_CREATED",
        leadId,
      });
    }

    const leadFields = {
      TITLE: `${portalNome} | ${codigoImovel} | ${name || "Sem nome"}`,
      NAME: name || "Contato Portal",
      SOURCE_ID: sourceId,
      SOURCE_DESCRIPTION: `Lead vindo do portal ${portalNome}`,
      COMMENTS: `
Portal: ${portalNome}
Mensagem: ${message || ""}
clientListingId: ${clientListingId || ""}
originListingId: ${originListingId || ""}
originLeadId: ${originLeadId || ""}
timestamp: ${timestamp || ""}
`,
      UF_CODIGO_IMOVEL: codigoImovel,
      UF_PORTAL_ORIGEM: portalOrigemUF,
      UF_DFIMOVEIS_ORIGIN_LEAD_ID: originLeadId || "",
      UF_DFIMOVEIS_ORIGIN_LISTING_ID: originListingId || "",
    };

    if (fullPhone) {
      leadFields.PHONE = [
        { VALUE: fullPhone, VALUE_TYPE: "WORK" }
      ];
    }

    if (email) {
      leadFields.EMAIL = [
        { VALUE: email, VALUE_TYPE: "WORK" }
      ];
    }

    if (BITRIX_RESPONSIBLE_ID) {
      leadFields.RESPONSIBLE_ID = BITRIX_RESPONSIBLE_ID;
    }

    leadId = await bitrixCall("crm.lead.add", {
      fields: leadFields,
    });

    return res.json({
      status: "LEAD_CREATED",
      leadId,
    });
  } catch (err) {
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: err.message,
    });
  }
};
