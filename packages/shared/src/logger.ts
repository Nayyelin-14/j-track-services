import morgan from "morgan";

const logFormat =
  process.env.APP_ENV === "e2e"
    ? ""
    : ":method :url :status :res[content-length] - :response-time ms";

export const requestLogger = morgan(logFormat);
