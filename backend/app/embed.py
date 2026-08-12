from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import FAISS
from langchain_upstage import UpstageDocumentParseLoader
from langchain_upstage import UpstageEmbeddings

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
PDF_PATH = DATA_DIR / "Galaxy_A_35.pdf"
VECTORSTORE_DIR = DATA_DIR / "vectorstore"

def create_vectorstore(
    pdf_path: Path = PDF_PATH, vectorstore_dir: Path = VECTORSTORE_DIR
) -> dict[str, Any]:
    """Create a local FAISS index and return a small, UI-safe build summary.

    `vectorstore_dir` is injectable so the API can build into a temporary
    directory before replacing the index currently used by the chat service.
    """
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")

    document_parse_loader = UpstageDocumentParseLoader(
        str(pdf_path),
        output_format="html",
        coordinates=False,
    )
    docs = document_parse_loader.load()

    text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100)
    splits = text_splitter.split_documents(docs)

    # Initializing this client requires UPSTAGE_API_KEY. Keep it here so the
    # FastAPI server can still start and expose health/Assistant endpoints when
    # RAG has not been configured yet.
    embedding_upstage = UpstageEmbeddings(model="embedding-query")
    vectorstore = FAISS.from_documents(splits, embedding_upstage)
    vectorstore_dir.mkdir(parents=True, exist_ok=True)
    vectorstore.save_local(str(vectorstore_dir))
    return {
        "source_file": pdf_path.name,
        "document_count": len(docs),
        "chunk_count": len(splits),
        "vectorstore_dir": str(vectorstore_dir),
    }


def main() -> None:
    print("Embedding start")
    result = create_vectorstore()
    print(
        "Embedding done. "
        f"Saved {result['chunk_count']} chunks to: {result['vectorstore_dir']}"
    )


if __name__ == "__main__":
    main()
