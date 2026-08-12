const chatContainer = document.getElementById("chat-container");
const conversation = document.querySelector(".conversation");
const emptyState = document.getElementById("empty-state");
const messageForm = document.getElementById("message-form");
const userInput = document.getElementById("user-input");
const modeButtons = [...document.querySelectorAll(".mode-button")];
const newChatBtn = document.getElementById("new-chat-btn");
const rebuildVectorstoreBtn = document.getElementById("rebuild-vectorstore-btn");
const sendButton = document.getElementById("send-btn");
const statusMessage = document.getElementById("status-message");
const refreshHealthBtn = document.getElementById("refresh-health-btn");
const apiStatusDot = document.getElementById("api-status-dot");
const apiStatusText = document.getElementById("api-status-text");
const ragStatus = document.getElementById("rag-status");
const assistantStatus = document.getElementById("assistant-status");
const feedbackStatus = document.getElementById("feedback-status");
const welcomeEyebrow = document.getElementById("welcome-eyebrow");
const welcomeTitle = document.getElementById("welcome-title");
const welcomeDescription = document.getElementById("welcome-description");

const BASE_URL = (process.env.API_ENDPOINT || "http://127.0.0.1:8000").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_STORED_MESSAGES = 300;
const MODE_COPY = {
  rag: { eyebrow: "MANUAL SEARCH", title: "무엇을 도와드릴까요?", description: "제품 매뉴얼에서 필요한 내용을 찾아, 이해하기 쉬운 답변으로 정리해 드립니다.", placeholder: "제품에 관해 질문해 주세요" },
  assistant: { eyebrow: "AI ASSISTANT", title: "맥락을 이어서 도와드릴게요.", description: "이전 대화를 기억하는 AI Assistant에게 제품 사용 경험 전반을 편하게 물어보세요.", placeholder: "Assistant에게 질문해 보세요" },
};

let db;
let isSending = false;
let storageAvailable = true;
let activeMode = "rag";
let serviceHealth = null;
let isRebuildingVectorstore = false;
let vectorstorePollTimer = null;

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("manualAiChatDB", 1);
    request.onupgradeneeded = ({ target }) => {
      db = target.result;
      if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("metadata")) db.createObjectStore("metadata", { keyPath: "key" });
    };
    request.onsuccess = ({ target }) => { db = target.result; resolve(); };
    request.onerror = () => reject(request.error);
  });
}
const dbReady = initDB();

function runTransaction(storeNames, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    action(transaction);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
function saveMetadata(key, value) { return runTransaction("metadata", "readwrite", tx => tx.objectStore("metadata").put({ key, value })); }
function getMetadata(key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction("metadata", "readonly").objectStore("metadata").get(key);
    request.onsuccess = () => resolve(request.result?.value ?? null);
    request.onerror = () => reject(request.error);
  });
}
function saveMessage(role, content, mode, extra = {}) {
  return runTransaction("chats", "readwrite", tx => {
    const store = tx.objectStore("chats");
    store.add({ role, content, mode, createdAt: Date.now(), ...extra });
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      let excess = countRequest.result - MAX_STORED_MESSAGES;
      if (excess < 1) return;
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => { const cursor = cursorRequest.result; if (!cursor || excess < 1) return; cursor.delete(); excess -= 1; cursor.continue(); };
    };
  });
}
function getAllMessages() {
  return new Promise((resolve, reject) => {
    const request = db.transaction("chats", "readonly").objectStore("chats").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function saveFeedbackRating(requestId, rating) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("chats", "readwrite");
    const store = transaction.objectStore("chats");
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      if (cursor.value.requestId === requestId) {
        cursor.update({ ...cursor.value, feedbackRating: rating });
        return;
      }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
function clearAllData() { return runTransaction(["chats", "metadata"], "readwrite", tx => { tx.objectStore("chats").clear(); tx.objectStore("metadata").clear(); }); }

function setStatus(message = "", loading = false) { statusMessage.textContent = message; statusMessage.classList.toggle("loading", loading); }
function scrollToBottom() { requestAnimationFrame(() => { conversation.scrollTop = conversation.scrollHeight; }); }
function autoResize() { userInput.style.height = "auto"; userInput.style.height = `${Math.min(userInput.scrollHeight, 144)}px`; }
function formatTime(timestamp = Date.now()) { return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp); }

function createMessageBubble(content, role = "user", { isError = false, isTyping = false, createdAt, mode = activeMode, sources = [], requestId, feedbackRating } = {}) {
  const article = document.createElement("article");
  article.className = `message ${role}${isError ? " error" : ""}${isTyping ? " typing" : ""}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "assistant" ? "AI" : "ME";
  const contentBox = document.createElement("div");
  contentBox.className = "message-content";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("span");
  name.textContent = role === "assistant" ? (mode === "rag" ? "Manual AI" : "AI Assistant") : "나";
  const time = document.createElement("time");
  time.textContent = isTyping ? "답변 작성 중" : formatTime(createdAt);
  meta.append(name, time);
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (isTyping) {
    bubble.classList.add("typing-bubble");
    bubble.innerHTML = "<span></span><span></span><span></span>";
  } else bubble.textContent = content;
  contentBox.append(meta, bubble);
  if (role === "assistant" && !isTyping && !isError && sources.length) {
    const citations = document.createElement("details");
    citations.className = "citations";
    const summary = document.createElement("summary");
    summary.textContent = `매뉴얼 근거 ${sources.length}개 보기`;
    const sourceList = document.createElement("div");
    sourceList.className = "source-list";
    sources.forEach(source => {
      const item = document.createElement("div");
      item.className = "source-item";
      const title = document.createElement("strong");
      title.textContent = source.page ? `${source.title} · ${source.page}쪽` : source.title;
      const excerpt = document.createElement("p");
      excerpt.textContent = source.excerpt || "관련 매뉴얼 내용을 참고했습니다.";
      item.append(title, excerpt);
      sourceList.append(item);
    });
    citations.append(summary, sourceList);
    contentBox.append(citations);
  }
  if (role === "assistant" && !isTyping && !isError) {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const copy = document.createElement("button");
    copy.className = "copy-button";
    copy.type = "button";
    copy.textContent = "답변 복사";
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(content); copy.textContent = "복사됨"; setTimeout(() => { copy.textContent = "답변 복사"; }, 1300); }
      catch { setStatus("답변을 복사하지 못했습니다."); }
    });
    actions.append(copy);
    if (requestId) {
      const feedback = document.createElement("span");
      feedback.className = "feedback-actions";
      feedback.setAttribute("aria-label", "답변 평가");
      [["up", "도움돼요", "👍"], ["down", "개선이 필요해요", "👎"]].forEach(([rating, label, icon]) => {
        const button = document.createElement("button");
        button.className = "feedback-button";
        button.type = "button";
        button.dataset.rating = rating;
        button.title = label;
        button.setAttribute("aria-label", label);
        button.textContent = icon;
        if (feedbackRating) {
          button.disabled = true;
          button.classList.toggle("selected", feedbackRating === rating);
        }
        button.addEventListener("click", () => submitFeedback({ requestId, rating, mode, feedback }));
        feedback.append(button);
      });
      actions.append(feedback);
    }
    contentBox.append(actions);
  }
  article.append(avatar, contentBox);
  return article;
}

async function submitFeedback({ requestId, rating, mode, feedback }) {
  const buttons = [...feedback.querySelectorAll("button")];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const response = await fetch(`${BASE_URL}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, rating, mode }),
    });
    if (!response.ok) throw new Error(await readError(response));
    buttons.forEach(button => button.classList.toggle("selected", button.dataset.rating === rating));
    if (storageAvailable) await saveFeedbackRating(requestId, rating);
    setStatus(rating === "up" ? "피드백 감사합니다." : "개선 의견으로 기록했습니다.");
  } catch (error) {
    buttons.forEach(button => { button.disabled = false; });
    setStatus(error.message || "피드백을 저장하지 못했습니다.");
  }
}

function updateEmptyState() { emptyState.hidden = chatContainer.childElementCount > 0; }
function setSending(nextValue) {
  isSending = nextValue;
  sendButton.disabled = nextValue;
  userInput.disabled = nextValue;
  newChatBtn.disabled = nextValue;
  modeButtons.forEach(button => { button.disabled = nextValue; });
  rebuildVectorstoreBtn.disabled = nextValue || isRebuildingVectorstore;
}
function applyMode(mode, persist = true) {
  activeMode = mode;
  const copy = MODE_COPY[mode];
  welcomeEyebrow.textContent = copy.eyebrow; welcomeTitle.textContent = copy.title; welcomeDescription.textContent = copy.description; userInput.placeholder = copy.placeholder;
  modeButtons.forEach(button => { const selected = button.dataset.mode === mode; button.classList.toggle("active", selected); button.setAttribute("aria-pressed", String(selected)); });
  if (persist && storageAvailable) saveMetadata("active_mode", mode).catch(() => { storageAvailable = false; });
}

async function readError(response) { try { const body = await response.json(); return body.detail || body.error || `요청에 실패했습니다 (${response.status}).`; } catch { return `요청에 실패했습니다 (${response.status}).`; } }
function setVectorstoreRebuildState(rebuilding) {
  isRebuildingVectorstore = rebuilding;
  rebuildVectorstoreBtn.disabled = rebuilding || isSending;
  rebuildVectorstoreBtn.classList.toggle("building", rebuilding);
  rebuildVectorstoreBtn.querySelector("span").textContent = rebuilding ? "생성 중" : "인덱스 생성";
}
function renderVectorstoreBuildStatus(build) {
  if (build.status === "running") {
    setVectorstoreRebuildState(true);
    setStatus(build.detail || "매뉴얼을 읽고 벡터 스토어를 생성하고 있습니다…", true);
    return true;
  }
  setVectorstoreRebuildState(false);
  if (build.status === "completed") {
    const chunkInfo = build.chunk_count ? ` (${build.chunk_count}개 청크)` : "";
    setStatus(`벡터 스토어 생성이 완료되었습니다${chunkInfo}.`);
    checkHealth();
  } else if (build.status === "failed") {
    setStatus(build.detail || "벡터 스토어 생성에 실패했습니다.");
  }
  return false;
}
async function pollVectorstoreBuild() {
  window.clearTimeout(vectorstorePollTimer);
  try {
    const response = await fetch(`${BASE_URL}/vectorstore/rebuild`);
    if (!response.ok) throw new Error(await readError(response));
    const build = await response.json();
    if (renderVectorstoreBuildStatus(build)) vectorstorePollTimer = window.setTimeout(pollVectorstoreBuild, 2_000);
  } catch (error) {
    setVectorstoreRebuildState(false);
    setStatus(error.message || "벡터 스토어 작업 상태를 확인하지 못했습니다.");
  }
}
async function startVectorstoreBuild() {
  if (isSending || isRebuildingVectorstore) return;
  const confirmed = window.confirm("현재 매뉴얼 PDF로 벡터 스토어를 다시 생성할까요? 완료되면 새 인덱스가 즉시 매뉴얼 검색에 적용됩니다.");
  if (!confirmed) return;
  setVectorstoreRebuildState(true);
  setStatus("벡터 스토어 생성을 시작하고 있습니다…", true);
  try {
    const response = await fetch(`${BASE_URL}/vectorstore/rebuild`, { method: "POST" });
    if (!response.ok) throw new Error(await readError(response));
    renderVectorstoreBuildStatus(await response.json());
    vectorstorePollTimer = window.setTimeout(pollVectorstoreBuild, 1_000);
  } catch (error) {
    setVectorstoreRebuildState(false);
    setStatus(error.message || "벡터 스토어 생성을 시작하지 못했습니다.");
  }
}
function paintCapability(element, ready) { element.textContent = ready ? "사용 가능" : "준비 안 됨"; element.className = ready ? "online" : "offline"; }
async function checkHealth() {
  refreshHealthBtn.classList.add("spinning");
  apiStatusDot.className = "status-dot checking"; apiStatusText.textContent = "연결 상태 확인 중";
  try {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 7_000);
    const response = await fetch(`${BASE_URL}/health`, { signal: controller.signal }); clearTimeout(timeout);
    if (!response.ok) throw new Error();
    serviceHealth = await response.json();
    apiStatusDot.className = "status-dot online"; apiStatusText.textContent = "API 연결됨";
    paintCapability(ragStatus, serviceHealth.rag_ready); paintCapability(assistantStatus, serviceHealth.assistant_ready); paintCapability(feedbackStatus, serviceHealth.feedback_ready);
    modeButtons.forEach(button => {
      const ready = button.dataset.mode === "rag" ? serviceHealth.rag_ready : serviceHealth.assistant_ready;
      button.disabled = isSending || !ready;
    });
    if (!(activeMode === "rag" ? serviceHealth.rag_ready : serviceHealth.assistant_ready)) {
      const available = serviceHealth.rag_ready ? "rag" : serviceHealth.assistant_ready ? "assistant" : null;
      if (available) applyMode(available);
    }
  } catch {
    serviceHealth = null; apiStatusDot.className = "status-dot offline"; apiStatusText.textContent = "API에 연결할 수 없음";
    ragStatus.textContent = "연결 실패"; ragStatus.className = "offline"; assistantStatus.textContent = "연결 실패"; assistantStatus.className = "offline"; feedbackStatus.textContent = "연결 실패"; feedbackStatus.className = "offline";
    modeButtons.forEach(button => { button.disabled = isSending; });
  } finally { refreshHealthBtn.classList.remove("spinning"); }
}

async function getResponse(message) {
  const endpoint = activeMode === "assistant" ? "/assistant" : "/chat";
  const payload = { message };
  if (activeMode === "assistant" && storageAvailable) {
    const threadId = await getMetadata("assistant_thread_id"); if (threadId) payload.thread_id = threadId;
  }
  const controller = new AbortController(); const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload), signal:controller.signal });
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json();
    if (activeMode === "assistant" && data.thread_id && storageAvailable) await saveMetadata("assistant_thread_id", data.thread_id);
    return data;
  } finally { window.clearTimeout(timeoutId); }
}

async function sendMessage(text = userInput.value.trim()) {
  const message = text.trim(); if (!message || isSending) return;
  try { await dbReady; } catch { storageAvailable = false; }
  const sentMode = activeMode; setSending(true); setStatus(`${sentMode === "rag" ? "매뉴얼을 검색" : "Assistant가 맥락을 확인"}하고 있습니다…`, true);
  chatContainer.append(createMessageBubble(message, "user")); emptyState.hidden = true; userInput.value = ""; autoResize(); scrollToBottom();
  let typing;
  try {
    if (storageAvailable) await saveMessage("user", message, sentMode);
    typing = createMessageBubble("", "assistant", { isTyping:true }); chatContainer.append(typing); scrollToBottom();
    const response = await getResponse(message); typing.remove(); chatContainer.append(createMessageBubble(response.reply, "assistant", { mode: sentMode, sources: response.sources || [], requestId: response.request_id }));
    if (storageAvailable) await saveMessage("assistant", response.reply, sentMode, { sources: response.sources || [], requestId: response.request_id });
  } catch (error) {
    typing?.remove(); const errorText = error.name === "AbortError" ? "응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요." : error.message || "답변을 가져오지 못했습니다.";
    chatContainer.append(createMessageBubble(errorText, "assistant", { isError:true }));
  } finally { setStatus(""); setSending(false); userInput.focus(); scrollToBottom(); }
}

messageForm.addEventListener("submit", event => { event.preventDefault(); sendMessage(); });
userInput.addEventListener("input", autoResize);
userInput.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); messageForm.requestSubmit(); } });
modeButtons.forEach(button => button.addEventListener("click", () => applyMode(button.dataset.mode)));
document.getElementById("suggestion-grid").addEventListener("click", event => { const button = event.target.closest("[data-prompt]"); if (button) sendMessage(button.dataset.prompt); });
refreshHealthBtn.addEventListener("click", checkHealth);
rebuildVectorstoreBtn.addEventListener("click", startVectorstoreBuild);
newChatBtn.addEventListener("click", async () => {
  if (isSending) return;
  if (storageAvailable) { try { await clearAllData(); await saveMetadata("active_mode", activeMode); } catch { storageAvailable = false; } }
  chatContainer.replaceChildren(); updateEmptyState(); setStatus("새 대화를 시작했습니다."); userInput.focus();
});

async function initialize() {
  try {
    await dbReady;
    const savedMode = await getMetadata("active_mode"); if (savedMode && MODE_COPY[savedMode]) applyMode(savedMode, false);
    const messages = await getAllMessages();
    const fragment = document.createDocumentFragment();
    messages.forEach(message => fragment.append(createMessageBubble(message.content, message.role, { createdAt:message.createdAt, mode:message.mode || "rag", sources:message.sources || [], requestId:message.requestId, feedbackRating:message.feedbackRating })));
    chatContainer.append(fragment); updateEmptyState(); scrollToBottom();
  } catch { storageAvailable = false; setStatus("이 브라우저에서는 대화 기록이 저장되지 않습니다."); }
  checkHealth(); pollVectorstoreBuild(); autoResize();
}
initialize();
