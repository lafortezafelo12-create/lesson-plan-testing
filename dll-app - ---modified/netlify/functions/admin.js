// netlify/functions/admin.js
// Lets an admin update the Gemini API key without redeploying the site.
// The password check happens here, server-side, against the ADMIN_PASSWORD
// environment variable — it is never present in any frontend file, so it's
// safe even though this repo may be public on GitHub.
//
// The key itself is stored in Netlify Blobs (not in a file, not in git),
// and generate.js checks this store first before falling back to the
// GEMINI_API_KEY environment variable.

const { connectLambda, getStore } = require("@netlify/blobs");

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
    let hasOverride = false;
    let preview = null;
    try {
      const current = await store.get("gemini_api_key");
      if (current && current.trim()) {
        hasOverride = true;
        preview = `••••${current.trim().slice(-4)}`;
      }
    } catch {
      /* no override set */
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ hasOverride, preview, usingEnvFallback: !hasOverride }),
    };
  }

  if (action === "clear") {
    await store.delete("gemini_api_key");
    return { statusCode: 200, body: JSON.stringify({ success: true, cleared: true }) };
  }

  if (action === "set") {
    if (!apiKey || apiKey.trim().length < 10) {
      return { statusCode: 400, body: JSON.stringify({ error: "That doesn't look like a valid API key." }) };
    }
    await store.set("gemini_api_key", apiKey.trim());
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: "Unknown action. Use 'status', 'set', or 'clear'." }) };
};
