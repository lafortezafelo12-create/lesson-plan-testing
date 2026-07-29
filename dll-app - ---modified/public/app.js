const form = document.getElementById("dll-form");
const generateBtn = document.getElementById("generate-btn");
const formHint = document.getElementById("form-hint");
const emptyState = document.getElementById("empty-state");
const resultEl = document.getElementById("result");
const competencyEl = document.getElementById("f-competency");
const daysContainer = document.getElementById("days-container");
const downloadBtn = document.getElementById("download-btn");
const libraryList = document.getElementById("library-list");
const toast = document.getElementById("toast");

const LIB_KEY = "ilaw_dll_library";
const DAY_FIELDS = [
  ["objectives", "Learning Objectives"],
  ["learnerContext", "Learner Context"],
  ["preLesson", "Pre-Lesson"],
  ["flow", "Flow"],
  ["resources", "Learning Resources"],
  ["integration", "Opportunities for Integration"],
  ["assessment", "Formative Assessment"],
  ["extended", "Extended Learning Opportunities"],
];

let currentMeta = null;

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add("hidden"), 3200);
}

function renderDays(days) {
  daysContainer.innerHTML = "";
  days.forEach((day, idx) => {
    const card = document.createElement("div");
    card.className = "day-card";
    card.dataset.day = idx + 1;

    const head = document.createElement("div");
    head.className = "day-card__head";
    head.textContent = `Day ${idx + 1}`;
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "day-card__body";

    DAY_FIELDS.forEach(([key, label]) => {
      const wrap = document.createElement("label");
      wrap.className = `field-${key}`;
      wrap.textContent = label;
      const ta = document.createElement("textarea");
      ta.dataset.field = key;
      ta.value = day[key] || "";
      wrap.appendChild(ta);
      body.appendChild(wrap);
    });

    card.appendChild(body);
    daysContainer.appendChild(card);
  });
}

function collectDaysFromForm() {
  return Array.from(daysContainer.querySelectorAll(".day-card")).map((card) => {
    const obj = { day: Number(card.dataset.day) };
    card.querySelectorAll("textarea").forEach((ta) => {
      obj[ta.dataset.field] = ta.value;
    });
    return obj;
  });
}

function getLibrary() {
  try {
    return JSON.parse(localStorage.getItem(LIB_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveToLibrary(entry) {
  const lib = getLibrary();
  lib.unshift(entry);
  localStorage.setItem(LIB_KEY, JSON.stringify(lib.slice(0, 30)));
  renderLibrary();
}

function deleteFromLibrary(id) {
  const lib = getLibrary().filter((e) => e.id !== id);
  localStorage.setItem(LIB_KEY, JSON.stringify(lib));
  renderLibrary();
}

function renderLibrary() {
  const lib = getLibrary();
  if (!lib.length) {
    libraryList.innerHTML = '<p class="hint">Nothing generated yet this session.</p>';
    return;
  }
  libraryList.innerHTML = "";
  lib.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "library-item";
    card.innerHTML = `
      <div class="library-item__row">
        <div class="library-item__title">${escapeHtml(entry.meta.lessonTitle || "Untitled Lesson")}</div>
        <div class="library-item__date">${escapeHtml(formatEntryDate(entry.id))}</div>
      </div>
      <div class="library-item__meta">${escapeHtml(entry.meta.subject)} &middot; ${escapeHtml(entry.meta.gradeLevel)} &middot; ${entry.days.length} day(s)</div>
      <div class="library-item__actions">
        <button data-action="load">Load</button>
        <button data-action="download">Download</button>
        <button data-action="delete">Delete</button>
      </div>
    `;
    card.querySelector('[data-action="load"]').addEventListener("click", () => loadEntry(entry));
    card.querySelector('[data-action="download"]').addEventListener("click", () => downloadDocx(entry.meta, entry.competency, entry.days));
    card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteFromLibrary(entry.id));
    libraryList.appendChild(card);
  });
}

function loadEntry(entry) {
  currentMeta = entry.meta;
  competencyEl.value = entry.competency;
  renderDays(entry.days);
  emptyState.classList.add("hidden");
  resultEl.classList.remove("hidden");
  showEditView();
  window.scrollTo({ top: resultEl.offsetTop - 20, behavior: "smooth" });
}

function formatEntryDate(id) {
  const d = new Date(Number(id));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function nl2br(str) {
  return escapeHtml(str).replace(/\n/g, "<br>");
}

// ---------- Document preview ----------
const viewToggle = document.getElementById("view-toggle");
const editView = document.getElementById("edit-view");
const previewView = document.getElementById("preview-view");
const docPage = document.getElementById("doc-page");

function showEditView() {
  viewToggle.querySelectorAll(".view-toggle__btn").forEach((b) => {
    const isEdit = b.dataset.view === "edit";
    b.classList.toggle("is-active", isEdit);
    b.setAttribute("aria-selected", String(isEdit));
  });
  editView.classList.remove("hidden");
  previewView.classList.add("hidden");
}

function renderDocPreview() {
  const days = collectDaysFromForm();
  const meta = currentMeta || {};

  const metaField = (label, value) => `
    <div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "\u2014")}</strong></div>`;

  const metaHtml = `
    <div class="doc-meta">
      ${metaField("Learning Area", meta.subject)}
      ${metaField("Grade & Section", meta.gradeSection || meta.gradeLevel)}
      ${metaField("Teacher", meta.teacherName)}
      ${metaField("Quarter / Week", meta.termWeek)}
      ${metaField("Date & Time", meta.dateTime)}
      ${metaField("References", meta.references)}
    </div>`;

  const dayHeaders = days.map((_, i) => `<th>Day ${i + 1}</th>`).join("");

  const rows = DAY_FIELDS.map(([key, label]) => {
    const cells = days.map((d) => `<td>${nl2br(d[key])}</td>`).join("");
    return `<tr><th class="doc-row-label">${escapeHtml(label)}</th>${cells}</tr>`;
  }).join("");

  docPage.innerHTML = `
    <div class="doc-title">Daily Lesson Log</div>
    <p class="doc-subtitle">${escapeHtml(meta.lessonTitle || "")}</p>
    ${metaHtml}
    <div class="doc-competency">
      <span>Learning Competency &amp; Curriculum Standards</span>
      <p>${nl2br(competencyEl.value) || "\u2014"}</p>
    </div>
    <div class="doc-table-wrap">
      <table class="doc-table">
        <thead><tr><th></th>${dayHeaders}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="doc-footnote">${escapeHtml(meta.aiDeclaration || "")}</p>
  `;
}

viewToggle.querySelectorAll(".view-toggle__btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    viewToggle.querySelectorAll(".view-toggle__btn").forEach((b) => {
      b.classList.remove("is-active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("is-active");
    btn.setAttribute("aria-selected", "true");

    const isPreview = btn.dataset.view === "preview";
    editView.classList.toggle("hidden", isPreview);
    previewView.classList.toggle("hidden", !isPreview);
    if (isPreview) renderDocPreview();
  });
});

const otherAssessmentCheck = document.getElementById("other-assessment-check");
const otherAssessmentLabel = document.getElementById("other-assessment-label");
otherAssessmentCheck.addEventListener("change", () => {
  otherAssessmentLabel.classList.toggle("hidden", !otherAssessmentCheck.checked);
});

// ---------- Lesson exemplar (PDF) ----------
const EXEMPLAR_MAX_BYTES = 2.5 * 1024 * 1024; // 2.5MB raw. Base64 adds ~33% overhead, so this
// stays safely under Netlify's ~4.5MB effective limit for binary payloads (out of its 6MB hard cap
// on buffered request bodies) — a 4MB raw file, previously allowed here, could push a request over
// that limit and get rejected by the platform before it ever reached the function, surfacing to the
// browser as a raw HTML error page instead of JSON.

const exemplarDrop = document.getElementById("exemplar-drop");
const exemplarInput = document.getElementById("exemplar-input");
const exemplarBrowseBtn = document.getElementById("exemplar-browse-btn");
const exemplarRemoveBtn = document.getElementById("exemplar-remove-btn");
const exemplarEmpty = document.getElementById("exemplar-empty");
const exemplarFileRow = document.getElementById("exemplar-file-row");
const exemplarFilename = document.getElementById("exemplar-filename");
const exemplarHint = document.getElementById("exemplar-hint");

let exemplarData = null; // { name, mimeType, data } — base64 payload, held in memory only

function resetExemplarUI() {
  exemplarData = null;
  exemplarInput.value = "";
  exemplarEmpty.classList.remove("hidden");
  exemplarFileRow.classList.add("hidden");
  exemplarFilename.textContent = "";
  exemplarHint.textContent = "";
}

function setExemplarFile(name) {
  exemplarEmpty.classList.add("hidden");
  exemplarFileRow.classList.remove("hidden");
  exemplarFilename.textContent = name;
}

function handleExemplarFile(file) {
  if (!file) return;
  exemplarHint.textContent = "";

  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    exemplarHint.textContent = "Please choose a PDF file.";
    return;
  }
  if (file.size > EXEMPLAR_MAX_BYTES) {
    exemplarHint.textContent = `That PDF is too large (max ${(EXEMPLAR_MAX_BYTES / (1024 * 1024)).toFixed(0)}MB).`;
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const base64 = String(reader.result).split(",")[1] || "";
    exemplarData = { name: file.name, mimeType: "application/pdf", data: base64 };
    setExemplarFile(file.name);
  };
  reader.onerror = () => {
    exemplarHint.textContent = "Couldn't read that file. Please try again.";
  };
  reader.readAsDataURL(file);
}

exemplarBrowseBtn.addEventListener("click", () => exemplarInput.click());
exemplarInput.addEventListener("change", () => handleExemplarFile(exemplarInput.files[0]));
exemplarRemoveBtn.addEventListener("click", resetExemplarUI);

["dragover", "dragenter"].forEach((evt) => {
  exemplarDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    exemplarDrop.classList.add("is-dragover");
  });
});
["dragleave", "dragend"].forEach((evt) => {
  exemplarDrop.addEventListener(evt, () => exemplarDrop.classList.remove("is-dragover"));
});
exemplarDrop.addEventListener("drop", (e) => {
  e.preventDefault();
  exemplarDrop.classList.remove("is-dragover");
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  handleExemplarFile(file);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(form);
  const subject = fd.get("subject").trim();
  const gradeLevel = fd.get("gradeLevel").trim();
  const topic = fd.get("topic").trim();
  const numDays = Number(fd.get("numDays"));
  const model = fd.get("model") || "flash";
  const designPattern = fd.get("designPattern") || "5Es";
  const activityDetail = fd.get("activityDetail") || "concise";
  const assessmentTypes = fd.getAll("assessmentTypes");
  const mcItemCount = Number(fd.get("mcItemCount")) || 5;
  const otherAssessment = fd.get("otherAssessment") ? fd.get("otherAssessment").trim() : "";

  currentMeta = {
    lessonTitle: topic,
    subject,
    gradeLevel,
    termWeek: fd.get("termWeek").trim(),
    teacherName: fd.get("teacherName").trim() || "[Teacher's Name]",
    gradeSection: fd.get("gradeSection").trim() || gradeLevel,
    dateTime: fd.get("dateTime").trim() || "[Insert Date and Time]",
    numDays,
    references: fd.get("references").trim() || "N/A",
    aiDeclaration:
      "AI (Gemini) was used to help draft the initial content of this lesson plan, in line with DO 3, s. 2026 Annex A. Reviewed and adjusted by the teacher before use.",
  };

  generateBtn.disabled = true;
  generateBtn.querySelector(".btn-label").textContent = "Generating\u2026";
  formHint.textContent = "";

  try {
    const resp = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject, gradeLevel, topic, numDays, model,
        designPattern, activityDetail, assessmentTypes, mcItemCount, otherAssessment,
        exemplar: exemplarData,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const detail = data.details ? ` (${String(data.details).slice(0, 160)})` : "";
      throw new Error((data.error || "Generation failed") + detail);
    }

    competencyEl.value = data.competency || "";
    renderDays(data.days || []);
    emptyState.classList.add("hidden");
    resultEl.classList.remove("hidden");
    showEditView();

    if (data._meta && data._meta.modelUsed) {
      formHint.textContent = `Note: your selected model was unavailable, so this was generated using ${data._meta.modelUsed} instead. Review carefully before use.`;
    }

    saveToLibrary({
      id: `${Date.now()}`,
      meta: currentMeta,
      competency: data.competency,
      days: data.days,
    });

    window.scrollTo({ top: resultEl.offsetTop - 20, behavior: "smooth" });
  } catch (err) {
    formHint.textContent = `Couldn't generate: ${err.message}`;
  } finally {
    generateBtn.disabled = false;
    generateBtn.querySelector(".btn-label").textContent = "Generate with AI";
  }
});

async function downloadDocx(meta, competency, days) {
  showToast("Building your Word document\u2026");
  try {
    const resp = await fetch("/api/generate-docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meta, competency, days }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || "Could not build the document");
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(meta.lessonTitle || "DLL").replace(/[^a-z0-9]+/gi, "_")}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Downloaded.");
  } catch (err) {
    showToast(err.message);
  }
}

downloadBtn.addEventListener("click", () => {
  if (!currentMeta) return;
  const days = collectDaysFromForm();
  downloadDocx(currentMeta, competencyEl.value, days);
});

renderLibrary();

// ---------- Admin panel ----------
const adminOpenBtn = document.getElementById("admin-open-btn");
const adminModal = document.getElementById("admin-modal");
const adminCloseBtn = document.getElementById("admin-close-btn");
const adminLoginView = document.getElementById("admin-login-view");
const adminSettingsView = document.getElementById("admin-settings-view");
const adminPasswordInput = document.getElementById("admin-password-input");
const adminLoginBtn = document.getElementById("admin-login-btn");
const adminLoginHint = document.getElementById("admin-login-hint");
const adminStatusHint = document.getElementById("admin-status-hint");
const adminApikeyInput = document.getElementById("admin-apikey-input");
const adminSaveBtn = document.getElementById("admin-save-btn");
const adminClearBtn = document.getElementById("admin-clear-btn");
const adminSettingsHint = document.getElementById("admin-settings-hint");

let adminPassword = null; // held in memory only, never stored, re-sent per request

function openAdminModal() {
  adminModal.classList.remove("hidden");
  adminLoginView.classList.remove("hidden");
  adminSettingsView.classList.add("hidden");
  adminPasswordInput.value = "";
  adminLoginHint.textContent = "";
  adminPasswordInput.focus();
}

function closeAdminModal() {
  adminModal.classList.add("hidden");
  adminPassword = null;
}

adminOpenBtn.addEventListener("click", openAdminModal);
adminCloseBtn.addEventListener("click", closeAdminModal);
adminModal.addEventListener("click", (e) => {
  if (e.target === adminModal) closeAdminModal();
});

async function callAdmin(action, extra = {}) {
  const resp = await fetch("/api/admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: adminPassword, action, ...extra }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "Request failed");
  return data;
}

function describeKeyStatus(status) {
  if (!status.hasOverride) {
    return "Currently using the default key from Netlify's environment variable.";
  }
  const list = status.previews.join(", ");
  return status.keyCount > 1
    ? `Currently using ${status.keyCount} custom keys with automatic failover (${list}).`
    : `Currently using a custom key (${list}).`;
}

adminLoginBtn.addEventListener("click", async () => {
  const pw = adminPasswordInput.value;
  if (!pw) return;
  adminLoginBtn.disabled = true;
  adminLoginHint.textContent = "Checking\u2026";
  adminPassword = pw;
  try {
    const status = await callAdmin("status");
    adminLoginView.classList.add("hidden");
    adminSettingsView.classList.remove("hidden");
    adminStatusHint.textContent = describeKeyStatus(status);
    adminSettingsHint.textContent = "";
    adminApikeyInput.value = "";
  } catch (err) {
    adminPassword = null;
    adminLoginHint.textContent = err.message;
  } finally {
    adminLoginBtn.disabled = false;
  }
});

adminPasswordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") adminLoginBtn.click();
});

adminSaveBtn.addEventListener("click", async () => {
  const key = adminApikeyInput.value.trim();
  if (!key) {
    adminSettingsHint.textContent = "Paste at least one API key first.";
    return;
  }
  adminSaveBtn.disabled = true;
  adminSettingsHint.textContent = "Saving\u2026";
  try {
    const saveResult = await callAdmin("set", { apiKey: key });
    adminSettingsHint.textContent =
      saveResult.keyCount > 1
        ? `Saved ${saveResult.keyCount} keys. New generations will fail over between them automatically.`
        : "Saved. New generations will use this key.";
    adminApikeyInput.value = "";
    const status = await callAdmin("status");
    adminStatusHint.textContent = describeKeyStatus(status);
  } catch (err) {
    adminSettingsHint.textContent = err.message;
  } finally {
    adminSaveBtn.disabled = false;
  }
});

adminClearBtn.addEventListener("click", async () => {
  adminClearBtn.disabled = true;
  adminSettingsHint.textContent = "Reverting\u2026";
  try {
    await callAdmin("clear");
    adminSettingsHint.textContent = "Reverted to the default key from Netlify's environment variable.";
    adminStatusHint.textContent = "Currently using the default key from Netlify's environment variable.";
  } catch (err) {
    adminSettingsHint.textContent = err.message;
  } finally {
    adminClearBtn.disabled = false;
  }
});

