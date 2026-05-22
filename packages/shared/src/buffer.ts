import DataUriParser from "datauri/parser.js";
import path from "path";

const parser = new DataUriParser();

export const getBuffer = (file: any) => {
  const ext = path.extname(file.originalname).toLowerCase();
  return parser.format(ext, file.buffer);
};
