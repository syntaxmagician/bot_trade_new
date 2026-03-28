/**
 * Muat daemon/.env ke process.env (tanpa override variabel yang sudah di-set di shell).
 * Harus di-import pertama di entry script sebelum koneksi RPC dibuat.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });
