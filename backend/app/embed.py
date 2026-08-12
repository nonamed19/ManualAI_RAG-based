from pathlib import Path

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

embedding_upstage = UpstageEmbeddings(model="embedding-query")


def main() -> None:
    if not PDF_PATH.exists():
        raise FileNotFoundError(f"PDF file not found: {PDF_PATH}")

    print("Embedding start")
    document_parse_loader = UpstageDocumentParseLoader(
        str(PDF_PATH),
        output_format="html",
        coordinates=False,
    )
    docs = document_parse_loader.load()

    text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100)
    splits = text_splitter.split_documents(docs)

    vectorstore = FAISS.from_documents(splits, embedding_upstage)
    VECTORSTORE_DIR.mkdir(parents=True, exist_ok=True)
    vectorstore.save_local(str(VECTORSTORE_DIR))
    print(f"Embedding done. Saved to: {VECTORSTORE_DIR}")


if __name__ == "__main__":
    main()
