import fs from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), ".opencode", "logs");
let sessionLogPath: string | null = null;

/**
 * Initializes the session log file. Creates the directory lazily.
 * Returns the path to the session log file.
 */
export function initSessionLog(): string {
  if (sessionLogPath) return sessionLogPath;

  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `art-mcp-plugin-${timestamp}.log`;
    sessionLogPath = path.join(LOG_DIR, fileName);
    
    // Initialize file
    fs.writeFileSync(sessionLogPath, `--- Session Started: ${new Date().toISOString()} ---\n`);
  } catch (error) {
    console.error(`[file-logger] Critical failure initializing logs: ${error}`);
  }

  return sessionLogPath || "";
}

/**
 * Appends a formatted message to the session log file.
 */
export function fileLog(
  message: string, 
  meta?: { sessionID?: string; callID?: string }
): void {
  if (!sessionLogPath) {
    initSessionLog();
  }

  const timestamp = new Date().toISOString();
  const metaStr = meta 
    ? `${meta.sessionID ? `sessionID=${meta.sessionID} ` : ""}${meta.callID ? `callID=${meta.callID} ` : ""}`.trim() 
    : "";
  
  const logLine = `[${timestamp}] ${metaStr ? `[${metaStr}] ` : ""}${message}\n`;

  try {
    fs.appendFileSync(sessionLogPath!, logLine);
  } catch (error) {
    // Fallback to console if file logging fails to avoid losing critical error info
    console.error(`[file-logger] Failed to write to log file: ${error}`);
  }
}
