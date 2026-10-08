# itelect4-backend — end of Session 10

ITELECT4 Session 10 — the Session 9 API with a third resource, deployed
to Vercel, and locked down to one origin.

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
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run verify` | 84 assertions, offline. `npx tsx verify.ts --db` runs the same suite against a real database. |

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

Set three environment variables in the Vercel project — `MONGODB_URI`,
`JWT_SECRET`, `CORS_ORIGIN` — in **all three** environments, and add
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

## verify.ts

Replays every "Try it" card from the Session 10 console against the
real app. Offline it runs the real Express app, routes, middleware,
schemas and transforms, and serves only the model calls that would
reach MongoDB from memory.

`verify.env.ts` sits beside it and is imported first, on purpose:
`src/app.ts` reads `CORS_ORIGIN` at import time, and an assignment
among `verify.ts`'s own imports would be hoisted past it.

84 assertions, all passing. `npx tsx verify.ts --db` runs the same
suite against a real database, which is the only way to check the
unique index and what MongoDB actually returns.
