# itelect4-backend — end of Session 11

ITELECT4 Session 11 — the Session 10 API with one more route:
`POST /api/ai`, which sends a project description to Gemini and returns
a structured review.

`itelect4-project` is the React frontend built in Sessions 1–8 and
rewired in Session 10. This is the API it now talks to.

## Run it locally

```
npm install
copy .env.example .env      # macOS/Linux: cp .env.example .env
```

Fill in `.env`:

| Key | What goes in it |
|---|---|
| `MONGODB_URI` | Atlas: `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/itelect4` — or local: `mongodb://127.0.0.1:27017/itelect4` |
| `JWT_SECRET` | Any long random string of your own |
| `CORS_ORIGIN` | Comma-separated origins allowed to read replies. Locally `http://localhost:5173` |
| `GEMINI_API_KEY` | From aistudio.google.com → Get API key. Your own; the quota belongs to the Google project behind it |
| `PORT` | `4000` |

Then:

```
npm run seed        # puts the three courses in. Run once, and after any reset.
npm run dev
```

`API on http://localhost:4000` means it is up. Check it with
`http://localhost:4000/api/health` — `{"ok":true,"db":true}`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | tsx, watching `src/server.ts`. No build step, no type checking. |
| `npm run build` | `tsc`. This is the command the GT is marked against. |
| `npm run start` | Plain Node on `dist/server.js`. Needs `build` to have run. |
| `npm run seed` | Writes the three courses. Safe to run twice. |
| `npm run try-ai` | One real Gemini request from the terminal, through the same function the route uses. Proves the key, the model name and the schema. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run verify` | 144 assertions, offline, with Gemini faked. `--db` uses a real database; `--gemini` sends the AI checks to the real Gemini. |

## What Session 11 added

| File | Why |
|---|---|
| `src/schemas/review.ts` | Two Zod schemas: what a client may send (`prompt`, 20–2000 characters after trimming) and what Gemini must send back. The second one is used three ways — `z.infer` for the `Review` type, `z.toJSONSchema` for the schema sent to Gemini, and `safeParse` to check the reply. |
| `src/ai/prompt.ts` | The model name, the system prompt, and two few-shot examples typed as `Review`. |
| `src/ai/gemini.ts` | The client (made on first use, like `connectDB`), the five-turn conversation, and `reviewProject()`, which refuses a reply that is not JSON or does not match the schema. |
| `src/routes/ai.ts` | `POST /api/ai`: `requireAuth`, a limit of five a minute per account, the request schema, and Gemini's failures turned into 429 or 502 with this API's own sentence. |
| `src/try-ai.ts` | `npm run try-ai`. |

and changed two: `src/app.ts` mounts the router, and `.env.example` has `GEMINI_API_KEY`.

No temperature is set: Google's guide for the Gemini 3 models recommends leaving it at its default of 1.0.

## What Session 10 added

| File | Why |
|---|---|
| `src/models/Course.ts` | The third Session 1 interface, as a schema. The frontend has read courses since Session 7 and the API had none. |
| `src/routes/courses.ts` | `GET /api/courses` and `GET /api/courses/:code`. The only two public routes in the project — there is no `requireAuth` in that file, on purpose. |
| `src/data/courses.ts` | The three courses, as data. Reference data: nobody creates one through the API. |
| `src/seed.ts` | `npm run seed`. Upserts by code, so running it twice leaves three courses. |

and changed four:

| File | What changed |
|---|---|
| `src/types/index.ts` | `CourseDoc`. A `Pick` and not `= Course`, because Mongoose's `toJSON` transform wants a mapped type and an interface is not one. |
| `src/config/db.ts` | The connection promise is kept, so many requests share one connection — and cleared on failure, so a rejected one is not remembered for ever. |
| `src/app.ts` | An origin allowlist instead of bare `cors()`, a middleware that awaits the connection in front of every route, and `export default app` — which is the whole of the deployment configuration. |
| `src/server.ts` | Listens without waiting for Atlas, and logs a failed connection instead of exiting. |

## Deploying it

There is no `vercel.json` and none is needed. Vercel looks for an
Express app at `app`, `index` or `server`, at the root or in `src`, and
`src/app.ts` exports one as its default.

Set four environment variables in the Vercel project — `MONGODB_URI`,
`JWT_SECRET`, `CORS_ORIGIN`, `GEMINI_API_KEY` — in **all three** environments, and add
`0.0.0.0/0` to the Atlas IP access list: Vercel's addresses change per
request, so the entry from Session 9 matches nothing.

An environment variable is read when the app starts. Changing one in
the dashboard does nothing until you redeploy.

## Routes

| Method and path | Token? | Answers |
|---|---|---|
| `GET /api/health` | No | `{ ok, db }` |
| `GET /api/courses` | No | Every course, sorted by code |
| `GET /api/courses/:code` | No | One course, or 404 |
| `POST /api/auth/register` | No | 201 and the new user, or 409 |
| `POST /api/auth/login` | No | 200 and a token, or 401 |
| `GET /api/submissions` | Yes | This token's rows, newest first |
| `GET /api/submissions/:id` | Yes | One row, or 404 |
| `POST /api/submissions` | Yes | 201 and the row |
| `PATCH /api/submissions/:id` | Yes | 200 and the row after the change |
| `DELETE /api/submissions/:id` | Yes | 204, no body |
| `POST /api/ai` | Yes | 200 and `{ summary, strengths, improvements, readiness }`; 400, 429 or 502 otherwise |

## verify.ts

Replays every "Try it" card from the Session 10 and 11 consoles against
the real app. Offline it runs the real Express app, routes, middleware,
schemas and transforms, and serves only the model calls that would
reach MongoDB from memory.

`verify.env.ts` sits beside it and is imported first, on purpose:
`src/app.ts` reads `CORS_ORIGIN` at import time, and an assignment
among `verify.ts`'s own imports would be hoisted past it.

144 assertions, all passing. Gemini is faked by intercepting `fetch` to
Google's host, so the checks read exactly what the SDK sends — the five
turns, the system instruction, the JSON Schema — and replay quota errors,
bad keys and malformed replies. `npx tsx verify.ts --gemini` sends the AI
checks to the real Gemini instead (two requests from your quota). `npx tsx verify.ts --db` runs the same
suite against a real database, which is the only way to check the
unique index and what MongoDB actually returns.
