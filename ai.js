"use strict";
// NØVA - Gemini powered chat brain for the Enderlørd AFK bot.
// The API key is read from the GEMINI_API_KEY environment variable (never stored in settings.json).

// tiny .env loader (no extra dependency)
try {
  const fs = require("fs");
  const p = require("path").join(__dirname, ".env");
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch (_) {}

const MAX_HISTORY = 6; // messages remembered per player
const history = new Map(); // player -> [{role, text}]
const lastCall = new Map(); // player -> timestamp

function getKey() {
  return process.env.GEMINI_API_KEY || "";
}

function clean(text, maxLen) {
  return String(text || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/§./g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

async function askNØVA(player, message, cfg, log) {
  const key = getKey();
  if (!key) {
    log("[AI] GEMINI_API_KEY not set - AI chat disabled");
    return null;
  }

  const now = Date.now();
  const cooldown = (cfg.cooldownSeconds || 5) * 1000;
  if (now - (lastCall.get(player) || 0) < cooldown) return null;
  lastCall.set(player, now);

  const h = history.get(player) || [];
  h.push({ role: "user", text: message });

  const body = {
    systemInstruction: { parts: [{ text: cfg.persona }] },
    contents: h.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    generationConfig: { maxOutputTokens: 200, temperature: 0.8 },
  };

  const model = cfg.model || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);

    if (!res.ok) {
      log(`[AI] Gemini error ${res.status}: ${clean(await res.text(), 150)}`);
      h.pop();
      return null;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join(" ");
    const reply = clean(text, cfg.maxReplyLength || 220);
    if (!reply) {
      h.pop();
      return null;
    }
    h.push({ role: "model", text: reply });
    while (h.length > MAX_HISTORY) h.shift();
    history.set(player, h);
    return reply;
  } catch (e) {
    log(`[AI] Request failed: ${e.message}`);
    h.pop();
    return null;
  }
}

module.exports = { askNØVA, clean };
