import { getRequestListener } from "@hono/node-server";
import app from "../apps/api/src/index";

// Build Output API function with the Node.js launcher (shouldAddHelpers).
// The launcher invokes a Node (req, res) handler — convert Hono's fetch handler
// to a Node request listener via @hono/node-server.
export default getRequestListener(app.fetch);
