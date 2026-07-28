// netlify/functions/admin.js
// Lets an admin update the Gemini API key(s) without redeploying the site.
// The password check happens here, server-side, against the ADMIN_PASSWORD
// environment variable — it is never present in any frontend file, so it's
// safe even though this repo may be public on GitHub.
//
// The key(s) are stored in Netlify Blobs (not in a file, not in git), as a
// single comma-separated string, and generate.js checks this store first
// before falling back to the GEMINI_API_KEY environment variable. Multiple
// keys enable automatic failover in generate.js if one key is invalid,
// rate-limited, or out of quota.

const { connectLambda, getStore } = require("@netlify/blobs");

// Parses a comma-separated string of keys into a clean array (trims
// whitespace, drops empty entries, de-dupes while preserving order).
function parseKeyList(raw) {
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  raw.split(",").forEach((k) => {
    const key = k.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  });
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "ADMIN_PASSWORD is not set on the server. Add it in Netlify's environment variables.",
      }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { password, action, apiKey } = body;

  if (password !== adminPassword) {
    // Deliberately vague — don't confirm/deny which part was wrong.
    return { statusCode: 401, body: JSON.stringify({ error: "Incorrect password." }) };
  }

  connectLambda(event);
  const store = getStore({ name: "ilaw-settings" });

  if (action === "status") {
    let keys = [];
    try {
      const current = await store.get("gemini_api_key");
      keys = parseKeyList(current);
    } catch {
      /* no override set */
    }
    const hasOverride = keys.length > 0;
    return {
      statusCode: 200,
      body: JSON.stringify({
        hasOverride,
        keyCount: keys.length,
        previews: keys.map((k) => `••••${k.slice(-4)}`),
        usingEnvFallback: !hasOverride,
      }),
    };
  }

  if (action === "clear") {
    await store.delete("gemini_api_key");
    return { statusCode: 200, body: JSON.stringify({ success: true, cleared: true }) };
  }

  if (action === "set") {
    const keys = parseKeyList(apiKey);
    if (!keys.length) {
      return { statusCode: 400, body: JSON.stringify({ error: "Enter at least one API key." }) };
    }
    const tooShort = keys.find((k) => k.length < 10);
    if (tooShort) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `"${tooShort.slice(0, 6)}…" doesn't look like a valid API key.` }),
      };
    }
    await store.set("gemini_api_key", keys.join(","));
    return { statusCode: 200, body: JSON.stringify({ success: true, keyCount: keys.length }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: "Unknown action. Use 'status', 'set', or 'clear'." }) };
};
