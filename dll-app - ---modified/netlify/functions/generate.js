// netlify/functions/generate.js
// Calls the Gemini API server-side so the API key never reaches the browser.
//
// API key resolution order:
//   1. An override key saved via the admin panel (stored in Netlify Blobs)
//   2. The GEMINI_API_KEY environment variable set in Netlify
//
// Model resolution: the frontend sends a short "model key" (flash / pro /
// flash-lite) rather than a raw model ID, so if Google renames a model this
// map is the only place that needs to change.
const { connectLambda, getStore } = require("@netlify/blobs");

// Each entry maps the frontend's short model key to the real Gemini model ID,
// plus an optional thinkingLevel override and an optional "fallback" model
// key. If a model fails outright (after exhausting its own key retries),
// the handler follows "fallback" to the next model, and so on — a real
// chain, capped at a couple of hops to bound worst-case latency (see
// MAX_FALLBACK_HOPS in the handler below). Gemini 3.x models default to
// "high" thinking when unspecified (Flash-Lite is the one exception, which
// defaults to "minimal") — "high" can add significant latency on complex,
// heavily-structured prompts like a Detailed multi-day lesson, enough to
// exceed Netlify's fixed 60-second function timeout. Flash is pinned to
// "low" to keep it fast when it is used; Pro is deliberately left at its
// default (slower, deeper reasoning) since that's the whole point of
// offering it as the "higher quality, slower" option. Flash-Lite is the
// default, everyday model (fastest, most reliable). It has NO fallback:
// Pro preview models typically have little or no quota on free/low tiers, so
// falling back to one just produced a second, misleading 429 that hid the
// real failure. Pro is only used when the teacher explicitly selects it.
const MODEL_MAP = {
  flash: { id: "gemini-3.5-flash", thinkingLevel: "low", fallback: "flash-lite" },
  pro: { id: "gemini-3.1-pro-preview" },
  "flash-lite": { id: "gemini-3.1-flash-lite" },
};
const DEFAULT_MODEL_KEY = "flash-lite";

// Each lesson-design pattern is expressed as an ordered list of phases.
// The model is told to structure the "flow" field using exactly these
// phases, in this order, one bold heading line per phase.
const DESIGN_PATTERNS = {
  "5Es": {
    label: "5Es",
    phases: ["Engage", "Explore", "Explain", "Elaborate", "Evaluate"],
  },
  "6Es": {
    label: "6Es",
    phases: ["Engage", "Explore", "Explain", "Elaborate", "Extend", "Evaluate"],
  },
  "7Es": {
    label: "7Es",
    phases: ["Elicit", "Engage", "Explore", "Explain", "Elaborate", "Evaluate", "Extend"],
  },
  experiential: {
    label: "Experiential Learning (Kolb's Cycle)",
    phases: [
      "Concrete Experience",
      "Reflective Observation",
      "Abstract Conceptualization",
      "Active Experimentation",
    ],
  },
  inquiry: {
    label: "Inquiry-Based Learning",
    phases: ["Ask / Wonder", "Investigate", "Create", "Discuss", "Reflect"],
  },
  constructivist: {
    label: "Constructivist Approach",
    phases: [
      "Activate Prior Knowledge",
      "Explore & Construct Meaning",
      "Explain & Represent Understanding",
      "Apply to New Situations",
      "Reflect & Self-Assess",
    ],
  },
  explicit: {
    label: "Explicit Instruction",
    phases: [
      "Review & State Objective",
      "Model (I Do)",
      "Guided Practice (We Do)",
      "Independent Practice (You Do)",
      "Closure & Check for Understanding",
    ],
  },
  cooperative: {
    label: "Cooperative Learning",
    phases: [
      "Form Teams & Set Roles",
      "Introduce Task & Positive Interdependence",
      "Collaborative Work & Peer Teaching",
      "Group Processing & Reflection",
      "Individual Accountability Check",
    ],
  },
  problemBased: {
    label: "Problem-Based Learning",
    phases: [
      "Present the Problem",
      "Analyze What's Known / What's Needed",
      "Investigate & Gather Information",
      "Develop & Test a Solution",
      "Present Solutions & Debrief",
    ],
  },
  discovery: {
    label: "Discovery Learning",
    phases: [
      "Present a Puzzling Situation",
      "Explore & Manipulate Materials",
      "Formulate Own Ideas",
      "Test & Verify Ideas",
      "Draw Conclusions & Generalize",
    ],
  },
};
const DEFAULT_DESIGN_PATTERN = "5Es";

// When the frontend sends "random" (or omits designPattern in auto-vary
// mode), pick one pattern per generation so repeated lessons don't all end
// up shaped the same way. The choice stays fixed for the whole multi-day
// lesson so the day-to-day flow stays coherent.
function pickDesignPattern(requested) {
  if (requested && requested !== "random" && DESIGN_PATTERNS[requested]) {
    return DESIGN_PATTERNS[requested];
  }
  const keys = Object.keys(DESIGN_PATTERNS);
  const randomKey = keys[Math.floor(Math.random() * keys.length)];
  return DESIGN_PATTERNS[randomKey];
}

// Deterministic language decision — NOT left to the model. If left as a
// classification task inside the prompt, the heavy Philippine/Filipino
// cultural framing elsewhere in the prompt (barangay, adobo, ₱, "Filipino
// learner," etc.) can bias the model toward Filipino even for an English
// topic. Deciding it here and stating it as a fact removes that failure mode.
const FILIPINO_MARKERS = [
  // core function words (safe — no overlap with common English words)
  "ang", "mga", "ng", "nang", "hindi", "opo", "oo", "ito", "iyon", "iyan",
  "yung", "yun", "paano", "bakit", "tungkol", "kasi", "talaga", "kailangan",
  "gusto", "dapat", "wala", "meron", "mayroon", "pati", "kapag", "habang",
  "bago", "pagkatapos", "katulad", "paraan", "alamin", "matuto", "aralin",
  "kabanata", "bahagi", "gawain", "pagsusulit", "guro", "mag-aaral", "paksa",
  "wika", "pangungusap", "pandiwa", "panghalip", "pangngalan", "kuwento", "kwento",
  // Filipino / language-arts vocabulary
  "pagbasa", "pag-unawa", "pagunawa", "panitikan", "gramatika", "pagsulat",
  "pagsasalita", "pakikinig", "tula", "dula", "alamat", "epiko", "sanaysay",
  "talumpati", "editoryal", "balita", "salita", "kayarian", "pang-uri",
  "panguri", "pang-abay", "pangabay", "pang-ukol", "pangukol", "pangatnig",
  // general academic vocabulary common across subjects
  "kabuuan", "katangian", "kahalagahan", "epekto", "sanhi", "bunga",
  "pagkakaiba", "pagkakatulad", "kaugnayan", "pagsasanay", "pagsusuri",
  "pagpapahalaga", "kasanayan", "pamamaraan", "bilang", "dagdag", "bawas",
  "dami", "sukat", "hugis", "kulay",
  // Science
  "hayop", "halaman", "katawan", "kalusugan", "kapaligiran", "kalikasan",
  "panahon", "klima", "lupa", "tubig", "hangin", "apoy", "enerhiya",
  "puwersa", "paggalaw",
  // Araling Panlipunan / social studies
  "pamumuhay", "kabuhayan", "ekonomiya", "pamahalaan", "karapatan",
  "tungkulin", "kasaysayan", "kultura", "tradisyon", "kapayapaan", "digmaan",
  "bayani", "bansa", "mundo", "daigdig", "karagatan", "bundok", "ilog",
  "lawa", "dagat", "kagubatan",
  // Math
  "bilangan", "pagdaragdag", "pagbabawas", "pagpaparami", "paghahati",
];
function detectOutputLanguage(...texts) {
  const combined = texts.filter(Boolean).join(" ").toLowerCase();
  const hasFilipinoMarker = FILIPINO_MARKERS.some((word) =>
    new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, "i").test(combined)
  );
  return hasFilipinoMarker ? "Filipino" : "English";
}
const ASSESSMENT_INSTRUCTIONS = {
  mc: (n) =>
    `**Multiple Choice Test ({n} items):** exactly ${n} questions, each as ONE bullet line in the ` +
    `format "- 1. <question stem> | A. <choice> B. <choice> C. <choice> D. <choice> | Answer: <letter>". ` +
    `Keep the whole question on a single line (do not split choices onto new lines).`,
  exitTicket:
    `**Exit Ticket:** 1-2 bullet lines with a short question or prompt learners answer on a slip of ` +
    `paper before leaving class.`,
  trueFalse:
    `**True or False:** 4-5 bullet lines, each a statement ending with "(Answer: True)" or "(Answer: False)".`,
  identification:
    `**Identification / Short Answer:** 4-5 bullet lines, each a short-answer prompt or item to identify, ` +
    `with the answer in parentheses at the end.`,
  oral:
    `**Oral Questioning:** 3-4 bullet lines of guide questions the teacher can ask learners directly.`,
  performanceTask:
    `**Performance Task (Rubric-based):** 1 bullet line describing the task, followed by 3 bullet lines ` +
    `for a simple 3-level rubric (Excellent / Satisfactory / Needs Improvement).`,
  thinkPairShare:
    `**Think-Pair-Share:** 1 bullet line with the discussion prompt, followed by 2-3 bullet lines for the ` +
    `Think / Pair / Share steps.`,
};

function buildAssessmentInstructions(assessmentTypes, mcItemCount, otherAssessment) {
  const types = Array.isArray(assessmentTypes) && assessmentTypes.length ? assessmentTypes : ["exitTicket"];
  const lines = [];
  types.forEach((t) => {
    if (t === "mc") {
      lines.push(ASSESSMENT_INSTRUCTIONS.mc(mcItemCount).replace("{n}", mcItemCount));
    } else if (t === "other") {
      const label = otherAssessment && otherAssessment.trim() ? otherAssessment.trim() : "a suitable custom assessment";
      lines.push(
        `**${label}:** design a short formative assessment activity matching this description, written as 2-3 bullet lines.`
      );
    } else if (ASSESSMENT_INSTRUCTIONS[t]) {
      lines.push(ASSESSMENT_INSTRUCTIONS[t]);
    }
  });
  return lines.join("\n");
}

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

// Returns an ordered array of Gemini API keys to try. The admin override (if
// set) takes priority and completely replaces the env var list — same
// mutual-exclusivity as before, just each side can now hold multiple
// comma-separated keys instead of exactly one.
async function resolveApiKeys(event) {
  try {
    connectLambda(event);
    const store = getStore({ name: "ilaw-settings" });
    const override = await store.get("gemini_api_key");
    const overrideKeys = parseKeyList(override);
    if (overrideKeys.length) return overrideKeys;
  } catch {
    // Blobs not available (e.g. very old local setup) — fall back silently.
  }
  return parseKeyList(process.env.GEMINI_API_KEY);
}

// HTTP statuses that mean "this specific key is the problem" (invalid key,
// no permission, rate-limited/out of quota) — worth retrying with the next
// key. Any other status (e.g. a malformed request, or a genuine Gemini-side
// 500) will fail identically no matter which key is used, so there's no
// point burning the rest of Netlify's 60-second budget cycling through keys
// for those — fail fast instead.
// Key-specific problems (invalid key, no permission, rate-limited/quota) —
// move to the next key immediately, no point waiting on the same one.
const KEY_ROTATION_STATUSES = new Set([400, 401, 403, 429]);

// Transient, model-side problems (e.g. "model is currently experiencing high
// demand") — a different key won't help since it's the same overloaded
// model either way, but a short wait-and-retry often does, since these are
// usually brief capacity spikes. Retried on the SAME key first (with
// backoff) before moving on to the next key.
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
const RETRY_BACKOFF_MS = [1000, 2000]; // up to 2 extra attempts per key

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Max time we are willing to wait out a per-minute rate limit (429) on the
// same key before giving up on it. Netlify's function limit is 60s total, so
// this must stay small (a long wait can push the whole request past the
// function timeout and return an HTML error page instead of JSON).
const MAX_RATE_LIMIT_WAIT_MS = 5000;

// Reads Gemini's suggested wait from a 429 body: either the structured
// "retryDelay": "12s" field or the "Please retry in 12.3s" message text.
// Returns milliseconds, or null if none is given (e.g. daily quota exhausted).
function parseRetryDelayMs(errText) {
  try {
    const body = JSON.parse(errText);
    const details = body?.error?.details || [];
    for (const d of details) {
      if (d && typeof d.retryDelay === "string") {
        const m = d.retryDelay.match(/([\d.]+)s/);
        if (m) return Math.ceil(parseFloat(m[1]) * 1000);
      }
    }
  } catch {
    // not JSON — fall through to the text match below
  }
  const m = String(errText).match(/retry in ([\d.]+)s/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

async function callGeminiWithFailover(modelUrlBase, body, apiKeys) {
  let lastFailure = null;
  let totalAttempts = 0;
  for (let i = 0; i < apiKeys.length; i++) {
    const key = apiKeys[i];
    let rateLimitRetried = false;
    for (let retry = 0; retry <= RETRY_BACKOFF_MS.length; retry++) {
      totalAttempts++;
      let resp;
      try {
        resp = await fetch(`${modelUrlBase}?key=${key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (networkErr) {
        lastFailure = { status: null, errText: String(networkErr), attempts: totalAttempts };
        break; // network hiccup — move on to the next key
      }
      if (resp.ok) {
        return { ok: true, resp, attempts: totalAttempts };
      }
      const errText = await resp.text();
      lastFailure = { status: resp.status, errText, attempts: totalAttempts };

      // Per-minute rate limit: if Gemini says to retry shortly, wait once and
      // retry the SAME key before rotating/failing. Long or unspecified
      // delays (e.g. daily quota) skip this and move on immediately.
      if (resp.status === 429 && !rateLimitRetried) {
        const waitMs = parseRetryDelayMs(errText);
        if (waitMs !== null && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
          rateLimitRetried = true;
          await sleep(waitMs + 250);
          continue;
        }
      }
      if (RETRYABLE_STATUSES.has(resp.status) && retry < RETRY_BACKOFF_MS.length) {
        await sleep(RETRY_BACKOFF_MS[retry]);
        continue; // brief wait, then retry the same key
      }
      if (KEY_ROTATION_STATUSES.has(resp.status) || RETRYABLE_STATUSES.has(resp.status)) {
        break; // move on to the next key, if any remain
      }
      // Anything else fails identically on every key — stop immediately
      // instead of burning the rest of the time budget.
      return { ok: false, ...lastFailure };
    }
  }
  return { ok: false, ...lastFailure };
}

// Runs a full generation attempt (with key failover/retry already handled
// by callGeminiWithFailover) against one specific model, and validates that
// it returned parseable JSON. Used for both the primary model and, if that
// fails outright, a configured fallback model — see MODEL_MAP's "fallback"
// field and where this is called from the handler below.
async function generateForModel(modelKey, prompt, apiKeys) {
  const modelConfig = MODEL_MAP[modelKey];
  const generationConfig = {
    responseMimeType: "application/json",
    // Gemini 3.x models support up to 65,536 output tokens, but the API
    // silently defaults to just 8,192 if this isn't set explicitly — easily
    // exceeded by a Detailed, multi-day lesson plan, which then gets cut off
    // mid-JSON and fails to parse. Set to the model's max to remove that
    // ceiling entirely.
    maxOutputTokens: 65536,
    // No "temperature" override: Gemini 3.x models are tuned for their
    // default of 1.0, and Google's own docs warn that lowering it can cause
    // looping or degraded performance on complex, highly-structured tasks
    // like this one.
  };
  if (modelConfig.thinkingLevel) {
    generationConfig.thinkingConfig = { thinkingLevel: modelConfig.thinkingLevel };
  }

  const modelUrlBase = `https://generativelanguage.googleapis.com/v1beta/models/${modelConfig.id}:generateContent`;
  const result = await callGeminiWithFailover(
    modelUrlBase,
    { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig },
    apiKeys
  );

  if (!result.ok) {
    return { ok: false, modelKey, modelId: modelConfig.id, kind: "api", ...result };
  }

  const data = await result.resp.json();
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text || "").join("") || "";

  // Defensive parse: try the raw text first (expected, since
  // responseMimeType is set to application/json), then fall back to
  // stripping a stray ```json ... ``` fence in case a model wraps it anyway.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    try {
      parsed = JSON.parse(stripped);
    } catch {
      const truncated = candidate?.finishReason === "MAX_TOKENS";
      return {
        ok: false,
        modelKey,
        modelId: modelConfig.id,
        kind: "parse",
        raw: text,
        truncated,
        attempts: result.attempts,
      };
    }
  }

  return { ok: true, modelKey, modelId: modelConfig.id, parsed, attempts: result.attempts };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKeys = await resolveApiKeys(event);
  if (!apiKeys.length) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error:
          "No Gemini API key is configured. Set GEMINI_API_KEY in Netlify (comma-separate multiple keys for automatic failover), or add one via the Admin panel.",
      }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const {
    subject, gradeLevel, topic, numDays, model,
    designPattern, activityDetail, assessmentTypes, mcItemCount, otherAssessment,
  } = payload;

  if (!subject || !gradeLevel || !topic || !numDays) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "subject, gradeLevel, topic, and numDays are required" }),
    };
  }

  const modelKey = MODEL_MAP[model] ? model : DEFAULT_MODEL_KEY;
  const modelConfig = MODEL_MAP[modelKey];
  const days = Math.max(1, Math.min(10, parseInt(numDays, 10) || 1));
  const mcCount = Math.max(1, Math.min(20, parseInt(mcItemCount, 10) || 5));

  const pattern = pickDesignPattern(designPattern);
  const phaseList = pattern.phases.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const assessmentInstructions = buildAssessmentInstructions(assessmentTypes, mcCount, otherAssessment);
  const isDetailed = activityDetail === "detailed";
  const outputLanguage = detectOutputLanguage(subject, topic);

  // The full menu of teaching strategies Detailed mode can draw on for the FLOW
  // (During-Lesson) phases. Drill and Review live only in the Pre-Lesson field
  // now, so they're deliberately excluded here to avoid repeating them. Not
  // every strategy belongs in every phase — the model picks whichever ones
  // genuinely fit each phase of the chosen design pattern.
  const STRATEGY_MENU = [
    "Motivation/Engagement Activity", "Icebreaker or Energizer",
    "Activating Prior Knowledge", "Think-Pair-Share", "Questioning Techniques",
    "Demonstration", "Guided Practice", "Collaborative Learning",
    "Hands-on Investigation", "Independent Practice", "Reflection",
    "Exit Ticket", "Formative Assessment", "Differentiated Activities",
  ].join(", ");

  const preLessonFormatBlock = isDetailed
    ? `
PRE-LESSON FORMAT — structure every day's "preLesson" using EXACTLY these three parts, in this order,
and nothing else (no classroom routine, no attendance, no separate objective-setting line — those are
not part of this field). Each part is a bold heading line followed by 1 bullet line ("- ...") that
names a concrete teacher action AND the expected learner response/behavior, so it reads as a short
classroom script rather than a label:
1. **Review:** (a specific question or quick task that surfaces what learners recall from the prior
   session, with the expected learner answer)
2. **Drill:** (a fast, specific skill warm-up tied to a prerequisite skill for today's lesson)
3. **Motive Question:** (one specific, engaging question tied to today's topic that hooks learners'
   interest and leads naturally into the lesson, with the kind of answer it should draw out)`
    : `
PRE-LESSON FORMAT — structure every day's "preLesson" using EXACTLY these three bullet lines ("- ..."),
in this order, and nothing else: one for **Review** (of the previous lesson), one for **Drill**, and
one for **Motive Question** (a hook question tied to today's topic). Do not add classroom routine,
attendance, or any other item.`;

  const flowFormatBlock = isDetailed
    ? `
FLOW FORMAT — structure every day's "flow" using the "${pattern.label}" lesson design pattern, with
each phase written out as a fully detailed, classroom-ready block so another teacher could run it from
this text alone with zero extra explanation. Use exactly these phases, in this order:
${phaseList}

For EACH phase, write it in this exact structure:
"**{Phase Name}:**" (bold heading line for the phase, e.g. "**Engage:**")
"**Strategy: {one or more strategies from the menu below that genuinely fit this phase}**" (bold
  heading line naming which teaching strategy/strategies this phase uses — choose from: ${STRATEGY_MENU}.
  Do not force every strategy into every phase; pick what actually fits this phase of "${pattern.label}",
  and vary the selection across the day's phases so the same 2-3 strategies aren't reused everywhere.)
"**Activity No. {n}: {short, specific activity title}**" (bold heading line — number activities 1, 2, 3...
  sequentially across the day, one per phase, in phase order)
"**Directions:**" (bold heading line) followed by 1-2 bullet lines ("- ...") giving the exact setup and
  instructions the teacher gives learners before they begin (what to say, what to hand out, how to
  group learners).
"**Process:**" (bold heading line) followed by 4-7 bullet lines ("- ..."), each one a numbered step
  written as "- Step 1: ...", "- Step 2: ...", etc. Each step must combine, in one line: the specific
  teacher action or question, the expected learner response or behavior, and — where the step ends and
  another begins — a short transition phrase the teacher can say aloud to move learners forward. At
  least one step per phase must include a quick in-the-moment check for understanding (a question,
  thumbs-up/down, or quick look-around) so assessment opportunities are visible throughout the phase,
  not saved only for the end.

After the Process steps for the final phase, add two more bullet lines: one noting a specific inclusive
accommodation for that day's activities, and one that is a short closing reflection prompt connecting
today's lesson back to the learners' own lives, spoken as something the teacher would actually say.`
    : `
FLOW FORMAT — structure every day's "flow" using the "${pattern.label}" lesson design pattern.
Use exactly these phases, in this order, one bold heading line per phase (e.g. "**Engage:**") followed
by 2-4 bullet lines ("- ...") describing concrete, grade-appropriate classroom actions for that phase.
Phases:
${phaseList}`;

  const schemaHint = `
Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:
{
  "competency": "single string: a specific, well-articulated learning competency for the whole lesson, plus its Content Standard and Performance Standard, aligned to MATATAG for this grade level and topic",
  "days": [
    {
      "day": 1,
      "objectives": "string: ONE measurable objective for this day, written with a specific action verb (e.g. identify, describe, compare, classify), derived directly from the overall competency above so every day visibly builds toward it",
      "learnerContext": "string: a short note anticipating how learners' readiness may vary for this specific day's task, and what that implies for how the day's activities should be adjusted",
      "preLesson": "string: how to get learners ready for this day's lesson, formatted as described below in PRE-LESSON FORMAT",
      "flow": "string: the day's activity flow, formatted as described below in FLOW FORMAT",
      "resources": "string: learning resources needed for this day, as bullet lines starting with \\"- \\"",
      "integration": "string: a genuine, specific cross-subject connection for this day (name the subject and exactly how it connects) — only write 'N/A' if there truly is none, which should be rare",
      "assessment": "string: formative assessment content for this day, formatted as described below in ASSESSMENT FORMAT",
      "extended": "string: formatted as described below in EXTENDED LEARNING FORMAT"
    }
  ]
}
The "days" array must contain exactly ${days} objects, with "day" numbered 1 to ${days} in order, forming a coherent, logically sequenced ${days}-day lesson (not ${days} repeats of the same thing). Every day's objectives, flow, and assessment must clearly trace back to the same overall competency — a reader should be able to see the throughline across all sections, not disconnected activities.

FORMATTING RULES (applies to preLesson, flow, resources, assessment, extended):
- Use "\\n" to separate lines within a field's string value.
- Bulleted lines start with "- ".
- Use **double asterisks** to bold short labels/headings (e.g. "**Engage:**"), never bold whole sentences.
- Do not use any other markdown (no #, no numbered-list syntax outside what's specified below).
- Write every bullet concretely and specifically enough that another teacher could run the lesson from
  this text alone, with no further explanation needed — name the actual question to ask, the actual
  material to hold up, the actual instruction to give. Avoid vague filler like "discuss the topic" or
  "do an activity."

${preLessonFormatBlock}

${flowFormatBlock}

Across these phases (not just in one phase), you must visibly weave in ALL of the following Learning
Design Principles — spread them naturally across different phases rather than bolting them all onto
the last phase:
- make the day's objective clear and understandable to learners in their own words
- guide learners with a modeled or shared example before letting them try the task independently
- include at least one moment where the teacher checks learners' understanding AND well-being, not
  only at the very end
- explicitly connect today's new concept to a competency or skill learners already have from a
  previous lesson
- include genuine peer collaboration (pairs or small groups), not just individual seatwork
- include a short reflection prompt that helps learners see why the lesson matters to them personally
- include inclusive accommodations that go beyond one generic line — vary them across days/phases to
  address different needs (e.g. visual/hearing support, learners needing more processing time,
  multilingual learners, learners from under-resourced households)

ASSESSMENT FORMAT — the "assessment" field for every day must include ALL of the following, each as a
bold heading line followed by its bullet content, using the exact instructions given:
${assessmentInstructions}
After that, add one final bold line "**Evidence of Success:**" followed by one bullet line stating the
specific, observable sign that a learner has met today's objective (not just "learners understood" —
describe what a successful answer or action actually looks like), so the assessment clearly generates
evidence of whether learning happened.

EXTENDED LEARNING FORMAT — the "extended" field must contain exactly two parts, each a bold heading
followed by one concrete, actionable bullet line:
- "**If learners need more support:**" — a specific, actionable adjustment or re-teaching approach for
  learners who struggled with today's objective.
- "**If learners are ready to extend:**" — a specific, actionable task that stretches learners who
  mastered today's objective quickly.

NOTE ON HEADING LABELS: every bold heading label written above in English (e.g. "Review", "Drill",
"Motive Question", "Multiple Choice Test", "Exit Ticket", "Evidence of Success", "If learners need
more support", "If learners are ready to extend") describes WHAT to include structurally — it is not a
literal string you must copy. Per OUTPUT LANGUAGE given earlier in this prompt, translate each of these
heading labels into Filipino too when OUTPUT LANGUAGE = Filipino (e.g. "Balik-Aral", "Pagsusulit na
Maramihang Pagpipilian", "Katibayan ng Tagumpay"), so no field ends up with an English heading sitting
inside otherwise-Filipino content.
`.trim();

  const prompt = `You are an expert Philippine DepEd basic education teacher writing a Daily Lesson Log (DLL) in the ILAW Format for the MATATAG curriculum. Your output will be evaluated against the official ILAW quality rubric, so it must satisfy all of the following:
1. Intentions (competency/objectives) are clearly and specifically stated.
2. Intentions are coherent and evident across every section — objectives, flow, and assessment all visibly trace back to the same competency.
3. The learning experience is clear enough that another teacher could implement it without extra explanation.
4. The learning experience is well-designed, with the Learning Design Principles intentionally embedded throughout (not token gestures).
5. The learning experience maximizes genuine opportunities for cross-subject integration.
6. The learning experience is inclusive, with varied, concrete support for learners with disabilities, barriers, or unique contexts.
7. Assessment is integrated throughout the session, not just tacked on at the end, to reveal learners' progress and support needs.
8. Assessment strategies generate real evidence of whether learning was successful.
9. The "Ways Forward" section offers actionable interventions to extend or adjust learning, differentiated for learners who need support versus learners ready to go further.

Subject/Learning Area: ${subject}
Grade Level: ${gradeLevel}
Topic/Competency focus: ${topic}
Number of days/sessions: ${days}
Lesson design pattern to follow: ${pattern.label}

CONTEXT AND LEVEL REQUIREMENTS (very important):
- Write in clear, grade-appropriate ${outputLanguage} (see OUTPUT LANGUAGE below) matched to the
  cognitive level and typical vocabulary of a Filipino learner in ${gradeLevel}. Use simpler sentences
  and concrete, hands-on examples for lower grades; more academic vocabulary and abstract reasoning are
  acceptable for higher grades.
- Ground every example, scenario, and material in the Philippine setting: use Filipino learner names
  (e.g. Ana, Mateo, Liza, Jomar, Kristine), local settings (barangay, palengke, sari-sari store,
  jeepney, rice field, school canteen), Philippine peso (₱) for any money examples, and locally familiar
  plants/animals/food (e.g. mango, santol, carabao, adobo, sinigang) instead of foreign references.
  Avoid US-centric defaults (no dollars, no Fahrenheit, no foreign brand names or settings).
- Keep every activity realistic for a public school classroom with limited materials (recycled/low-cost
  materials, items learners can bring from home, or simple teacher demonstrations).

OUTPUT LANGUAGE (decided already — do not re-derive or override this):
- OUTPUT LANGUAGE = ${outputLanguage}. This was determined from the Subject and Topic/Competency
  fields above and is final. Every part of your response must comply with it, with no exceptions —
  regardless of anything else in this prompt that mentions Filipino culture, names, or settings, those
  are about CONTENT (what the examples are about), not about which LANGUAGE you write in.
- This applies to the ENTIRE JSON output — including the "competency" field itself, not just the
  per-day fields (objectives, learnerContext, preLesson, flow, resources, integration, assessment,
  extended). Never let "competency" end up in a different language than the rest of the document.
- If OUTPUT LANGUAGE = Filipino: write everything in natural, grade-appropriate Filipino. You may keep
  in English only what is conventionally left untranslated in real Filipino classrooms: unavoidable
  technical/scientific terms, proper nouns, and the lesson design pattern's phase names themselves
  (e.g. "Engage", "Explore"). Everything else you write — instructions, questions, bullet content, any
  bold sub-headings you compose — must be in Filipino, not English.
- If OUTPUT LANGUAGE = English: write everything in English, with no Filipino words mixed in beyond
  common Philippine proper nouns/place names (e.g. "barangay", "jeepney" used as-is are fine; do not
  write full Filipino sentences or Filipino instructional phrases).
- Do not mix languages within a field beyond the narrow exceptions above — commit to OUTPUT LANGUAGE
  for the bulk of every field, in every day, throughout the whole document.

${schemaHint}`;

  try {
    let attempt = await generateForModel(modelKey, prompt, apiKeys);
    // Every failed attempt is recorded so the ORIGINAL failure (the one that
    // actually matters) isn't overwritten by a later fallback's error.
    const attemptLog = [];
    const logFailure = (a) =>
      attemptLog.push({
        model: a.modelId,
        status: a.status ?? null,
        kind: a.kind,
        details: a.errText ? String(a.errText).slice(0, 600) : undefined,
      });
    if (!attempt.ok) logFailure(attempt);
    const fallbackChain = [];
    // Capped at 2 hops (so at most 3 models total get tried) — keeps
    // worst-case latency bounded within Netlify's 60-second limit even if
    // every model in the chain fails after its own key retries.
    const MAX_FALLBACK_HOPS = 2;

    let cursorKey = modelKey;
    while (!attempt.ok && fallbackChain.length < MAX_FALLBACK_HOPS) {
      const nextKey = MODEL_MAP[cursorKey].fallback;
      if (!nextKey || !MODEL_MAP[nextKey]) break;
      fallbackChain.push(nextKey);
      cursorKey = nextKey;
      attempt = await generateForModel(nextKey, prompt, apiKeys);
      if (!attempt.ok) logFailure(attempt);
    }
    const usedFallback = fallbackChain.length > 0;

    if (!attempt.ok) {
      const fallbackNote = usedFallback
        ? ` — also failed on fallback model(s): ${fallbackChain.map((k) => MODEL_MAP[k].id).join(", ")}`
        : "";
      if (attempt.kind === "parse") {
        const errorLabel = attempt.truncated
          ? `The response was too long and got cut off before it finished${fallbackNote}. Try fewer days, "Concise" instead of "Detailed", or a shorter topic description.`
          : `Model did not return valid JSON${fallbackNote}`;
        return {
          statusCode: 502,
          body: JSON.stringify({
            error: errorLabel,
            raw: attempt.raw,
            model: attempt.modelId,
          }),
        };
      }
      const keyNote =
        apiKeys.length > 1 ? ` (tried ${attempt.attempts} of ${apiKeys.length} configured keys)` : "";
      // Report the FIRST failure (the originally requested model), not the
      // last fallback's, since that's the real cause.
      const first = attemptLog[0] || {};
      let reason = "";
      if (first.status === 429) {
        reason = ` — rate limit or quota exceeded on ${first.model}. Wait a minute and try again; if it keeps happening, the daily quota may be used up (check Google AI Studio usage or enable billing)`;
      } else if (first.status === 503 || first.status === 500) {
        reason = ` — ${first.model} is temporarily overloaded. Please try again shortly`;
      } else if (first.status) {
        reason = ` — ${first.model} returned HTTP ${first.status}`;
      }
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: `Gemini API error${reason}${keyNote}${fallbackNote}`,
          details: first.details,
          model: first.model || attempt.modelId,
          attempts: attemptLog,
        }),
      };
    }

    const responseBody = { ...attempt.parsed };
    if (usedFallback) {
      // Surfaced to the browser so the UI can let the teacher know a
      // different model was used — see app.js. Harmless extra key for any
      // other consumer of this JSON, which only reads the fields it knows.
      responseBody._meta = {
        modelUsed: attempt.modelId,
        requestedModel: MODEL_MAP[modelKey].id,
      };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(responseBody),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
