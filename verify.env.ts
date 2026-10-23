// Loaded by verify.ts before anything else, and it exists only because
// of the order modules are evaluated in.
//
// src/app.ts reads CORS_ORIGIN once, at import time. An assignment
// written among verify.ts's own imports would be too late -- imports
// are hoisted, so app.ts would already have read an empty string. An
// imported module is not hoisted past another import, so putting the
// assignments here and importing this first is what makes them happen
// before app.ts is evaluated.
//
// .env is loaded here too, first, so that a --db run picks up the real
// MONGODB_URI: ||= only fills in a value that is missing.
import "dotenv/config";

process.env.JWT_SECRET ||= "verify-only-secret";

// Offline these two only have to exist. mongoose.connect is replaced in
// stubModels(), and the origin just has to match what the CORS checks
// send.
process.env.MONGODB_URI ||= "mongodb://127.0.0.1:27017/verify-offline";
process.env.CORS_ORIGIN ||= "http://localhost:5173";

// Session 11. Offline, Gemini is faked by verify.ts (see fakeGemini),
// so the key only has to be present. --gemini sends the AI checks to
// the real Gemini instead, with the key from your own .env.
process.env.GEMINI_API_KEY ||= "verify-only-key";
