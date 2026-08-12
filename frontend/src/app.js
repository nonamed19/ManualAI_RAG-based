const chatContainer = document.getElementById("chat-container");
const messageForm = document.getElementById("message-form");
const userInput = document.getElementById("user-input");
const apiSelector = document.getElementById("api-selector");
const newChatBtn = document.getElementById("new-chat-btn");
const sendButton = document.getElementById("send-btn");
const statusMessage = document.getElementById("status-message");

const BASE_URL = (process.env.API_ENDPOINT || "http://127.0.0.1:8000").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_STORED_MESSAGES = 300;

let db;
let isSending = false;
let storageAvailable = true;

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("myChatDB", 1);
    request.onupgradeneeded = ({ target }) => {
      db = target.result;
      if (!db.objectStoreNames.contains("chats")) {
        db.createObjectStore("chats", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("metadata")) {
        db.createObjectStore("metadata", { keyPath: "key" });
      }
    };
    request.onsuccess = ({ target }) => {
      db = target.result;
      resolve();
    };
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

async function saveMessage(role, content) {
  await runTransaction("chats", "readwrite", (transaction) => {
    const store = transaction.objectStore("chats");
    store.add({ role, content, createdAt: Date.now() });
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      let excess = countRequest.result - MAX_STORED_MESSAGES;
      if (excess <= 0) return;
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || excess <= 0) return;
        cursor.delete();
        excess -= 1;
        cursor.continue();
      };
    };
  });
}

function getAllMessages() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("chats", "readonly");
    const request = transaction.objectStore("chats").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function saveMetadata(key, value) {
  return runTransaction("metadata", "readwrite", (transaction) => {
    transaction.objectStore("metadata").put({ key, value });
  });
}

function getMetadata(key) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("metadata", "readonly");
    const request = transaction.objectStore("metadata").get(key);
    request.onsuccess = () => resolve(request.result?.value ?? null);
    request.onerror = () => reject(request.error);
  });
}

function clearAllData() {
  return runTransaction(["chats", "metadata"], "readwrite", (transaction) => {
    transaction.objectStore("chats").clear();
    transaction.objectStore("metadata").clear();
  });
}

function createMessageBubble(content, sender = "user", isError = false) {
  const wrapper = document.createElement("article");
  wrapper.className = "mb-6 flex items-start space-x-3";

  const avatar = document.createElement("div");
  avatar.className = `w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center font-bold text-white ${
    sender === "assistant"
      ? "bg-gradient-to-br from-green-400 to-green-600"
      : "bg-gradient-to-br from-blue-500 to-blue-700"
  }`;
  avatar.textContent = sender === "assistant" ? "A" : "U";

  const bubble = document.createElement("div");
  bubble.className = `max-w-full md:max-w-2xl p-3 rounded-lg whitespace-pre-wrap break-words leading-relaxed shadow-sm ${
    sender === "assistant"
      ? isError
        ? "bg-red-50 text-red-800"
        : "bg-gray-200 text-gray-900"
      : "bg-blue-600 text-white"
  }`;
  // textContent keeps restored and remote text from being interpreted as HTML.
  bubble.textContent = content;

  wrapper.append(avatar, bubble);
  return wrapper;
}

function scrollToBottom() {
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function setStatus(message = "") {
  statusMessage.textContent = message;
}

function setSending(nextValue) {
  isSending = nextValue;
  sendButton.disabled = nextValue;
  userInput.disabled = nextValue;
  apiSelector.disabled = nextValue;
  newChatBtn.disabled = nextValue;
  sendButton.textContent = nextValue ? "Sending…" : "Send";
}

async function readError(response) {
  try {
    const body = await response.json();
    return body.detail || body.error || `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}

async function getAssistantResponse(userMessage) {
  const mode = apiSelector.value;
  const url = `${BASE_URL}${mode === "assistant" ? "/assistant" : "/chat"}`;
  const payload = mode === "assistant" ? { message: userMessage } : { message: userMessage };

  if (mode === "assistant") {
    let threadId = null;
    if (storageAvailable) {
      try {
        threadId = await getMetadata("thread_id");
      } catch (error) {
        storageAvailable = false;
        console.warn("Chat storage is unavailable:", error);
      }
    }
    if (threadId) payload.thread_id = threadId;
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await readError(response));

    const data = await response.json();
    if (mode === "assistant" && data.thread_id) {
      try {
        await saveMetadata("thread_id", data.thread_id);
      } catch (error) {
        storageAvailable = false;
        console.warn("Unable to save the Assistant thread:", error);
      }
    }
    return data.reply;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = userInput.value.trim();
  if (!message || isSending) return;

  try {
    await dbReady;
  } catch (error) {
    storageAvailable = false;
    console.error("Unable to open chat storage:", error);
  }

  setSending(true);
  setStatus("답변을 생성하고 있습니다…");
  chatContainer.appendChild(createMessageBubble(message));
  userInput.value = "";
  scrollToBottom();

  try {
    if (storageAvailable) {
      try {
        await saveMessage("user", message);
      } catch (error) {
        storageAvailable = false;
        console.warn("Unable to save the user message:", error);
      }
    }
    const response = await getAssistantResponse(message);
    chatContainer.appendChild(createMessageBubble(response, "assistant"));
    if (storageAvailable) {
      try {
        await saveMessage("assistant", response);
      } catch (error) {
        storageAvailable = false;
        console.warn("Unable to save the assistant message:", error);
      }
    }
  } catch (error) {
    console.error("Error fetching assistant response:", error);
    const message = error.name === "AbortError" ? "응답 시간이 초과되었습니다. 다시 시도해 주세요." : error.message;
    chatContainer.appendChild(createMessageBubble(message, "assistant", true));
  } finally {
    setStatus("");
    setSending(false);
    userInput.focus();
    scrollToBottom();
  }
});

newChatBtn.addEventListener("click", async () => {
  if (isSending) return;
  if (storageAvailable) {
    try {
      await dbReady;
      await clearAllData();
    } catch (error) {
      storageAvailable = false;
      console.warn("Unable to clear chat storage:", error);
    }
  }
  chatContainer.replaceChildren();
  setStatus("새 대화를 시작했습니다.");
  userInput.focus();
});

async function loadExistingMessages() {
  try {
    await dbReady;
    const messages = await getAllMessages();
    const fragment = document.createDocumentFragment();
    for (const message of messages) {
      fragment.appendChild(createMessageBubble(message.content, message.role));
    }
    chatContainer.appendChild(fragment);
    scrollToBottom();
  } catch (error) {
    storageAvailable = false;
    console.error("Unable to restore chat history:", error);
    setStatus("이전 대화를 불러오지 못했습니다.");
  }
}

loadExistingMessages();
