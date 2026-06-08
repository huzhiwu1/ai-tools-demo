import path from "path";
import { fileURLToPath } from "url";

export const COLLECTION_NAME = "ebook";
export const MILVUS_ADDRESS = "localhost:19530";
export const VECTOR_DIM = 1024;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const EPUB_FILE = path.join(__dirname, "../ebook-rag", "天龙八部.epub");

export const CHUNK_SIZE = 500;
export const CHUNK_OVERLAP = 50;
export const BOOKID = 1;
