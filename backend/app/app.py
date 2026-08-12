import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from typing import Literal, Optional
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from langchain.chains import RetrievalQA
from langchain_community.vectorstores import FAISS
from langchain_upstage import ChatUpstage, UpstageEmbeddings
from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field

load_dotenv()

logger = logging.getLogger(__name__)
BASE_DIR = Path(__file__).resolve().parent.parent
VECTORSTORE_DIR = BASE_DIR / "data" / "vectorstore"
FEEDBACK_LOG_PATH = Path(os.getenv("FEEDBACK_LOG_PATH", str(BASE_DIR / "data" / "feedback.jsonl")))
MAX_MESSAGE_LENGTH = 4_000
MAX_CONCURRENT_REQUESTS = max(1, int(os.getenv("MAX_CONCURRENT_REQUESTS", "4")))
MAX_FEEDBACK_COMMENT_LENGTH = 1_000
feedback_file_lock = Lock()

openai_api_key = os.getenv("OPENAI_API_KEY")
openai_client = AsyncOpenAI(api_key=openai_api_key) if openai_api_key else None
assistant_bot_id = os.getenv("ASSISTANT_BOT_ID")


def build_qa_chain() -> RetrievalQA:
    """Load the local index once, rather than for every chat request."""
    if not VECTORSTORE_DIR.exists():
        raise FileNotFoundError(
            f"Vector store not found at '{VECTORSTORE_DIR}'. Run backend/app/embed.py first."
        )

    # Keep provider initialization here so /health and Assistant mode can boot even
    # when the optional RAG provider is not configured.
    embedding_upstage = UpstageEmbeddings(model="embedding-query")
    chat_upstage = ChatUpstage()
    vectorstore = FAISS.load_local(
        str(VECTORSTORE_DIR),
        embedding_upstage,
        # The index is created locally by embed.py and must be a trusted file.
        allow_dangerous_deserialization=True,
    )
    retriever = vectorstore.as_retriever(
        search_type="mmr",
        search_kwargs={"k": 3, "fetch_k": 12},
    )
    return RetrievalQA.from_chain_type(
        llm=chat_upstage,
        chain_type="stuff",
        retriever=retriever,
        return_source_documents=True,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.qa_chain = None
    app.state.request_semaphore = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)
    try:
        # FAISS loading is disk-bound; do not delay the event loop while starting.
        app.state.qa_chain = await asyncio.to_thread(build_qa_chain)
        logger.info("Local RAG vector store loaded")
    except FileNotFoundError as exc:
        logger.warning("RAG mode is unavailable: %s", exc)
    except Exception:
        logger.exception("RAG mode could not be initialized")
    yield
    if openai_client:
        await openai_client.close()


app = FastAPI(title="Product Manual Chatbot API", version="1.2.0", lifespan=lifespan)

allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOW_ORIGINS",
        "http://localhost:1234,http://127.0.0.1:1234,http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class ChatMessage(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_MESSAGE_LENGTH)


class AssistantRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    message: str = Field(min_length=1, max_length=MAX_MESSAGE_LENGTH)
    thread_id: Optional[str] = Field(default=None, max_length=256)


class ChatRequest(BaseModel):
    """`messages` is retained for old clients; new clients send only `message`."""

    model_config = ConfigDict(str_strip_whitespace=True)

    message: Optional[str] = Field(default=None, min_length=1, max_length=MAX_MESSAGE_LENGTH)
    messages: list[ChatMessage] = Field(default_factory=list, max_length=100)

    def latest_user_message(self) -> Optional[str]:
        if self.message:
            return self.message
        return next((item.content for item in reversed(self.messages) if item.role == "user"), None)


class ChatResponse(BaseModel):
    reply: str
    thread_id: Optional[str] = None
    request_id: str
    sources: list["SourceCitation"] = Field(default_factory=list)


class SourceCitation(BaseModel):
    title: str
    page: Optional[int] = None
    excerpt: Optional[str] = None


class FeedbackRequest(BaseModel):
    """A lightweight quality signal that can be used for RAG evaluation later."""

    model_config = ConfigDict(str_strip_whitespace=True)

    request_id: str = Field(min_length=1, max_length=128)
    rating: Literal["up", "down"]
    mode: Literal["rag", "assistant"]
    comment: Optional[str] = Field(default=None, max_length=MAX_FEEDBACK_COMMENT_LENGTH)


class FeedbackResponse(BaseModel):
    saved: bool


def make_source_citations(documents) -> list[SourceCitation]:
    """Turn LangChain documents into safe, compact UI-facing citations."""
    citations: list[SourceCitation] = []
    seen: set[tuple[str, Optional[int], str]] = set()

    for document in documents or []:
        metadata = document.metadata or {}
        source = str(metadata.get("source") or metadata.get("file_name") or "제품 매뉴얼")
        title = Path(source).stem.replace("_", " ") or "제품 매뉴얼"
        raw_page = metadata.get("page")
        if raw_page is None:
            raw_page = metadata.get("page_number")
        try:
            page = int(raw_page) + 1 if raw_page is not None else None
        except (TypeError, ValueError):
            page = None

        excerpt = " ".join((document.page_content or "").split())[:240]
        key = (title, page, excerpt)
        if not excerpt or key in seen:
            continue
        seen.add(key)
        citations.append(SourceCitation(title=title, page=page, excerpt=excerpt))

    return citations[:3]


def append_feedback(payload: dict) -> None:
    """Append feedback atomically enough for a single-process deployment."""
    FEEDBACK_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with feedback_file_lock, FEEDBACK_LOG_PATH.open("a", encoding="utf-8") as feedback_file:
        feedback_file.write(json.dumps(payload, ensure_ascii=False) + "\n")


def get_assistant_text(messages) -> str:
    for message in messages:
        if message.role != "assistant":
            continue
        for content in message.content:
            if content.type == "text":
                return content.text.value
    return ""


@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(req: ChatRequest, request: Request) -> ChatResponse:
    user_message = req.latest_user_message()
    if not user_message:
        raise HTTPException(status_code=400, detail="No user message provided in the request.")

    qa_chain = request.app.state.qa_chain
    if qa_chain is None:
        raise HTTPException(status_code=503, detail="RAG index is not initialized.")

    try:
        async with request.app.state.request_semaphore:
            # LangChain's invoke is synchronous, so run it away from FastAPI's event loop.
            result = await asyncio.to_thread(qa_chain.invoke, {"query": user_message})
    except Exception:
        logger.exception("RAG response generation failed")
        raise HTTPException(status_code=502, detail="The answer service is temporarily unavailable.")

    reply = result.get("result", "")
    if not reply:
        raise HTTPException(status_code=502, detail="The answer service returned an empty response.")
    return ChatResponse(
        reply=reply,
        request_id=str(uuid4()),
        sources=make_source_citations(result.get("source_documents")),
    )


@app.post("/assistant", response_model=ChatResponse)
async def assistant_endpoint(req: AssistantRequest, request: Request) -> ChatResponse:
    if not openai_client or not assistant_bot_id:
        raise HTTPException(
            status_code=503,
            detail="Assistant mode is disabled. Set OPENAI_API_KEY and ASSISTANT_BOT_ID.",
        )

    try:
        async with request.app.state.request_semaphore:
            if req.thread_id:
                await openai_client.beta.threads.messages.create(
                    thread_id=req.thread_id, role="user", content=req.message
                )
                thread_id = req.thread_id
            else:
                thread = await openai_client.beta.threads.create(
                    messages=[{"role": "user", "content": req.message}]
                )
                thread_id = thread.id

            # assistant_bot_id can be passed directly; retrieving it every request adds latency.
            await openai_client.beta.threads.runs.create_and_poll(
                thread_id=thread_id, assistant_id=assistant_bot_id
            )
            messages = [
                message
                async for message in openai_client.beta.threads.messages.list(thread_id=thread_id)
            ]
    except Exception:
        logger.exception("Assistant response generation failed")
        raise HTTPException(status_code=502, detail="The assistant service is temporarily unavailable.")

    reply = get_assistant_text(messages)
    if not reply:
        raise HTTPException(status_code=502, detail="The assistant returned an empty response.")
    return ChatResponse(reply=reply, thread_id=thread_id, request_id=str(uuid4()))


@app.post("/feedback", response_model=FeedbackResponse, status_code=201)
async def feedback_endpoint(req: FeedbackRequest) -> FeedbackResponse:
    """Store an optional, privacy-conscious answer-quality signal as JSON Lines."""
    payload = {
        "request_id": req.request_id,
        "rating": req.rating,
        "mode": req.mode,
        "comment": req.comment or None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        await asyncio.to_thread(append_feedback, payload)
    except OSError:
        logger.exception("Could not save answer feedback")
        raise HTTPException(status_code=503, detail="Feedback service is temporarily unavailable.")
    return FeedbackResponse(saved=True)


@app.get("/health")
@app.get("/")
async def health_check(request: Request):
    return {
        "status": "ok",
        "rag_ready": request.app.state.qa_chain is not None,
        "assistant_ready": bool(openai_client and assistant_bot_id),
        "feedback_ready": True,
        "api_version": app.version,
    }
