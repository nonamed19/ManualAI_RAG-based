import os
from pathlib import Path
from typing import List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from langchain.chains import RetrievalQA
from langchain_community.vectorstores import FAISS
from langchain_upstage import ChatUpstage, UpstageEmbeddings
from openai import AsyncOpenAI
from pydantic import BaseModel

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
VECTORSTORE_DIR = BASE_DIR / "data" / "vectorstore"

chat_upstage = ChatUpstage()
embedding_upstage = UpstageEmbeddings(model="embedding-query")

openai_api_key = os.getenv("OPENAI_API_KEY")
openai_client = AsyncOpenAI(api_key=openai_api_key) if openai_api_key else None
assistant_bot_id = os.getenv("ASSISTANT_BOT_ID")

qa_chain: Optional[RetrievalQA] = None

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:1234",
        "http://127.0.0.1:1234",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def build_qa_chain() -> RetrievalQA:
    if not VECTORSTORE_DIR.exists():
        raise FileNotFoundError(
            f"Vector store not found at '{VECTORSTORE_DIR}'. Run backend/app/embed.py first."
        )

    vectorstore = FAISS.load_local(
        str(VECTORSTORE_DIR),
        embedding_upstage,
        allow_dangerous_deserialization=True,
    )
    retriever = vectorstore.as_retriever(
        search_type="mmr",
        search_kwargs={"k": 3},
    )
    return RetrievalQA.from_chain_type(
        llm=chat_upstage,
        chain_type="stuff",
        retriever=retriever,
        return_source_documents=False,
    )


@app.on_event("startup")
async def startup_event() -> None:
    global qa_chain
    try:
        qa_chain = build_qa_chain()
    except FileNotFoundError:
        qa_chain = None


class ChatMessage(BaseModel):
    role: str
    content: str


class AssistantRequest(BaseModel):
    message: str
    thread_id: Optional[str] = None


class ChatRequest(BaseModel):
    messages: List[ChatMessage]  # Entire conversation for naive mode


@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    user_message = next(
        (msg.content.strip() for msg in reversed(req.messages) if msg.role == "user" and msg.content.strip()),
        None,
    )

    if not user_message:
        raise HTTPException(status_code=400, detail="No user message provided in the request.")

    if qa_chain is None:
        raise HTTPException(status_code=503, detail="QA chain is not initialized.")

    try:
        result = qa_chain.invoke({"query": user_message})
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to generate response: {exc}") from exc

    return {"reply": result.get("result", "")}


@app.post("/assistant")
async def assistant_endpoint(req: AssistantRequest):
    if not openai_client or not assistant_bot_id:
        raise HTTPException(
            status_code=503,
            detail="Assistant mode is disabled. Set OPENAI_API_KEY and ASSISTANT_BOT_ID.",
        )

    assistant = await openai_client.beta.assistants.retrieve(assistant_bot_id)

    if req.thread_id:
        # We have an existing thread, append user message
        await openai_client.beta.threads.messages.create(
            thread_id=req.thread_id, role="user", content=req.message
        )
        thread_id = req.thread_id
    else:
        # Create a new thread with user message
        thread = await openai_client.beta.threads.create(
            messages=[{"role": "user", "content": req.message}]
        )
        thread_id = thread.id

    # Run and wait until complete
    await openai_client.beta.threads.runs.create_and_poll(
        thread_id=thread_id, assistant_id=assistant.id
    )

    # Now retrieve messages for this thread
    # messages.list returns an async iterator, so let's gather them into a list
    all_messages = [
        m async for m in openai_client.beta.threads.messages.list(thread_id=thread_id)
    ]

    # The assistant's reply should be the last message with role=assistant
    assistant_reply = all_messages[0].content[0].text.value if all_messages else ""

    return {"reply": assistant_reply, "thread_id": thread_id}


@app.get("/health")
@app.get("/")
async def health_check():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)