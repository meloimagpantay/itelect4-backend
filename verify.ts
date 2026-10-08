/**
 * Replays every "Try it" card from the Session 10 lecture console against
 * the real app, and checks what it claims on screen is what happens.
 *
 *   npx tsx verify.ts          offline  -- no database needed
 *   npx tsx verify.ts --db     full     -- needs MONGODB_URI in .env
 *
 * Offline mode runs the REAL Express app, the REAL routes, the REAL auth
 * middleware, the REAL schemas and the REAL toJSON transforms. Only the
 * five model calls that would talk to MongoDB are served from memory --
 * and even those build genuine Mongoose documents, so validation and
 * casting are the real thing. The one behaviour offline mode cannot
 * prove is MongoDB itself: unique indexes, and whether a query written
 * this way returns what you expect. Run --db before you trust those.
 */
// FIRST, and it has to stay first -- see the comment in that file.
import "./verify.env";
import mongoose, { Types } from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { app } from "./src/app";
import appDefault from "./src/app";
import { User } from "./src/models/User";
import { Course } from "./src/models/Course";
import { Submission } from "./src/models/Submission";
import { COURSES } from "./src/data/courses";
import type { Server } from "node:http";

const LIVE = process.argv.includes("--db");

let pass = 0;
const fails: string[] = [];

function check(name: string, cond: unknown, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${detail ? "  -- " + detail : ""}`);
  }
}

// ---------------------------------------------------------------- offline
// In-memory stand-ins for the five model calls the routes make. Each one
// builds a real Mongoose document, so .validate() and .toJSON() are not
// simulated -- only the trip to the database is.
function stubModels() {
  const users: any[] = [];
  const subs: any[] = [];
  const eq = (a: unknown, b: unknown) => String(a) === String(b);

  // app.ts waits for connectDB() in front of every route now. Offline
  // there is nothing to connect to, so the connect itself is what gets
  // replaced -- readyState stays 0, which is what /api/health reports
  // and what the health check below expects when LIVE is false.
  (mongoose as any).connect = async () => mongoose;

  // The three courses src/seed.ts would have put in.
  const courses = COURSES.map((c) => new Course(c));
  (Course as any).find = () => {
    const sorted = (spec: Record<string, number>) =>
      courses.slice().sort((a: any, b: any) => {
        for (const [key, dir] of Object.entries(spec ?? {})) {
          if (a[key] < b[key]) return dir >= 0 ? -1 : 1;
          if (a[key] > b[key]) return dir >= 0 ? 1 : -1;
        }
        return 0;
      });
    return Object.assign(Promise.resolve(courses), {
      sort: (spec: Record<string, number>) => Promise.resolve(sorted(spec)),
    });
  };
  (Course as any).findOne = async (f: any) =>
    courses.find((c: any) => c.code === f.code) ?? null;

  (User as any).findOne = (f: any) => {
    const hit = users.find((u) => (f.email ? u.email === f.email : eq(u._id, f._id)));
    return Object.assign(Promise.resolve(hit ?? null), {
      select: () => Promise.resolve(hit ?? null),
    });
  };
  (User as any).create = async (data: any) => {
    const doc = new User(data);
    await doc.validate();
    // Run the real pre("save") hooks, so the bcrypt hash in User.ts is
    // what produces the stored password -- not something written here.
    // Mongoose 9's execPre RETURNS a promise; passing a callback as a
    // fourth argument is accepted and then never called.
    await (doc.schema as any).s.hooks.execPre("save", doc, []);
    users.push(doc);
    return doc;
  };

  (Submission as any).create = async (data: any) => {
    const doc = new Submission(data);
    await doc.validate();
    subs.push(doc);
    return doc;
  };
  // The sort() stub used to ignore its argument and hand back insertion
  // order, which meant the offline run could not tell a working sort from
  // a missing one -- and the console now states the order the list comes
  // back in. Apply the spec for real.
  (Submission as any).find = (f: any) => {
    const mine = () => subs.filter((s) => eq(s.studentId, f.studentId));
    const sorted = (spec: Record<string, number>) =>
      mine().sort((a, b) => {
        for (const [key, dir] of Object.entries(spec ?? {})) {
          const av = a[key], bv = b[key];
          if (av < bv) return dir >= 0 ? -1 : 1;
          if (av > bv) return dir >= 0 ? 1 : -1;
        }
        return 0;
      });
    return Object.assign(Promise.resolve(mine()), {
      sort: (spec: Record<string, number>) => Promise.resolve(sorted(spec)),
    });
  };
  // Mongoose casts a query filter before it sends it, and a string that
  // is not an ObjectId throws a CastError there. Calling Mongoose's own
  // cast is what makes the offline run fail in the same way and with the
  // same error class as the real one -- constructing an ObjectId by hand
  // throws a BSONError instead, which the error handler does not catch.
  const castId = (f: any) => (Submission.schema.path("_id") as any).cast(f._id);
  const match = (f: any) =>
    subs.find((s) => eq(s._id, f._id) && eq(s.studentId, f.studentId)) ?? null;
  (Submission as any).findOne = async (f: any) => {
    castId(f);
    return match(f);
  };
  (Submission as any).findOneAndUpdate = async (f: any, body: any) => {
    castId(f);
    const doc = match(f);
    if (!doc) return null;
    doc.set(body);
    await doc.validate();
    return doc;
  };
  (Submission as any).findOneAndDelete = async (f: any) => {
    castId(f);
    const doc = match(f);
    if (doc) subs.splice(subs.indexOf(doc), 1);
    return doc;
  };
}


// ------------------------------------------------------- deployment shape
// The one thing Vercel needs from this repo that nothing else needs: an
// Express app as the DEFAULT export of a file it looks in. There is no
// vercel.json, so if this export ever goes the deployment stops working
// and nothing local would notice.
function deploymentShape() {
  console.log("\nWhat Vercel looks for");
  check("src/app.ts has a default export", appDefault !== undefined);
  check("the default export is the same app the routes were added to",
    appDefault === app);
  check("it is a request handler Node can call",
    typeof appDefault === "function" && appDefault.length >= 2);
}

// validateSync() is deprecated in Mongoose 9, so ask for the error the
// non-deprecated way and hand back the same thing.
async function errOf(doc: any) {
  try {
    await doc.validate();
    return null;
  } catch (e: any) {
    return e;
  }
}

// ------------------------------------------------------------ unit checks
async function offlineUnits() {
  console.log("\nSchemas, hashing and tokens (no database, no server)");

  const okDoc = new Submission({
    studentId: new Types.ObjectId(),
    courseCode: "itelect4",
    repoUrl: "https://github.com/juan/itelect4-backend",
  });
  check("a valid submission passes validation", !(await errOf(okDoc)));
  check("courseCode is upper-cased by the schema", okDoc.courseCode === "ITELECT4");
  check("submittedAt defaults to now", okDoc.submittedAt instanceof Date);

  const bad = new Submission({
    studentId: new Types.ObjectId(),
    courseCode: "ITELECT4",
    repoUrl: "http://gitlab.com/juan/thing",
  });
  const err: any = await errOf(bad);
  check(
    "a non-github repoUrl is rejected by the schema",
    !!err?.errors.repoUrl,
    "the match rule did not fire",
  );
  check(
    "the rejection names the rule",
    /github\.com/.test(err?.errors.repoUrl?.message ?? ""),
  );

  const over = new Submission({
    studentId: new Types.ObjectId(),
    courseCode: "ITELECT4",
    repoUrl: "https://github.com/a/b",
    score: 150,
  });
  check("score above 100 is rejected", !!(await errOf(over))?.errors.score);

  const json = okDoc.toJSON() as Record<string, unknown>;
  check("toJSON renames _id to id", typeof json.id === "string" && !("_id" in json));
  check("toJSON drops __v", !("__v" in json));
  check("id is 24 hex characters", /^[a-f0-9]{24}$/.test(String(json.id)));

  const u = new User({ name: "T", email: "t@e.com", password: "password123" });
  check("password is select:false in the schema", User.schema.path("password").options.select === false);
  check("user toJSON never includes password", !("password" in (u.toJSON() as object)));

  const hash = await bcrypt.hash("password123", 10);
  check("bcrypt hash does not equal the password", hash !== "password123");
  check("the stored hash starts with $2b$ and is 60 characters",
    /^\$2b\$\d\d\$/.test(hash) && hash.length === 60, hash.slice(0, 7) + " len " + hash.length);
  check("the same password hashes differently twice (a random salt)",
    (await bcrypt.hash("password123", 10)) !== hash);
  check("bcrypt compare accepts the right one", await bcrypt.compare("password123", hash));
  check("bcrypt compare rejects the wrong one", !(await bcrypt.compare("nope", hash)));

  const secret = process.env.JWT_SECRET!;
  const tok = jwt.sign({ userId: "abc" }, secret, { expiresIn: "2h" });
  check("a signed token verifies", (jwt.verify(tok, secret) as any).userId === "abc");
  let tampered = false;
  try {
    jwt.verify(tok, "a-different-secret");
  } catch {
    tampered = true;
  }
  check("a token signed with another secret is refused", tampered);
  let expired = false;
  try {
    jwt.verify(jwt.sign({ userId: "a" }, secret, { expiresIn: "-1s" }), secret);
  } catch {
    expired = true;
  }
  check("an expired token is refused", expired);
}

// ------------------------------------------------------------ http checks
async function httpSuite(base: string) {
  const j = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, init);
    const text = await r.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: r.status, body };
  };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const JSONH = { "Content-Type": "application/json" };
  const uniq = Date.now() + "-" + Math.random().toString(16).slice(2);

  console.log(`\nHTTP, against ${base}${LIVE ? "  (real database)" : "  (in-memory models)"}`);

  const health = await j("/api/health");
  check("GET /api/health answers 200", health.status === 200);
  check("health reports the database connection separately",
    health.body?.ok === true && health.body?.db === LIVE,
    `ok=${health.body?.ok} db=${health.body?.db}, connected=${LIVE}`);

  // ---- card: the course list is public
  const courses = await j("/api/courses");
  check("GET /api/courses answers 200 with no token at all",
    courses.status === 200);
  check("all three seeded courses come back",
    Array.isArray(courses.body) && courses.body.length === COURSES.length,
    `got ${Array.isArray(courses.body) ? courses.body.length : courses.body}`);
  check("they are sorted by code",
    (courses.body ?? []).map((c: any) => c.code).join(",")
      === [...COURSES].map((c) => c.code).sort().join(","),
    (courses.body ?? []).map((c: any) => c.code).join(","));
  check("a course carries no _id, no __v and no id either",
    (courses.body ?? []).every((c: any) =>
      !("_id" in c) && !("__v" in c) && !("id" in c) && "code" in c));

  const oneCourse = await j("/api/courses/itelect4");
  check("GET /api/courses/itelect4 finds it in lower case",
    oneCourse.status === 200 && oneCourse.body?.code === "ITELECT4",
    `${oneCourse.status} ${JSON.stringify(oneCourse.body)}`);
  check("one course comes back as an object, not an array of one",
    !Array.isArray(oneCourse.body) && oneCourse.body?.title === "IT Elective 4");

  const noCourse = await j("/api/courses/TEST");
  check("an unknown code answers 404, not an empty array",
    noCourse.status === 404);
  check("the 404 quotes the code back",
    typeof noCourse.body?.message === "string"
      && noCourse.body.message.includes("TEST"),
    noCourse.body?.message);

  // ---- card: CORS, allowed and not
  const allowedOrigin = (process.env.CORS_ORIGIN ?? "").split(",")[0].trim();
  const corsOk = await fetch(base + "/api/courses", {
    headers: { Origin: allowedOrigin },
  });
  check("an allowed origin is echoed back in the CORS header",
    corsOk.headers.get("access-control-allow-origin") === allowedOrigin,
    String(corsOk.headers.get("access-control-allow-origin")));

  const corsNo = await fetch(base + "/api/courses", {
    headers: { Origin: "https://not-your-app.example.com" },
  });
  check("an origin that is not on the list gets no CORS header",
    corsNo.headers.get("access-control-allow-origin") === null,
    String(corsNo.headers.get("access-control-allow-origin")));
  check("and the reply itself is still 200 -- the browser is what blocks it",
    corsNo.status === 200);

  // ---- card: register
  const reg = await j("/api/auth/register", {
    method: "POST",
    headers: JSONH,
    body: JSON.stringify({
      name: "Juan Dela Cruz",
      email: `juan-${uniq}@dlsl.edu.ph`,
      password: "password123",
    }),
  });
  check("register answers 201", reg.status === 201, `got ${reg.status}`);
  check("register returns id, not _id", !!reg.body?.id && !reg.body?._id);
  check("register never returns the password", !("password" in (reg.body ?? {})));
  check("role defaults to student", reg.body?.role === "student");

  const dupe = await j("/api/auth/register", {
    method: "POST",
    headers: JSONH,
    body: JSON.stringify({
      name: "Someone Else",
      email: `juan-${uniq}@dlsl.edu.ph`,
      password: "password123",
    }),
  });
  check("registering the same email twice answers 409", dupe.status === 409,
    `got ${dupe.status}`);

  // ---- card: login
  const login = await j("/api/auth/login", {
    method: "POST",
    headers: JSONH,
    body: JSON.stringify({ email: `juan-${uniq}@dlsl.edu.ph`, password: "password123" }),
  });
  check("login answers 200 with a token", login.status === 200 && !!login.body?.token);
  const token: string = login.body?.token ?? "";
  check(
    "the token carries the user id",
    (jwt.decode(token) as any)?.userId === reg.body?.id,
  );

  const wrong = await j("/api/auth/login", {
    method: "POST",
    headers: JSONH,
    body: JSON.stringify({ email: `juan-${uniq}@dlsl.edu.ph`, password: "WRONG" }),
  });
  check("a wrong password answers 401", wrong.status === 401);
  check(
    "the 401 does not say which half was wrong",
    /Email or password is incorrect/.test(wrong.body?.message ?? ""),
  );

  // ---- card: the guard
  const noTok = await j("/api/submissions");
  check("no token answers 401", noTok.status === 401);
  check("the no-token message names the header to send",
    noTok.body?.message === "No token. Send Authorization: Bearer <token>",
    JSON.stringify(noTok.body));
  const badTok = await j("/api/submissions", { headers: auth("not-a-token") });
  check("a garbage token answers 401", badTok.status === 401);
  check("a bad token gets the OTHER message, from the catch",
    badTok.body?.message === "Token is invalid or has expired",
    JSON.stringify(badTok.body));
  const tamper = token.slice(0, 30) + (token[30] === "x" ? "y" : "x") + token.slice(31);
  const tampered401 = await j("/api/submissions", { headers: auth(tamper) });
  check("one changed character in the token is refused", tampered401.status === 401);
  const expTok = jwt.sign({ userId: reg.body?.id }, process.env.JWT_SECRET!, {
    expiresIn: "-1s",
  });
  check(
    "an expired token answers 401",
    (await j("/api/submissions", { headers: auth(expTok) })).status === 401,
  );

  // ---- card: Putting rows in
  // The three bodies printed on that page, sent exactly as they are shown,
  // so the console cannot claim a reply the app does not give.
  const SEED = [
    { courseCode: "itelect4",
      repoUrl: "https://github.com/jdelacruz/itelect4-project",
      submittedAt: "2026-08-15T09:00:00.000Z", score: 92 },
    { courseCode: "ITELECT2",
      repoUrl: "https://github.com/jdelacruz/task-manager-api",
      submittedAt: "2026-08-22T14:30:00.000Z", score: 78 },
    { courseCode: " it3d ",
      repoUrl: "https://github.com/jdelacruz/rpa-invoice-bot",
      submittedAt: "2026-09-05T11:15:00.000Z" },
  ];
  const seeded = [];
  for (const body of SEED) {
    seeded.push(await j("/api/submissions", {
      method: "POST", headers: { ...JSONH, ...auth(token) },
      body: JSON.stringify(body),
    }));
  }
  check("all three seed rows answer 201",
    seeded.every((r) => r.status === 201),
    seeded.map((r) => r.status).join(","));
  check("every seed reply has an id nobody sent",
    seeded.every((r) => typeof r.body?.id === "string" && r.body.id.length === 24));
  check("\"itelect4\" is stored as ITELECT4", seeded[0].body?.courseCode === "ITELECT4");
  check("\" it3d \" is trimmed AND raised to IT3D", seeded[2].body?.courseCode === "IT3D",
    JSON.stringify(seeded[2].body?.courseCode));
  check("a submittedAt sent by the client is kept, not overwritten",
    String(seeded[0].body?.submittedAt).startsWith("2026-08-15"),
    String(seeded[0].body?.submittedAt));
  check("a score sent by the client is kept -- Pick does not filter the body",
    seeded[1].body?.score === 78, String(seeded[1].body?.score));
  check("score is optional", seeded[2].body?.score === undefined);

  const over = await j("/api/submissions", {
    method: "POST", headers: { ...JSONH, ...auth(token) },
    body: JSON.stringify({ courseCode: "X",
      repoUrl: "https://github.com/a/b", score: 150 }),
  });
  check("score 150 is refused", over.status === 400, `got ${over.status}`);
  check("and the message names the maximum",
    JSON.stringify(over.body).includes("maximum allowed value (100)"),
    JSON.stringify(over.body));

  const listed = await j("/api/submissions", { headers: auth(token) });
  check("the list comes back newest first",
    JSON.stringify((listed.body ?? []).slice(0, 3).map((r: any) => r.courseCode))
      === JSON.stringify(["IT3D", "ITELECT2", "ITELECT4"]),
    JSON.stringify((listed.body ?? []).map((r: any) => r.courseCode)));

  // ---- card: create
  const made = await j("/api/submissions", {
    method: "POST",
    headers: { ...JSONH, ...auth(token) },
    body: JSON.stringify({
      courseCode: "itelect4",
      repoUrl: "https://github.com/juan/itelect4-backend",
    }),
  });
  check("POST answers 201", made.status === 201, `got ${made.status}`);
  check("courseCode came back upper-cased", made.body?.courseCode === "ITELECT4");
  check(
    "studentId was taken from the token, not the body",
    String(made.body?.studentId) === String(reg.body?.id),
  );
  check("submittedAt came back although it was never sent",
    typeof made.body?.submittedAt === "string" && !Number.isNaN(Date.parse(made.body.submittedAt)));
  check("the created row has no _id and no __v",
    !("_id" in (made.body ?? {})) && !("__v" in (made.body ?? {})));
  check("its id is 24 hex characters", /^[a-f0-9]{24}$/.test(made.body?.id ?? ""));
  const subId: string = made.body?.id ?? "";

  // the body deliberately lies about its owner; the server must ignore it
  const lied = await j("/api/submissions", {
    method: "POST",
    headers: { ...JSONH, ...auth(token) },
    body: JSON.stringify({
      courseCode: "CSSWENG",
      repoUrl: "https://github.com/juan/other",
      studentId: new Types.ObjectId().toString(),
    }),
  });
  check(
    "a studentId in the body is ignored",
    String(lied.body?.studentId) === String(reg.body?.id),
  );

  // ---- card: the server rule that the browser cannot be trusted with
  const badUrl = await j("/api/submissions", {
    method: "POST",
    headers: { ...JSONH, ...auth(token) },
    body: JSON.stringify({ courseCode: "ITELECT4", repoUrl: "http://gitlab.com/x/y" }),
  });
  check("a non-github repoUrl answers 400", badUrl.status === 400, `got ${badUrl.status}`);
  check(
    "the 400 repeats the schema's own message",
    JSON.stringify(badUrl.body ?? {}).includes("github.com"),
  );

  const missing = await j("/api/submissions", {
    method: "POST",
    headers: { ...JSONH, ...auth(token) },
    body: JSON.stringify({ repoUrl: "https://github.com/a/b" }),
  });
  check("a missing courseCode answers 400", missing.status === 400);

  // ---- card: express.json() only parses when the header says JSON
  const noType = await j("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "a@b.c", password: "x" }),
  });
  check(
    "a body with no Content-Type is not parsed, and the app survives it",
    noType.status === 500,
    `got ${noType.status} -- expected the error handler to catch it`,
  );

  // ---- card: read back
  const list = await j("/api/submissions", { headers: auth(token) });
  check("GET returns this user's rows", list.status === 200 && Array.isArray(list.body));
  check("the rows created on this run are all there",
    (list.body ?? []).length === 5,
    `${(list.body ?? []).length} rows -- 3 seed + 2 from the create card`);

  const one = await j(`/api/submissions/${subId}`, { headers: auth(token) });
  check("GET by id returns the row", one.status === 200 && one.body?.id === subId);

  const notMine = jwt.sign(
    { userId: new Types.ObjectId().toString() },
    process.env.JWT_SECRET!,
    { expiresIn: "2h" },
  );
  const stolen = await j(`/api/submissions/${subId}`, { headers: auth(notMine) });
  check(
    "someone else's token gets 404, not the row",
    stolen.status === 404,
    `got ${stolen.status}`,
  );

  const junkId = await j("/api/submissions/hello", { headers: auth(token) });
  check("a malformed id answers 400", junkId.status === 400, `got ${junkId.status}`);
  check("the 400 quotes the offending text back",
    junkId.body?.message === '"hello" is not a valid id', JSON.stringify(junkId.body));

  // ---- card: update
  const patched = await j(`/api/submissions/${subId}`, {
    method: "PATCH",
    headers: { ...JSONH, ...auth(token) },
    body: JSON.stringify({ courseCode: "csswENG" }),
  });
  check("PATCH answers 200 with the NEW value", patched.body?.courseCode === "CSSWENG");

  const patchBad = await j(`/api/submissions/${subId}`, {
    method: "PATCH",
    headers: { ...JSONH, ...auth(token) },
    body: JSON.stringify({ repoUrl: "http://gitlab.com/nope" }),
  });
  check(
    "PATCH runs the schema rules too",
    patchBad.status === 400,
    `got ${patchBad.status} -- runValidators may be missing`,
  );

  // ---- card: delete
  const del = await j(`/api/submissions/${subId}`, {
    method: "DELETE",
    headers: auth(token),
  });
  check("DELETE answers 204 with no body", del.status === 204 && !del.body);
  const gone = await j(`/api/submissions/${subId}`, { headers: auth(token) });
  check("the row is gone afterwards", gone.status === 404);

  // ---- card: unknown route
  const nope = await j("/api/nope");
  check("an unknown path answers JSON 404", nope.status === 404 && !!nope.body?.message);
  check("the 404 names the method and the path",
    nope.body?.message === "No route for GET /api/nope", JSON.stringify(nope.body));
  const listNoId = await j("/api/submissions", { headers: auth(token) });
  check("no row in a list reply has _id",
    (listNoId.body ?? []).every((r: any) => !("_id" in r) && "id" in r));
}

// ------------------------------------------------------------------- run
async function main() {
  await offlineUnits();
  deploymentShape();

  if (LIVE) {
    if (!process.env.MONGODB_URI) {
      console.log("\n--db was passed but MONGODB_URI is empty. Fill in .env first.");
      process.exit(1);
    }
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("connected:", mongoose.connection.name);
  } else {
    stubModels();
  }

  const server: Server = await new Promise((res) => {
    const s = app.listen(0, () => res(s));
  });
  const port = (server.address() as { port: number }).port;

  try {
    await httpSuite(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    if (LIVE) {
      await Submission.deleteMany({
        courseCode: { $in: ["ITELECT4", "ITELECT2", "IT3D", "CSSWENG", "X"] },
      });
      await mongoose.disconnect();
    }
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    fails.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
}

main();
