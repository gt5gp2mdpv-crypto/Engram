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
  pushServerUrl: "",
  morningTime: "07:00",
  eveningTime: "20:00"
};
let pushSubscription = null;

document.addEventListener("DOMContentLoaded", async () => {
  db = await openDb();
  await loadSettings();
  setupStaticUi();
  await refresh();
  registerServiceWorker();
  await loadPushSubscription();
  refreshPushStatus();
  syncScheduleToServer();
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
  // 要素取得を安全に行うヘルパー
  function safeGet(id) {
    const el = document.getElementById(id);
    if (!el) console.warn(`要素が見つかりません: #${id}`);
    return el;
  }

  const todayLabel = safeGet("todayLabel");
  if (todayLabel) todayLabel.textContent = formatDate(new Date());

  const firstStudiedInput = safeGet("firstStudiedInput");
  if (firstStudiedInput) firstStudiedInput.value = toDateInput(new Date());

  const pushServerUrlInput = safeGet("pushServerUrl");
  if (pushServerUrlInput) pushServerUrlInput.value = settings.pushServerUrl || "";

  const morningTimeInput = safeGet("morningTime");
  if (morningTimeInput) morningTimeInput.value = settings.morningTime || "07:00";

  const eveningTimeInput = safeGet("eveningTime");
  if (eveningTimeInput) eveningTimeInput.value = settings.eveningTime || "20:00";

  const targetRetentionSelect = safeGet("targetRetention");
  if (targetRetentionSelect) targetRetentionSelect.value = String(settings.targetRetention);

  renderPracticeChecks();
  renderPracticeGuide();

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showScreen(tab.dataset.screen));
  });

  const buildSessionBtn = safeGet("buildSessionBtn");
  if (buildSessionBtn) buildSessionBtn.addEventListener("click", renderToday);

  const sortMode = safeGet("sortMode");
  if (sortMode) sortMode.addEventListener("change", renderList);

  const searchInput = safeGet("searchInput");
  if (searchInput) searchInput.addEventListener("input", renderList);

  const subjectFilter = safeGet("subjectFilter");
  if (subjectFilter) subjectFilter.addEventListener("change", () => {
    renderNotebookFilter();
    renderList();
  });

  const notebookFilter = safeGet("notebookFilter");
  if (notebookFilter) notebookFilter.addEventListener("change", renderList);

  const subjectInput = safeGet("subjectInput");
  if (subjectInput) subjectInput.addEventListener("input", renderNotebookChips);

  const notebookNameInput = safeGet("notebookNameInput");
  if (notebookNameInput) notebookNameInput.addEventListener("input", renderNotebookChips);

  const noteForm = safeGet("noteForm");
  if (noteForm) noteForm.addEventListener("submit", addNote);

  const exportJsonBtn = safeGet("exportJsonBtn");
  if (exportJsonBtn) exportJsonBtn.addEventListener("click", exportJson);

  const importJsonInput = safeGet("importJsonInput");
  if (importJsonInput) importJsonInput.addEventListener("change", importJson);

  if (targetRetentionSelect) targetRetentionSelect.addEventListener("change", async (event) => {
    settings.targetRetention = Number(event.target.value);
    await saveSettings();
    toast("目標定着率を保存しました");
  });

  if (pushServerUrlInput) pushServerUrlInput.addEventListener("change", async (event) => {
    settings.pushServerUrl = event.target.value.trim();
    await saveSettings();
    toast("通知サーバーURLを保存しました");
  });

  if (morningTimeInput) morningTimeInput.addEventListener("change", async (event) => {
    settings.morningTime = event.target.value || "07:00";
    await saveSettings();
    await syncScheduleToServer();
    toast("朝の通知時刻を保存しました");
  });

  if (eveningTimeInput) eveningTimeInput.addEventListener("change", async (event) => {
    settings.eveningTime = event.target.value || "20:00";
    await saveSettings();
    await syncScheduleToServer();
    toast("夜の通知時刻を保存しました");
  });

  const enablePushBtn = safeGet("enablePushBtn");
  if (enablePushBtn) enablePushBtn.addEventListener("click", enablePush);

  const disablePushBtn = safeGet("disablePushBtn");
  if (disablePushBtn) disablePushBtn.addEventListener("click", disablePush);

  const testPushBtn = safeGet("testPushBtn");
  if (testPushBtn) testPushBtn.addEventListener("click", sendTestPush);

  const syncScheduleBtn = safeGet("syncScheduleBtn");
  if (syncScheduleBtn) syncScheduleBtn.addEventListener("click", async () => {
    await syncScheduleToServer(true);
    toast("スケジュールを同期しました");
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
  syncScheduleToServer();
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

// ── Web Push通知 ──

async function loadPushSubscription() {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      pushSubscription = null;
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    pushSubscription = await registration.pushManager.getSubscription();
  } catch (error) {
    console.warn("購読情報の取得に失敗:", error);
    pushSubscription = null;
  }
}

async function enablePush() {
  if (!("Notification" in window)) {
    toast("この端末では通知を利用できません");
    return;
  }
  if (Notification.permission === "denied") {
    toast("Safariの設定で通知を許可してください");
    return;
  }

  // サーバーURLの事前チェック
  const url = settings.pushServerUrl.replace(/\/+$/, "");
  if (!url) {
    toast("先に通知サーバーURLを入力してください");
    return;
  }

  try {
    // iOS 17.4以降では requestPermission() ではダイアログが出ず、
    // pushManager.subscribe() が許可ダイアログを表示する。
    // そのため requestPermission() をスキップして subscribe() に直接進む。
    const registration = await navigator.serviceWorker.ready;
    pushSubscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: await getVapidPublicKey()
    });

    // サーバーに購読登録
    const subscribeResponse = await fetch(`${url}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: pushSubscription,
        schedule: buildSchedule()
      })
    });
    if (!subscribeResponse.ok) {
      throw new Error("購読登録に失敗しました");
    }
    await syncScheduleToServer(true);
    refreshPushStatus();
    toast("通知を設定しました");
  } catch (error) {
    console.error("購読登録に失敗:", error);

    // subscribe() が失敗した場合は古いiOS向けに requestPermission() を試す
    if (Notification.permission === "default" && typeof Notification.requestPermission === "function") {
      try {
        // Promise形式とコールバック形式の両方に対応
        const permission = await new Promise((resolve) => {
          const result = Notification.requestPermission((perm) => resolve(perm));
          if (result && typeof result.then === "function") {
            result.then(resolve).catch(() => resolve("denied"));
          }
        });
        if (permission !== "granted") {
          toast("通知の許可が必要です。Safariの設定で許可してください");
          return;
        }
        // 許可されたら再試行
        const registration = await navigator.serviceWorker.ready;
        pushSubscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: await getVapidPublicKey()
        });
        const retryResponse = await fetch(`${url}/subscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subscription: pushSubscription,
            schedule: buildSchedule()
          })
        });
        if (!retryResponse.ok) {
          throw new Error("購読登録に失敗しました");
        }
        await syncScheduleToServer(true);
        refreshPushStatus();
        toast("通知を設定しました");
        return;
      } catch (retryError) {
        console.error("再試行も失敗:", retryError);
      }
    }

    toast(getPushErrorMessage(error, url));
  }
}

function getPushErrorMessage(error, url) {
  const message = String(error?.message || error || "");
  // CORS/ネットワークエラーの判別
  if (message.includes("Failed to fetch") || message.includes("NetworkError") || message.includes("Network request failed")) {
    return "サーバーに接続できません。\n①Renderで再デプロイしたか ②URLが正しいか を確認してください";
  }
  if (message.includes("vapid") || message.includes("VAPID")) {
    return "VAPIDキーを取得できませんでした。サーバーが正しく再デプロイされているか確認してください";
  }
  if (message.includes("subscription") || message.includes("InvalidStateError")) {
    return "購読登録に失敗しました。もう一度お試しください";
  }
  if (message.includes("NotAllowedError") || message.includes("PermissionDenied")) {
    return "通知が許可されませんでした。Safariの設定で許可してください";
  }
  return message || "サーバーURLを確認してください";
}

async function getVapidPublicKey() {
  const url = settings.pushServerUrl.replace(/\/+$/, "");
  if (!url) throw new Error("サーバーURLが未設定です");
  const response = await fetch(`${url}/vapid-public-key`);
  if (!response.ok) throw new Error("サーバーからVAPIDキーを取得できませんでした");
  const data = await response.json();
  return urlBase64ToUint8Array(data.publicKey);
}

async function disablePush() {
  try {
    if (pushSubscription) {
      if (settings.pushServerUrl) {
        const url = settings.pushServerUrl.replace(/\/+$/, "");
        await fetch(`${url}/unsubscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: pushSubscription })
        }).catch(() => {});
      }
      await pushSubscription.unsubscribe();
    }
    pushSubscription = null;
  } catch (error) {
    console.error("購読解除に失敗:", error);
  }
  refreshPushStatus();
  toast("通知を停止しました");
}

async function sendTestPush() {
  if (!pushSubscription) {
    toast("先に「通知を許可する」を押してください");
    return;
  }
  const url = settings.pushServerUrl.replace(/\/+$/, "");
  if (!url) {
    toast("通知サーバーURLを入力してください");
    return;
  }
  try {
    const response = await fetch(`${url}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: pushSubscription,
        title: "ノート復習",
        body: "これはテスト通知です。設定が正常に完了しています。"
      })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "送信に失敗しました");
    }
    toast("テスト通知を送信しました");
  } catch (error) {
    console.error("テスト送信失敗:", error);
    toast(`テスト通知を送信できませんでした: ${error.message}`);
  }
}

function buildSchedule() {
  const schedule = [];
  const now = new Date();
  const today = startOfDay(now);
  const dueNotes = notes.filter((note) => new Date(note.nextReviewAt) <= endOfDay(now));

  if (!dueNotes.length) return schedule;

  const dueSummary = getDueSummary(dueNotes);

  const morning = withTime(today, settings.morningTime || "07:00");
  if (morning > now) {
    schedule.push({
      time: morning.getTime(),
      title: "📚 今日の復習リマインダー",
      body: dueSummary,
      url: "./"
    });
  }

  const evening = withTime(today, settings.eveningTime || "20:00");
  if (evening > now) {
    schedule.push({
      time: evening.getTime(),
      title: "🌙 今夜の復習リマインダー",
      body: dueSummary,
      url: "./"
    });
  }

  // 翌日以降も2日先まで通知をスケジュール（復習予定がある場合）
  for (let offset = 1; offset <= 2; offset++) {
    const day = addDays(today, offset);
    const dayDue = notes.filter((note) => {
      const next = startOfDay(new Date(note.nextReviewAt));
      return next.getTime() === day.getTime();
    });
    if (!dayDue.length) continue;
    const daySummary = getDueSummary(dayDue);
    const dayMorning = withTime(day, settings.morningTime || "07:00");
    const dayEvening = withTime(day, settings.eveningTime || "20:00");
    schedule.push({
      time: dayMorning.getTime(),
      title: "📚 今日の復習リマインダー",
      body: daySummary,
      url: "./"
    });
    schedule.push({
      time: dayEvening.getTime(),
      title: "🌙 今夜の復習リマインダー",
      body: daySummary,
      url: "./"
    });
  }

  return schedule;
}

function getDueSummary(dueNotes) {
  const limited = dueNotes.slice(0, 5);
  const lines = limited.map((note) => `${formatNoteLocation(note)} ${note.title}`).join("、");
  const remaining = dueNotes.length - limited.length;
  return `今日の復習が${dueNotes.length}件あります。${lines}${remaining > 0 ? ` ほか${remaining}件` : ""}`;
}

async function syncScheduleToServer(force = false) {
  if (!pushSubscription || !settings.pushServerUrl) return;
  const url = settings.pushServerUrl.replace(/\/+$/, "");
  if (!url) return;

  const schedule = buildSchedule();
  try {
    const response = await fetch(`${url}/update-schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: pushSubscription,
        schedule
      })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "同期に失敗しました");
    }
    if (force) {
      const data = await response.json();
      toast(`スケジュールを同期しました（${data.scheduled}件）`);
    }
  } catch (error) {
    console.warn("スケジュール同期に失敗:", error);
  }
}

function refreshPushStatus() {
  const statusText = document.getElementById("pushStatusText");
  const enableBtn = document.getElementById("enablePushBtn");
  const disableBtn = document.getElementById("disablePushBtn");

  if (!("Notification" in window)) {
    statusText.textContent = "この端末では通知を利用できません。";
    enableBtn.style.display = "none";
    return;
  }

  if (Notification.permission === "denied") {
    statusText.textContent = "通知がブロックされています。Safariの設定で許可してください。";
    enableBtn.style.display = "none";
    disableBtn.style.display = "none";
    return;
  }

  if (pushSubscription) {
    statusText.textContent = settings.pushServerUrl
      ? `通知が有効です（${settings.morningTime || "07:00"} / ${settings.eveningTime || "20:00"}）`
      : "通知サーバーURLを入力してください";
    enableBtn.style.display = "none";
    disableBtn.style.display = "";
  } else {
    statusText.textContent = "通知はまだ設定されていません。";
    enableBtn.style.display = "";
    disableBtn.style.display = "none";
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// ── ユーティリティ ──

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