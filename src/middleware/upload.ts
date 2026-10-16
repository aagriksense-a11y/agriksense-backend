import multer from 'multer';
import { env } from '../config/env';

/** In-memory multipart parsing; files are validated by content sniffing before storage. */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes, files: 1, fields: 30 },
});

export const singleFile = upload.single('file');
