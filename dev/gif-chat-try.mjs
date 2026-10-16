// dev/gif-chat-try.mjs — print what a !command would reply, without posting it.
//   node --use-system-ca dev/gif-chat-try.mjs staffing   (daemon must be running)
// Needs the same proxy env as the daemon for the Firestore board read:
//   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://proxy.wal-mart.com:8075 NO_PROXY=127.0.0.1
import { createChat } from "./gif-chat.mjs";
import { parseCommand } from "../modules/digitaldashboard/lib/commands.js";
const cmd = parseCommand("!" + (process.argv[2] || "summary")) || "unknown";
const chat = createChat({ port: Number(process.env.GIF_PORT || 8770), log: () => {} });
console.log(await chat.answer(cmd));
