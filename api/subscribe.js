import { createHash } from "crypto";

const META_PIXEL_ID = process.env.META_PIXEL_ID || "1341206988086014";

function sha256Email(email) {
  return createHash("sha256")
    .update(String(email).trim().toLowerCase())
    .digest("hex");
}

function cookieValue(cookieHeader, name) {
  if (!cookieHeader) return undefined;
  const parts = String(cookieHeader).split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1).trim() || undefined;
  }
  return undefined;
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  if (Array.isArray(xff) && xff[0]) return String(xff[0]).split(",")[0].trim();
  const realIp = req.headers["x-real-ip"];
  if (realIp) return String(realIp).trim();
  return undefined;
}

function adsConsentGranted(body, req) {
  const fromBody = String(body.ads_consent || "").trim().toLowerCase();
  if (fromBody === "granted") return true;
  if (fromBody === "denied") return false;
  return cookieValue(req.headers.cookie || "", "doseiq_ads_consent") === "granted";
}

async function sendMetaCapiLeadEvents(req, { email, eventId, eventSourceUrl }) {
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  if (!token) {
    console.log("meta_capi_skip no_token");
    return;
  }
  const em = sha256Email(email);
  if (!em) return;

  const ua = String(req.headers["user-agent"] || "").trim() || undefined;
  const ip = clientIp(req);
  const cookies = req.headers.cookie || "";
  const fbp = cookieValue(cookies, "_fbp");
  const fbc = cookieValue(cookies, "_fbc");
  const sourceUrl =
    (eventSourceUrl && String(eventSourceUrl).trim()) ||
    String(req.headers.referer || req.headers.referrer || "").trim() ||
    undefined;

  const userData = { em: [em] };
  if (ip) userData.client_ip_address = ip;
  if (ua) userData.client_user_agent = ua;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const now = Math.floor(Date.now() / 1000);
  const eid = eventId && String(eventId).trim() ? String(eventId).trim() : undefined;

  function makeEvent(eventName) {
    const ev = {
      event_name: eventName,
      event_time: now,
      action_source: "website",
      user_data: { ...userData },
    };
    if (eid) ev.event_id = eid;
    if (sourceUrl) ev.event_source_url = sourceUrl;
    return ev;
  }

  const body = {
    data: [makeEvent("Lead"), makeEvent("CompleteRegistration")],
  };

  const url =
    "https://graph.facebook.com/v21.0/" +
    encodeURIComponent(META_PIXEL_ID) +
    "/events?access_token=" +
    encodeURIComponent(token);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    console.log("meta_capi_status", r.status);
  } catch (e) {
    console.log("meta_capi_error", e && e.name ? e.name : "fetch_failed");
  }
}

export default async function handler(req, res) {
  const allowed = new Set([
    "https://www.dose-iq.com",
    "https://dose-iq.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]);
  const origin = String(req.headers.origin || "");
  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false });
  }

  const body =
    typeof req.body === "string"
      ? (() => {
          try {
            return JSON.parse(req.body);
          } catch {
            return {};
          }
        })()
      : req.body || {};

  const email = String(body.email || "").trim();
  const consent = String(body.privacy_consent || "").trim();
  const country = String(body.country || "").trim().toUpperCase().slice(0, 8);
  const lang = String(body.lang || "").trim().toLowerCase();
  const eventId = String(body.event_id || "").trim();
  const eventSourceUrl = String(body.event_source_url || "").trim();
  const shouldCapi = adsConsentGranted(body, req);

  // Route by selected country (matches Bioniq shop + email language).
  // NL → Dutch Brand list; everything else with a live EN sequence → EN list.
  const EN_LIST = "7PWiy"; // Dose IQ Brand .com
  const NL_LIST = "7PKcF"; // Dose IQ Brand .com NL
  let campaignId = EN_LIST;
  if (country === "NL" || (!country && lang === "nl")) {
    campaignId = NL_LIST;
  }

  if (!email || !email.includes("@") || consent !== "yes") {
    return res.status(400).json({ ok: false });
  }

  const apiKey = process.env.GETRESPONSE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false });
  }

  const payload = {
    email,
    campaign: { campaignId },
    dayOfCycle: "0", // start autoresponder cycle immediately (email 1 = day 0)
  };
  if (country && country !== "OTHER") {
    payload.customFieldValues = [
      { customFieldId: "ntL087", value: [country] },
    ];
  }

  async function fireCapi() {
    if (!shouldCapi) return;
    try {
      await sendMetaCapiLeadEvents(req, {
        email,
        eventId,
        eventSourceUrl,
      });
    } catch (_) {
      // never fail subscribe on CAPI errors
    }
  }

  try {
    const gr = await fetch("https://api.getresponse.com/v3/contacts", {
      method: "POST",
      headers: {
        "X-Auth-Token": "api-key " + apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (gr.status === 202 || gr.status === 200 || gr.status === 409) {
      await fireCapi();
      return res.status(200).json({
        ok: true,
        campaignId,
        lang: campaignId === NL_LIST ? "nl" : "en",
        country: country || null,
      });
    }

    const text = await gr.text();
    if (gr.status === 400 && /already|exists|duplicate/i.test(text)) {
      await fireCapi();
      return res.status(200).json({
        ok: true,
        campaignId,
        lang: campaignId === NL_LIST ? "nl" : "en",
        country: country || null,
      });
    }

    return res.status(502).json({ ok: false });
  } catch {
    return res.status(502).json({ ok: false });
  }
}
