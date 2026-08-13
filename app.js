const DB_NAME = "note-review-pwa";
const DB_VERSION = 2;
const NOTE_STORE = "notes";
const LOG_STORE = "reviewLogs";
const SETTINGS_STORE = "settings";
const PRACTICE_TYPES = ["用語再生", "説明再生", "比較", "適用", "白紙再現"];
const PRACTICE_DESCRIPTIONS = {
  用語再生: "用語・公式・年号を、紙ノートを見ずに答える。",
  説明再生: "仕組みや流れを、自分の言葉で説明する。",
  比較: "AとBの違い、共通点、使い分けを説明する。",
  適用: "例題・類題・別の場面に知識を使ってみる。",
  白紙再現: "題名だけを見て、ノートの構造を何も見ずに書き出す。"
};
const RATING_RETENTION = [0.2, 0.4, 0.6, 0.75, 0.9, 0.97];
const RATING_LABELS = [
  "0 全く無理",
  "1 見ればわかる",
  "2 一部だけ",
  "3 苦労して正解",
  "4 少し迷う",
  "5 すぐ説明"
];

let db;
let notes = [];
let settings = {
  targetRetention: 0.8,
  calendarTime: "20:00"
};

document.addEventListener("DOMContentLoaded", async () => {
  db = await openDb();
  await loadSettings();
  setupStaticUi();
  await refresh();
  registerServiceWorker();
});

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const notesStore = database.objectStoreNames.contains(NOTE_STORE)
        ? request.transaction.objectStore(NOTE_STORE)
        : database.createObjectStore(NOTE_STORE, { keyPath: "id" });
      if (!notesStore.indexNames.contains("nextReviewAt")) notesStore.createIndex("nextReviewAt", "nextReviewAt");
      if (!notesStore.indexNames.contains("subject")) notesStore.createIndex("subject", "subject");
      if (!notesStore.indexNames.contains("notebookName")) notesStore.createIndex("notebookName", "notebookName");

      const logsStore = database.objectStoreNames.contains(LOG_STORE)
        ? request.transaction.objectStore(LOG_STORE)
        : database.createObjectStore(LOG_STORE, { keyPath: "id" });
      if (!logsStore.indexNames.contains("noteItemId")) logsStore.createIndex("noteItemId", "noteItemId");

      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(storeName, mode = "readonly") {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAll(storeName) {
  return requestToPromise(tx(storeName).getAll());
}

async function put(storeName, value) {
  return requestToPromise(tx(storeName, "readwrite").put(value));
}

async function remove(storeName, id) {
  return requestToPromise(tx(storeName, "readwrite").delete(id));
}

async function loadSettings() {
  const saved = await requestToPromise(tx(SETTINGS_STORE).get("main"));
  if (saved) settings = { ...settings, ...saved.value };
}

async function saveSettings() {
  await put(SETTINGS_STORE, { key: "main", value: settings });
}

function setupStaticUi() {
  document.getElementById("todayLabel").textContent = formatDate(new Date());
  document.getElementById("firstStudiedInput").value = toDateInput(new Date());
  document.getElementById("calendarTime").value = settings.calendarTime;
  document.getElementById("targetRetention").value = String(settings.targetRetention);
  renderPracticeChecks();
  renderPracticeGuide();

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showScreen(tab.dataset.screen));
  });

  document.getElementById("buildSessionBtn").addEventListener("click", renderToday);
  document.getElementById("sortMode").addEventListener("change", renderList);
  document.getElementById("searchInput").addEventListener("input", renderList);
  document.getElementById("subjectFilter").addEventListener("change", () => {
    renderNotebookFilter();
    renderList();
  });
  document.getElementById("notebookFilter").addEventListener("change", renderList);
  document.getElementById("subjectInput").addEventListener("input", renderNotebookChips);
  document.getElementById("notebookNameInput").addEventListener("input", renderNotebookChips);
  document.getElementById("noteForm").addEventListener("submit", addNote);
  document.getElementById("exportJsonBtn").addEventListener("click", exportJson);
  document.getElementById("exportIcsBtn").addEventListener("click", exportIcs);
  document.getElementById("importJsonInput").addEventListener("change", importJson);
  document.getElementById("calendarTime").addEventListener("change", async (event) => {
    settings.calendarTime = event.target.value || "20:00";
    await saveSettings();
    toast("通知時刻を保存しました");
  });
  document.getElementById("targetRetention").addEventListener("change", async (event) => {
    settings.targetRetention = Number(event.target.value);
    await saveSettings();
    toast("目標定着率を保存しました");
  });
}

function renderPracticeChecks() {
  const host = document.getElementById("practiceChecks");
  host.innerHTML = "";
  PRACTICE_TYPES.forEach((type, index) => {
    const label = document.createElement("label");
    label.className = "check-option";
    label.title = PRACTICE_DESCRIPTIONS[type];
    label.innerHTML = `<input type="checkbox" value="${type}" ${index < 2 ? "checked" : ""}> <span>${type}</span>`;
    host.append(label);
  });
}

function renderPracticeGuide() {
  const host = document.getElementById("practiceGuideList");
  host.innerHTML = "";
  PRACTICE_TYPES.forEach((type) => {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = `<dt>${type}</dt><dd>${PRACTICE_DESCRIPTIONS[type]}</dd>`;
    host.append(wrapper);
  });
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((screen) => screen.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
  document.getElementById(`screen-${name}`).classList.add("active");
  document.querySelector(`[data-screen="${name}"]`).classList.add("active");
  document.getElementById("screenTitle").textContent = {
    today: "今日の復習",
    add: "ノート登録",
    list: "一覧",
    settings: "設定"
  }[name];
}

async function refresh() {
  notes = (await getAll(NOTE_STORE)).map(normalizeNote);
  renderNotebookOptions();
  renderSubjectFilter();
  renderNotebookFilter();
  renderNotebookChips();
  renderToday();
  renderList();
}

async function addNote(event) {
  event.preventDefault();
  const selectedTypes = [...document.querySelectorAll("#practiceChecks input:checked")].map((input) => input.value);
  const now = new Date();
  const note = {
    id: crypto.randomUUID(),
    subject: document.getElementById("subjectInput").value.trim(),
    notebookName: document.getElementById("notebookNameInput").value.trim(),
    number: document.getElementById("numberInput").value.trim(),
    title: document.getElementById("titleInput").value.trim(),
    firstStudiedAt: new Date(document.getElementById("firstStudiedInput").value).toISOString(),
    memo: document.getElementById("memoInput").value.trim(),
    preferredPracticeTypes: selectedTypes.length ? selectedTypes : ["用語再生", "説明再生"],
    stability: 1,
    nextReviewAt: startOfDay(now).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  await put(NOTE_STORE, note);
  event.target.reset();
  document.getElementById("firstStudiedInput").value = toDateInput(new Date());
  renderPracticeChecks();
  await refresh();
  showScreen("today");
  toast("登録しました");
}

function renderToday() {
  const due = notes
    .map((note) => ({ note, retention: estimateRetention(note) }))
    .filter(({ note }) => new Date(note.nextReviewAt) <= endOfDay(new Date()))
    .sort((a, b) => a.retention - b.retention || new Date(a.note.nextReviewAt) - new Date(b.note.nextReviewAt));
  const minutes = Number(document.getElementById("sessionMinutes").value);
  const limit = Math.max(1, Math.floor(minutes / 3));
  const queue = due.slice(0, limit);

  document.getElementById("dueCount").textContent = String(due.length);
  document.getElementById("sessionCount").textContent = String(queue.length);
  document.getElementById("avgRetention").textContent = due.length
    ? `${Math.round(avg(due.map((item) => item.retention)) * 100)}%`
    : "--";

  const host = document.getElementById("reviewQueue");
  host.innerHTML = "";
  queue.forEach(({ note, retention }) => host.append(renderReviewCard(note, retention)));
  document.getElementById("emptyToday").style.display = queue.length ? "none" : "block";
}

function renderReviewCard(note, retention) {
  const template = document.getElementById("reviewCardTemplate");
  const card = template.content.firstElementChild.cloneNode(true);
  const practiceType = choosePracticeType(note, retention);
  card.querySelector(".item-meta").textContent = `${formatNoteLocation(note)} / 次回 ${formatDate(new Date(note.nextReviewAt))}`;
  card.querySelector(".item-title").textContent = note.title;
  card.querySelector(".retention-badge").textContent = `${Math.round(retention * 100)}%`;
  card.querySelector(".practice-prompt").textContent = `${practiceType}: 紙ノートを閉じて、先に自力で思い出す`;
  card.querySelector(".practice-detail").textContent = PRACTICE_DESCRIPTIONS[practiceType];
  card.querySelector(".memo").textContent = note.memo || "";
  const ratings = card.querySelector(".rating-grid");
  RATING_LABELS.forEach((label, rating) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => completeReview(note, rating, practiceType));
    ratings.append(button);
  });
  return card;
}

function renderList() {
  const host = document.getElementById("noteList");
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const sortMode = document.getElementById("sortMode").value;
  const subjectFilter = document.getElementById("subjectFilter").value;
  const notebookFilter = document.getElementById("notebookFilter").value;
  let visible = notes.filter((note) => `${note.subject} ${note.notebookName} ${note.number} ${note.title}`.toLowerCase().includes(query));
  if (subjectFilter) {
    visible = visible.filter((note) => note.subject === subjectFilter);
  }
  if (notebookFilter) {
    visible = visible.filter((note) => note.notebookName === notebookFilter);
  }

  visible = visible.sort((a, b) => {
    if (sortMode === "subject") return `${a.subject}${a.notebookName}${a.number}`.localeCompare(`${b.subject}${b.notebookName}${b.number}`, "ja");
    if (sortMode === "createdAt") return new Date(b.createdAt) - new Date(a.createdAt);
    return new Date(a.nextReviewAt) - new Date(b.nextReviewAt);
  });

  host.innerHTML = "";
  visible.forEach((note) => host.append(renderNoteCard(note)));
  document.getElementById("emptyList").style.display = visible.length ? "none" : "block";
}

function renderNoteCard(note) {
  const template = document.getElementById("noteCardTemplate");
  const card = template.content.firstElementChild.cloneNode(true);
  card.querySelector(".item-meta").textContent = formatNoteLocation(note);
  card.querySelector(".item-title").textContent = note.title;
  card.querySelector(".date-badge").textContent = formatDate(new Date(note.nextReviewAt));
  card.querySelector(".memo").textContent = `推定定着率 ${Math.round(estimateRetention(note) * 100)}%${note.memo ? "\n" + note.memo : ""}`;
  card.querySelector(".review-now").addEventListener("click", () => {
    showScreen("today");
    document.getElementById("reviewQueue").innerHTML = "";
    document.getElementById("reviewQueue").append(renderReviewCard(note, estimateRetention(note)));
    document.getElementById("emptyToday").style.display = "none";
  });
  card.querySelector(".delete").addEventListener("click", async () => {
    if (!confirm(`${formatNoteLocation(note)} ${note.title} を削除しますか？`)) return;
    const logs = (await getAll(LOG_STORE)).filter((log) => log.noteItemId === note.id);
    await Promise.all(logs.map((log) => remove(LOG_STORE, log.id)));
    await remove(NOTE_STORE, note.id);
    await refresh();
    toast("削除しました");
  });
  return card;
}

async function completeReview(note, rating, practiceType) {
  const now = new Date();
  const previousReviewAt = await getPreviousReviewAt(note);
  const elapsedDays = Math.max(0.25, daysBetween(new Date(previousReviewAt), now));
  const retention = estimateRetention(note, now);
  const stabilityBefore = Math.max(0.5, Number(note.stability || 1));
  const stabilityAfter = calculateNewStability(stabilityBefore, elapsedDays, rating);
  const nextInterval = stabilityAfter * Math.log(settings.targetRetention) / Math.log(0.9);
  const nextReviewAt = addDays(now, Math.max(0.5, nextInterval));

  const updated = {
    ...note,
    stability: round(stabilityAfter, 3),
    nextReviewAt: nextReviewAt.toISOString(),
    updatedAt: now.toISOString()
  };
  const log = {
    id: crypto.randomUUID(),
    noteItemId: note.id,
    reviewedAt: now.toISOString(),
    elapsedDays: round(elapsedDays, 3),
    practiceType,
    selfRating: rating,
    estimatedRetention: round(retention, 3),
    stabilityBefore: round(stabilityBefore, 3),
    stabilityAfter: round(stabilityAfter, 3),
    nextReviewAt: nextReviewAt.toISOString()
  };

  await put(NOTE_STORE, updated);
  await put(LOG_STORE, log);
  await refresh();
  toast(`次回は ${formatDate(nextReviewAt)} です`);
}

async function getPreviousReviewAt(note) {
  const logs = (await getAll(LOG_STORE)).filter((log) => log.noteItemId === note.id);
  if (!logs.length) return note.firstStudiedAt || note.createdAt;
  logs.sort((a, b) => new Date(b.reviewedAt) - new Date(a.reviewedAt));
  return logs[0].reviewedAt;
}

function calculateNewStability(stabilityOld, elapsedDays, rating) {
  const p = RATING_RETENTION[rating];
  const observed = p >= 0.97 && elapsedDays < 0.5
    ? stabilityOld
    : elapsedDays * Math.log(0.9) / Math.log(p);
  const base = 0.7 * stabilityOld + 0.3 * Math.max(0.5, observed);
  if (rating <= 2) return Math.max(0.5, base * 0.6);
  if (rating === 3) return base * 1.2;
  if (rating === 4) return base * 1.8;
  return base * 2.5;
}

function estimateRetention(note, at = new Date()) {
  const stability = Math.max(0.5, Number(note.stability || 1));
  const elapsed = Math.max(0, daysBetween(new Date(note.updatedAt || note.createdAt), at));
  return Math.pow(0.9, elapsed / stability);
}

function choosePracticeType(note, retention) {
  const types = note.preferredPracticeTypes?.length ? note.preferredPracticeTypes : PRACTICE_TYPES;
  if (retention < 0.65 && types.includes("用語再生")) return "用語再生";
  if (retention < 0.8 && types.includes("説明再生")) return "説明再生";
  if (retention > 0.9 && types.includes("白紙再現")) return "白紙再現";
  return types[Math.floor(Math.random() * types.length)];
}

async function exportJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    version: 2,
    settings,
    notes: (await getAll(NOTE_STORE)).map(normalizeNote),
    reviewLogs: (await getAll(LOG_STORE)).map(normalizeReviewLog)
  };
  download(`note-review-backup-${toDateInput(new Date())}.json`, JSON.stringify(payload, null, 2), "application/json");
}

async function importJson(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const normalized = normalizeBackupPayload(payload);
    if (!normalized) {
      toast("復元できないJSONです");
      return;
    }
    await Promise.all(normalized.notes.map((note) => put(NOTE_STORE, note)));
    await Promise.all(normalized.reviewLogs.map((log) => put(LOG_STORE, log)));
    if (normalized.settings) {
      settings = { ...settings, ...normalized.settings };
      await saveSettings();
    }
    await refresh();
    toast("JSONから復元しました");
  } catch (error) {
    console.error(error);
    toast("復元できないJSONです");
  }
  event.target.value = "";
}

function exportIcs() {
  const now = new Date();
  const until = addDays(now, 30);
  const events = notes
    .filter((note) => new Date(note.nextReviewAt) <= until)
    .sort((a, b) => new Date(a.nextReviewAt) - new Date(b.nextReviewAt))
    .map((note) => createIcsEvent(note));

  if (!events.length) {
    toast("30日以内の復習予定がありません");
    return;
  }

  const content = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Note Review PWA//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events,
    "END:VCALENDAR"
  ].join("\r\n");
  download(`note-review-calendar-${toDateInput(now)}.ics`, content, "text/calendar");
}

function createIcsEvent(note) {
  const start = withTime(new Date(note.nextReviewAt), settings.calendarTime);
  const end = new Date(start.getTime() + 20 * 60 * 1000);
  const retention = Math.round(estimateRetention(note, start) * 100);
  const practiceType = choosePracticeType(note, retention / 100);
  const title = `復習: ${formatNoteLocation(note)} ${note.title}`;
  const body = `${practiceType}。紙ノートを閉じて先に自力で思い出す。推定定着率 ${retention}%。`;
  return [
    "BEGIN:VEVENT",
    `UID:${note.id}-${yyyymmdd(start)}@note-review-pwa`,
    `DTSTAMP:${toIcsDate(new Date())}`,
    `DTSTART:${toIcsDate(start)}`,
    `DTEND:${toIcsDate(end)}`,
    `SUMMARY:${escapeIcs(title)}`,
    `DESCRIPTION:${escapeIcs(body)}`,
    "BEGIN:VALARM",
    "TRIGGER:PT0M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeIcs(title)}`,
    "END:VALARM",
    "END:VEVENT"
  ].join("\r\n");
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").then((registration) => {
    registration.addEventListener("updatefound", () => {
      const newWorker = registration.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          toast("新しいバージョンがあります。再読み込みしてください");
        }
      });
    });
  }).catch(() => {});
}

function normalizeNote(note) {
  const now = new Date().toISOString();
  const id = note.id || stableNoteId(note);
  const createdAt = safeIso(note.createdAt, now);
  const updatedAt = safeIso(note.updatedAt, createdAt);
  const firstStudiedAt = safeIso(note.firstStudiedAt, createdAt);
  return {
    ...note,
    id,
    subject: String(note.subject || ""),
    notebookName: String(note.notebookName || ""),
    number: String(note.number || ""),
    title: String(note.title || "無題"),
    firstStudiedAt,
    memo: String(note.memo || ""),
    preferredPracticeTypes: normalizePracticeTypes(note.preferredPracticeTypes),
    stability: Math.max(0.5, Number(note.stability || 1)),
    nextReviewAt: safeIso(note.nextReviewAt, startOfDay(new Date()).toISOString()),
    createdAt,
    updatedAt
  };
}

function stableNoteId(note) {
  const source = [note.subject, note.notebookName, note.number, note.title].filter(Boolean).join("|");
  return "legacy-" + hashString(source);
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function normalizeReviewLog(log) {
  const now = new Date().toISOString();
  return {
    ...log,
    id: log.id || crypto.randomUUID(),
    noteItemId: log.noteItemId || log.noteId || "",
    reviewedAt: safeIso(log.reviewedAt, now),
    elapsedDays: Math.max(0, Number(log.elapsedDays || 0)),
    practiceType: PRACTICE_TYPES.includes(log.practiceType) ? log.practiceType : "説明再生",
    selfRating: clamp(Number(log.selfRating ?? 3), 0, 5),
    estimatedRetention: clamp(Number(log.estimatedRetention ?? 0.8), 0, 1),
    stabilityBefore: Math.max(0.5, Number(log.stabilityBefore || 1)),
    stabilityAfter: Math.max(0.5, Number(log.stabilityAfter || 1)),
    nextReviewAt: safeIso(log.nextReviewAt, now)
  };
}

function normalizeBackupPayload(payload) {
  const rawNotes = Array.isArray(payload?.notes)
    ? payload.notes
    : Array.isArray(payload)
      ? payload
      : null;
  if (!rawNotes) return null;
  const notes = rawNotes.map(normalizeNote);
  const idMap = new Map();
  rawNotes.forEach((raw, index) => {
    const normalized = notes[index];
    if (!raw.id) {
      idMap.set(stableNoteId(raw), normalized.id);
    }
  });
  const reviewLogs = Array.isArray(payload?.reviewLogs)
    ? payload.reviewLogs.map((log) => {
        const normalized = normalizeReviewLog(log);
        if (log.noteItemId && idMap.has(log.noteItemId)) {
          normalized.noteItemId = idMap.get(log.noteItemId);
        }
        return normalized;
      })
    : [];
  return {
    settings: payload?.settings || null,
    notes,
    reviewLogs
  };
}

function normalizePracticeTypes(types) {
  if (!Array.isArray(types)) return ["用語再生", "説明再生"];
  const valid = types.filter((type) => PRACTICE_TYPES.includes(type));
  return valid.length ? valid : ["用語再生", "説明再生"];
}

function renderNotebookOptions() {
  const host = document.getElementById("notebookNameOptions");
  host.innerHTML = "";
  uniqueNotebookNames().forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    host.append(option);
  });
}

function renderSubjectFilter() {
  const select = document.getElementById("subjectFilter");
  const current = select.value;
  select.innerHTML = '<option value="">すべての教科</option>';
  uniqueSubjects().forEach((subject) => {
    const option = document.createElement("option");
    option.value = subject;
    option.textContent = subject;
    select.append(option);
  });
  select.value = uniqueSubjects().includes(current) ? current : "";
}

function renderNotebookFilter() {
  const select = document.getElementById("notebookFilter");
  const current = select.value;
  const subjectFilter = document.getElementById("subjectFilter").value;
  const names = subjectFilter ? uniqueNotebookNamesForSubject(subjectFilter) : uniqueNotebookNames();
  select.innerHTML = '<option value="">すべてのノート</option>';
  names.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  });
  select.value = names.includes(current) ? current : "";
}

function renderNotebookChips() {
  const host = document.getElementById("notebookNameChips");
  const subject = document.getElementById("subjectInput").value.trim();
  const current = document.getElementById("notebookNameInput").value.trim();
  const names = subject ? uniqueNotebookNamesForSubject(subject) : uniqueNotebookNames();
  host.innerHTML = "";
  names.forEach((name) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (name === current ? " active" : "");
    chip.textContent = name;
    chip.addEventListener("click", () => {
      document.getElementById("notebookNameInput").value = name;
      renderNotebookChips();
    });
    host.append(chip);
  });
}

function formatNoteLocation(note) {
  return [note.subject, note.notebookName, note.number].filter(Boolean).join(" / ");
}

function uniqueSubjects() {
  return [...new Set(notes.map((note) => note.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
}

function uniqueNotebookNames() {
  return [...new Set(notes.map((note) => note.notebookName).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
}

function uniqueNotebookNamesForSubject(subject) {
  return [...new Set(notes.filter((note) => note.subject === subject).map((note) => note.notebookName).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
}

function safeIso(value, fallback) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function avg(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function daysBetween(start, end) {
  return (end - start) / 86400000;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function withTime(date, time) {
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours || 0, minutes || 0);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short" }).format(date);
}

function toDateInput(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function toIcsDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function yyyymmdd(date) {
  return toIcsDate(date).slice(0, 8);
}

function escapeIcs(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function toast(message) {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2600);
}
